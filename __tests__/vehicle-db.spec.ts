import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { VehicleDb } from '../src/vehicle-db';

function tmpDb(): { db: VehicleDb; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluelinky-test-'));
  const dbPath = path.join(dir, 'test.db');
  const db = new VehicleDb(dbPath);
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true });
    },
  };
}

describe('VehicleDb', () => {
  it('initialises without error', () => {
    const { db, cleanup } = tmpDb();
    expect(db).toBeDefined();
    cleanup();
  });

  it('inserts and retrieves a check', () => {
    const { db, cleanup } = tmpDb();

    const id = db.insertCheck({
      ts: '2026-04-15T12:00:00Z',
      vehicle_name: 'Test Vehicle',
      range_mi: 200,
      temp_f: 55.5,
      is_fillup: 0,
      odometer_mi: null,
      car_reported_at: null,
    });

    expect(id).toBeGreaterThan(0);

    const last = db.getLastCheck();
    expect(last).not.toBeNull();
    expect(last!.range_mi).toBe(200);
    expect(last!.vehicle_name).toBe('Test Vehicle');
    expect(last!.is_fillup).toBe(0);

    cleanup();
  });

  it('inserts a fill-up check with odometer', () => {
    const { db, cleanup } = tmpDb();

    db.insertCheck({
      ts: '2026-04-15T12:00:00Z',
      vehicle_name: 'Test Vehicle',
      range_mi: 380,
      temp_f: 60,
      is_fillup: 1,
      odometer_mi: 42000,
      car_reported_at: null,
    });

    const last = db.getLastCheck();
    expect(last!.is_fillup).toBe(1);
    expect(last!.odometer_mi).toBe(42000);
    cleanup();
  });

  it('inserts and retrieves a TPMS reading', () => {
    const { db, cleanup } = tmpDb();

    const checkId = db.insertCheck({
      ts: '2026-04-15T12:00:00Z',
      vehicle_name: 'Test Vehicle',
      range_mi: 200,
      temp_f: null,
      is_fillup: 0,
      odometer_mi: null,
      car_reported_at: null,
    });

    db.insertTpms({
      check_id: checkId,
      ts: '2026-04-15T12:00:00Z',
      front_left: 1,
      front_right: 0,
      rear_left: 0,
      rear_right: 0,
      all_lamps: 0,
    });

    const last = db.getLastTpms();
    expect(last).not.toBeNull();
    expect(last!.front_left).toBe(1);
    expect(last!.front_right).toBe(0);
    expect(last!.check_id).toBe(checkId);

    cleanup();
  });

  it('inserts an alert', () => {
    const { db, cleanup } = tmpDb();

    db.insertAlert({
      ts: '2026-04-15T12:00:00Z',
      alert_type: 'tpms_warn',
      details: JSON.stringify({ wheels: ['frontLeft'] }),
    });

    // No crash = pass; we don't expose a getter for alerts in the public API
    cleanup();
  });

  it('returns null from getLastCheck when no data', () => {
    const { db, cleanup } = tmpDb();
    expect(db.getLastCheck()).toBeNull();
    cleanup();
  });

  it('returns null from getLastTpms when no data', () => {
    const { db, cleanup } = tmpDb();
    expect(db.getLastTpms()).toBeNull();
    cleanup();
  });

  it('getLastCheck returns the most recent row', () => {
    const { db, cleanup } = tmpDb();

    db.insertCheck({
      ts: '2026-04-15T10:00:00Z',
      vehicle_name: 'Test Vehicle',
      range_mi: 300,
      temp_f: null,
      is_fillup: 0,
      odometer_mi: null,
      car_reported_at: null,
    });
    db.insertCheck({
      ts: '2026-04-15T11:00:00Z',
      vehicle_name: 'Test Vehicle',
      range_mi: 290,
      temp_f: null,
      is_fillup: 0,
      odometer_mi: null,
      car_reported_at: null,
    });

    const last = db.getLastCheck();
    expect(last!.range_mi).toBe(290);

    cleanup();
  });

  it('round-trips the time the CAR reported, distinct from the check time', () => {
    const { db, cleanup } = tmpDb();

    // Deliberately far apart: the whole point of the column is that these two
    // are different questions. A row where they coincide cannot tell a
    // correct mapping from `reported_at = ts`.
    db.insertCheck({
      ts: '2026-09-22T18:00:09.885Z',
      vehicle_name: '2020 SANTA FE',
      range_mi: 88,
      temp_f: 63.7,
      is_fillup: 0,
      odometer_mi: null,
      car_reported_at: '2026-09-19T11:04:00.000Z',
    });

    const last = db.getLastCheck();
    expect(last!.car_reported_at).toBe('2026-09-19T11:04:00.000Z');
    expect(last!.ts).toBe('2026-09-22T18:00:09.885Z');
    cleanup();
  });

  it('stores null when the car never said when it last reported', () => {
    const { db, cleanup } = tmpDb();
    db.insertCheck({
      ts: '2026-09-22T18:00:09.885Z',
      vehicle_name: '2020 SANTA FE',
      range_mi: 88,
      temp_f: null,
      is_fillup: 0,
      odometer_mi: null,
      car_reported_at: null,
    });
    expect(db.getLastCheck()!.car_reported_at).toBeNull();
    cleanup();
  });
});

