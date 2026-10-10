import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { VehicleDb, batteryPctOrNull } from '../src/vehicle-db';

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
      battery_12v_pct: null,
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
      battery_12v_pct: null,
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
      battery_12v_pct: null,
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
      battery_12v_pct: null,
    });
    db.insertCheck({
      ts: '2026-04-15T11:00:00Z',
      vehicle_name: 'Test Vehicle',
      range_mi: 290,
      temp_f: null,
      is_fillup: 0,
      odometer_mi: null,
      car_reported_at: null,
      battery_12v_pct: null,
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
      battery_12v_pct: null,
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
      battery_12v_pct: null,
    });
    expect(db.getLastCheck()!.car_reported_at).toBeNull();
    cleanup();
  });

  it('round-trips the 12V battery percentage, including a reported 0', () => {
    const { db, cleanup } = tmpDb();

    db.insertCheck({
      ts: '2026-10-07T21:24:54.000Z',
      vehicle_name: '2020 SANTA FE',
      range_mi: 236,
      temp_f: null,
      is_fillup: 0,
      odometer_mi: null,
      car_reported_at: '2026-10-07T21:24:54.000Z',
      battery_12v_pct: 84,
    });
    expect(db.getLastCheck()!.battery_12v_pct).toBe(84);

    db.insertCheck({
      ts: '2026-10-07T22:24:54.000Z',
      vehicle_name: '2020 SANTA FE',
      range_mi: 236,
      temp_f: null,
      is_fillup: 0,
      odometer_mi: null,
      car_reported_at: '2026-10-07T22:24:54.000Z',
      // 0, not null: this must come back as 0. A column the insert statement
      // forgot would come back NULL here and the 84 above would still pass.
      battery_12v_pct: 0,
    });
    expect(db.getLastCheck()!.battery_12v_pct).toBe(0);

    cleanup();
  });

  it('stores null when the car reported no 12V battery value', () => {
    const { db, cleanup } = tmpDb();
    db.insertCheck({
      ts: '2026-10-07T21:24:54.000Z',
      vehicle_name: '2020 SANTA FE',
      range_mi: 236,
      temp_f: null,
      is_fillup: 0,
      odometer_mi: null,
      car_reported_at: null,
      battery_12v_pct: null,
    });
    expect(db.getLastCheck()!.battery_12v_pct).toBeNull();
    cleanup();
  });
});

describe('batteryPctOrNull', () => {
  it('passes a finite number through, zero included', () => {
    expect(batteryPctOrNull(84)).toBe(84);
    expect(batteryPctOrNull(0)).toBe(0);
    expect(batteryPctOrNull(100)).toBe(100);
  });

  it('nulls the two absent spellings a SELECT * can produce', () => {
    // `null` is an explicit "the car said nothing"; `undefined` is a row written
    // before the column existed. The reader must not be able to tell them apart.
    expect(batteryPctOrNull(null)).toBeNull();
    expect(batteryPctOrNull(undefined)).toBeNull();
  });

  it('nulls a number that is not finite', () => {
    // `typeof NaN === 'number'`, so a typeof-only guard lets this through and
    // the writer then stores something SQLite reads back as NULL -- the two
    // sides of the round-trip disagreeing about what happened.
    expect(batteryPctOrNull(NaN)).toBeNull();
    expect(batteryPctOrNull(Infinity)).toBeNull();
    expect(batteryPctOrNull(-Infinity)).toBeNull();
  });

  it('nulls a value of any other type', () => {
    // SQLite's typing is dynamic, so an INTEGER column can hand back a string.
    expect(batteryPctOrNull('84')).toBeNull();
    expect(batteryPctOrNull(true)).toBeNull();
    expect(batteryPctOrNull({ batSoc: 84 })).toBeNull();
    expect(batteryPctOrNull([84])).toBeNull();
  });

  it('does not range-check, because the hub is what owns that rule', () => {
    // `fuel.Reading` has the 0-100 CheckConstraint and the producer sanitises
    // out-of-range to None. Clamping here would make a bad reading look like a
    // good one by the time anything could notice.
    expect(batteryPctOrNull(140)).toBe(140);
    expect(batteryPctOrNull(-5)).toBe(-5);
  });
});