/**
 * The live database on plexpi held 3787 `checks` rows before this column
 * existed. `CREATE TABLE IF NOT EXISTS` is a no-op against a table that is
 * already there, so the schema string alone cannot add a column -- it would
 * silently leave production on the old shape while every test here passed
 * against a table created fresh.
 */
describe('VehicleDb migration onto a pre-existing checks table', () => {
  function legacyDb(): { dbPath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluelinky-legacy-'));
    const dbPath = path.join(dir, 'legacy.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE checks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          TEXT    NOT NULL,
        vehicle_name TEXT   NOT NULL,
        range_mi    REAL    NOT NULL,
        temp_f      REAL,
        is_fillup   INTEGER NOT NULL DEFAULT 0,
        odometer_mi REAL
      );
    `);
    raw
      .prepare(
        'INSERT INTO checks (ts, vehicle_name, range_mi, temp_f, is_fillup, odometer_mi)' +
          " VALUES ('2026-09-22T16:00:10.407Z', '2020 SANTA FE', 91, 60.7, 0, NULL)"
      )
      .run();
    raw.close();
    return { dbPath, cleanup: () => fs.rmSync(dir, { recursive: true }) };
  }

  it('control: the legacy table really lacks the column', () => {
    const { dbPath, cleanup } = legacyDb();
    const raw = new Database(dbPath);
    const columns = (raw.prepare('PRAGMA table_info(checks)').all() as { name: string }[]).map(
      c => c.name
    );
    raw.close();
    expect(columns).not.toContain('car_reported_at');
    cleanup();
  });

  it('adds the column and preserves the existing rows', () => {
    const { dbPath, cleanup } = legacyDb();

    const db = new VehicleDb(dbPath);
    const last = db.getLastCheck();

    expect(last).not.toBeNull();
    expect(last!.range_mi).toBe(91);
    // The pre-upgrade row has no car time and must not acquire a fabricated one.
    expect(last!.car_reported_at).toBeNull();

    db.insertCheck({
      ts: '2026-09-22T19:00:00.000Z',
      vehicle_name: '2020 SANTA FE',
      range_mi: 85,
      temp_f: 61,
      is_fillup: 0,
      odometer_mi: null,
      car_reported_at: '2026-09-22T18:41:00.000Z',
    });
    expect(db.getLastCheck()!.car_reported_at).toBe('2026-09-22T18:41:00.000Z');

    db.close();
    cleanup();
  });

  it('is idempotent -- a second open does not throw a duplicate-column error', () => {
    const { dbPath, cleanup } = legacyDb();
    const first = new VehicleDb(dbPath);
    first.close();
    expect(() => {
      const second = new VehicleDb(dbPath);
      second.close();
    }).not.toThrow();
    cleanup();
  });
});

describe('the migration narrows what it forgives', () => {
  it('re-raises an ALTER TABLE failure that is not a lost race', () => {
    // The `catch` in `addColumnIfMissing` exists only for the one benign
    // outcome -- two writers racing, the loser finding the column already
    // there. A bare `catch {}` would look identical and would swallow a real
    // structural problem, leaving a database that silently never migrates.
    //
    // A view is the cheapest thing that fails for a DIFFERENT reason:
    // `PRAGMA table_info` reports its columns, so the missing-column branch is
    // taken, and the ALTER then fails with "Cannot add a column to a view".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluelinky-view-'));
    const dbPath = path.join(dir, 'view.db');
    const raw = new Database(dbPath);
    raw.exec('CREATE TABLE real_checks (id INTEGER PRIMARY KEY, ts TEXT)');
    raw.exec('CREATE VIEW checks AS SELECT id, ts FROM real_checks');
    raw.close();

    expect(() => new VehicleDb(dbPath)).toThrow(/Cannot add a column to a view/);

    fs.rmSync(dir, { recursive: true });
  });
});