describe('getTpmsForCheck', () => {
  function twoChecksOneTpms(): {
    db: VehicleDb;
    older: number;
    newer: number;
    cleanup: () => void;
  } {
    const { db, cleanup } = tmpDb();
    const base = {
      vehicle_name: '2020 SANTA FE',
      range_mi: 88,
      temp_f: null,
      is_fillup: 0,
      odometer_mi: null,
      battery_12v_pct: null,
    };
    const older = db.insertCheck({
      ...base,
      ts: '2026-10-07T20:00:00.000Z',
      car_reported_at: '2026-10-07T19:00:00.000Z',
    });
    db.insertTpms({
      check_id: older,
      ts: '2026-10-07T20:00:00.000Z',
      front_left: 1,
      front_right: 0,
      rear_left: 0,
      rear_right: 0,
      all_lamps: 0,
    });
    const newer = db.insertCheck({
      ...base,
      ts: '2026-10-07T21:00:00.000Z',
      car_reported_at: '2026-10-07T20:00:00.000Z',
    });
    return { db, older, newer, cleanup };
  }

  it('returns the reading belonging to the check it was asked about', () => {
    const { db, older, cleanup } = twoChecksOneTpms();
    const reading = db.getTpmsForCheck(older);
    expect(reading).not.toBeNull();
    expect(reading!.check_id).toBe(older);
    expect(reading!.front_left).toBe(1);
    cleanup();
  });

  it('returns null for a check with no reading, where getLastTpms returns one', () => {
    // The two queries differ exactly here, and this is the pair of assertions
    // that proves the implementation is not `getLastTpms()` under another name.
    const { db, older, newer, cleanup } = twoChecksOneTpms();
    expect(db.getTpmsForCheck(newer)).toBeNull();
    expect(db.getLastTpms()!.check_id).toBe(older);
    cleanup();
  });

  it('returns null for a check id that does not exist', () => {
    const { db, cleanup } = twoChecksOneTpms();
    expect(db.getTpmsForCheck(99999)).toBeNull();
    cleanup();
  });
});

describe('insertCheckWithTpms', () => {
  const check = {
    ts: '2026-10-07T21:24:54.000Z',
    vehicle_name: '2020 SANTA FE',
    range_mi: 236,
    temp_f: 63.7,
    is_fillup: 0,
    odometer_mi: null,
    car_reported_at: '2026-10-07T21:24:54.000Z',
    battery_12v_pct: 84,
  };
  const lamps = {
    ts: '2026-10-07T21:24:54.000Z',
    front_left: 0,
    front_right: 0,
    rear_left: 1,
    rear_right: 0,
    all_lamps: 0,
  };

  it('writes both rows and links them', () => {
    const { db, cleanup } = tmpDb();
    const checkId = db.insertCheckWithTpms(check, lamps);

    expect(db.getLastCheck()!.id).toBe(checkId);
    const reading = db.getTpmsForCheck(checkId);
    expect(reading!.check_id).toBe(checkId);
    expect(reading!.rear_left).toBe(1);

    cleanup();
  });

  it('rolls the check back when the TPMS insert fails', () => {
    // A REAL statement failure, not a monkeypatched throw: `front_left` is
    // `INTEGER NOT NULL`, so SQLite raises inside the transaction AFTER the
    // check row has been inserted. A thrown mock would fire before any
    // statement ran, and the test would pass with no transaction at all.
    const { db, cleanup } = tmpDb();

    expect(() =>
      db.insertCheckWithTpms(check, {
        ...lamps,
        front_left: null as unknown as number,
      })
    ).toThrow(/NOT NULL/);

    // The whole point: no orphan check row survives the failure.
    expect(db.getLastCheck()).toBeNull();
    expect(db.getLastTpms()).toBeNull();

    cleanup();
  });

  it('control: the same check row inserts fine on its own', () => {
    // Without this, the assertion above passes just as well against a check row
    // that was never insertable -- which would make the rollback claim vacuous.
    const { db, cleanup } = tmpDb();
    expect(db.insertCheck(check)).toBeGreaterThan(0);
    expect(db.getLastCheck()).not.toBeNull();
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
    expect(columns).not.toContain('battery_12v_pct');
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
      battery_12v_pct: 84,
    });
    expect(db.getLastCheck()!.car_reported_at).toBe('2026-09-22T18:41:00.000Z');
    // Both columns, not whichever one `addColumnIfMissing` reached first.
    expect(db.getLastCheck()!.battery_12v_pct).toBe(84);

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

/**
 * Production's shape **today**, which is not the legacy shape above.
 *
 * plexpi's `vehicle-monitor.db` has already been through the `car_reported_at`
 * migration, so the database the battery migration will actually meet has seven
 * columns, not six. A fixture that lacks both columns cannot tell "adds the
 * battery column" from "adds whichever column is missing first" — and
 * `addColumnIfMissing` returns early on the first match, so a loop that checked
 * one column and stopped would pass against the legacy fixture and leave
 * production unmigrated.
 */
describe('VehicleDb migration onto a table that already has car_reported_at', () => {
  function currentShapeDb(): { dbPath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluelinky-current-'));
    const dbPath = path.join(dir, 'current.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE checks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          TEXT    NOT NULL,
        vehicle_name TEXT   NOT NULL,
        range_mi    REAL    NOT NULL,
        temp_f      REAL,
        is_fillup   INTEGER NOT NULL DEFAULT 0,
        odometer_mi REAL,
        car_reported_at TEXT
      );
    `);
    raw
      .prepare(
        'INSERT INTO checks (ts, vehicle_name, range_mi, temp_f, is_fillup, odometer_mi,' +
          " car_reported_at) VALUES ('2026-10-07T20:00:10.407Z', '2020 SANTA FE', 236, 60.7, 0," +
          " NULL, '2026-10-07T19:24:54.000Z')"
      )
      .run();
    raw.close();
    return { dbPath, cleanup: () => fs.rmSync(dir, { recursive: true }) };
  }

  it('control: the fixture has car_reported_at and lacks battery_12v_pct', () => {
    const { dbPath, cleanup } = currentShapeDb();
    const raw = new Database(dbPath);
    const columns = (raw.prepare('PRAGMA table_info(checks)').all() as { name: string }[]).map(
      c => c.name
    );
    raw.close();
    expect(columns).toContain('car_reported_at');
    expect(columns).not.toContain('battery_12v_pct');
    cleanup();
  });

  it('adds the battery column and preserves the existing row', () => {
    const { dbPath, cleanup } = currentShapeDb();

    const db = new VehicleDb(dbPath);
    const last = db.getLastCheck();

    expect(last).not.toBeNull();
    expect(last!.range_mi).toBe(236);
    // The pre-upgrade row's car time survives, and its battery is absent rather
    // than fabricated. `== null` not `=== null`: `SELECT *` on a freshly ALTERed
    // column gives null, but the distinction is the one the reader relies on.
    expect(last!.car_reported_at).toBe('2026-10-07T19:24:54.000Z');
    expect(last!.battery_12v_pct == null).toBe(true);

    db.insertCheck({
      ts: '2026-10-07T21:00:00.000Z',
      vehicle_name: '2020 SANTA FE',
      range_mi: 230,
      temp_f: 61,
      is_fillup: 0,
      odometer_mi: null,
      car_reported_at: '2026-10-07T20:24:54.000Z',
      battery_12v_pct: 84,
    });
    expect(db.getLastCheck()!.battery_12v_pct).toBe(84);

    db.close();
    cleanup();
  });

  it('is idempotent -- a second open does not throw a duplicate-column error', () => {
    const { dbPath, cleanup } = currentShapeDb();
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
