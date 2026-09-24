import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { CheckRow, VehicleDb } from '../src/vehicle-db';
import {
  NO_USABLE_READING,
  REQUIRED_STATUS_FIELDS,
  buildStatusDocument,
  statusReport,
} from '../src/status-json';

/**
 * A row in the shape the live plexpi database actually stores, with the two
 * timestamps DELIBERATELY far apart. `ts` is when the monitor ran; the car
 * last spoke to Hyundai three days earlier. A fixture where the two coincide
 * cannot tell a correct mapping from `reported_at = ts`, which is the exact
 * defect this file exists to pin.
 */
function row(overrides: Partial<CheckRow> = {}): CheckRow {
  return {
    id: 3787,
    ts: '2026-09-22T18:00:09.885Z',
    vehicle_name: '2020 SANTA FE',
    range_mi: 88,
    temp_f: 63.7,
    is_fillup: 0,
    odometer_mi: null,
    car_reported_at: '2026-09-19T11:04:00.000Z',
    ...overrides,
  };
}

describe('buildStatusDocument', () => {
  it('emits the three fields the fuel producer requires', () => {
    expect(buildStatusDocument(row())).toEqual({
      vehicle: '2020 SANTA FE',
      range_miles: 88,
      reported_at: '2026-09-19T11:04:00.000Z',
    });
  });

  it('reports the CAR time, never the check time', () => {
    const document = buildStatusDocument(row());
    expect(document!.reported_at).toBe('2026-09-19T11:04:00.000Z');
    expect(document!.reported_at).not.toBe('2026-09-22T18:00:09.885Z');
  });

  it('names the contract fields parsons-pulse actually requires', () => {
    // Literals, not a reference. parsons-pulse `producer/fuel_level.py` has
    // REQUIRED_STATUS_FIELDS = ("vehicle", "range_miles", "reported_at") and
    // treats a missing one as an unreadable car -- so these three strings are
    // the external truth, and the only thing worth pinning. Comparing the
    // constant to the module that builds the document would pass under a
    // coordinated rename, which is precisely the silent outage.
    expect([...REQUIRED_STATUS_FIELDS]).toEqual(['vehicle', 'range_miles', 'reported_at']);
  });

  it('emits exactly those keys and nothing else', () => {
    expect(Object.keys(buildStatusDocument(row())!).sort()).toEqual(
      [...REQUIRED_STATUS_FIELDS].sort()
    );
  });

  it('returns null when there is no history at all', () => {
    expect(buildStatusDocument(null)).toBeNull();
  });

  it('returns null rather than falling back to the check time', () => {
    // Every one of the 3787 pre-upgrade rows has a null car time. Falling back
    // to `ts` would make a car that has not phoned home in a week render as a
    // fresh reading -- the failure this whole column exists to prevent.
    expect(buildStatusDocument(row({ car_reported_at: null }))).toBeNull();
  });

  it('returns null when the car time is blank rather than absent', () => {
    expect(buildStatusDocument(row({ car_reported_at: '' }))).toBeNull();
  });

  it('passes a fractional range through as a number', () => {
    // The column is REAL and the hub coerces with round(); emitting a string
    // here would be a 400 naming a field that looks right in the log.
    const document = buildStatusDocument(row({ range_mi: 311.7 }));
    expect(document!.range_miles).toBe(311.7);
    expect(typeof document!.range_miles).toBe('number');
  });
});

describe('statusReport', () => {
  it('reports a missing database in a sentence rather than a stack trace', () => {
    const report = statusReport(path.join(os.tmpdir(), 'bluelinky-absent', 'vehicle-monitor.db'));

    expect(report.code).toBe(1);
    expect(report.stdout).toBe('');
    // The producer reads stderr when a tick fails. A Node stack trace there is
    // unreadable and says nothing about which of the two causes it was.
    expect(report.stderr).toContain('cannot open');
    expect(report.stderr).toContain('state volume is not mounted');
    expect(report.stderr).not.toContain('at new Database');
  });

  it('emits the contract object on stdout and nothing on stderr', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluelinky-main-'));
    const dbPath = path.join(dir, 'vehicle-monitor.db');
    const db = new VehicleDb(dbPath);
    db.insertCheck({
      ts: '2026-09-22T18:00:09.885Z',
      vehicle_name: '2020 SANTA FE',
      range_mi: 88,
      temp_f: 63.7,
      is_fillup: 0,
      odometer_mi: null,
      car_reported_at: '2026-09-19T11:04:00.000Z',
    });
    db.close();

    const report = statusReport(dbPath);

    expect(report.code).toBe(0);
    expect(report.stderr).toBe('');
    // Parsed, because the producer parses it: a JSON.stringify that emitted a
    // trailing banner would still "contain" the right substring.
    expect(JSON.parse(report.stdout)).toEqual({
      vehicle: '2020 SANTA FE',
      range_miles: 88,
      reported_at: '2026-09-19T11:04:00.000Z',
    });

    fs.rmSync(dir, { recursive: true });
  });
});

describe('the reader never writes', () => {
  it('does not conjure a database that is not there', () => {
    // The directory exists and the file does not -- which is what an unmounted
    // state volume looks like from inside the container. A read-WRITE open
    // creates the file here, turning a deploy fault into an empty database
    // that reports "no readings yet" forever. Read-only cannot: it refuses.
    //
    // This is the assertion that catches it. Opening read-write is otherwise
    // invisible, because the schema init is skipped on a separate flag, so a
    // test that only checks "the file was not migrated" stays green.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluelinky-absent-file-'));
    const dbPath = path.join(dir, 'vehicle-monitor.db');
    expect(fs.existsSync(dbPath)).toBe(false);

    expect(statusReport(dbPath).code).toBe(1);

    expect(fs.existsSync(dbPath)).toBe(false);

    fs.rmSync(dir, { recursive: true });
  });

  it('leaves an unmigrated database unmigrated', () => {
    // The monitor owns this file and is writing to it on the hour. A reader
    // that opened read-write would migrate it as a side effect of being run --
    // and `FUEL_STATUS_COMMAND` runs on a timer, unattended, as whatever user
    // the producer happens to be. Read-only makes that impossible rather than
    // merely unintended.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluelinky-ro-'));
    const dbPath = path.join(dir, 'vehicle-monitor.db');

    const raw = new Database(dbPath);
    raw.exec(
      'CREATE TABLE checks (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,' +
        ' vehicle_name TEXT NOT NULL, range_mi REAL NOT NULL, temp_f REAL,' +
        ' is_fillup INTEGER NOT NULL DEFAULT 0, odometer_mi REAL)'
    );
    raw.close();

    const report = statusReport(dbPath);
    expect(report.code).toBe(1);
    // Both failure modes return 1, so the code alone cannot tell "read the
    // newest row and found no car time" from "could not open the file at all"
    // -- and this test is only meaningful if it is the former.
    expect(report.stderr).toBe(NO_USABLE_READING);

    const after = new Database(dbPath, { readonly: true });
    const columns = (after.prepare('PRAGMA table_info(checks)').all() as { name: string }[]).map(
      c => c.name
    );
    after.close();
    expect(columns).not.toContain('car_reported_at');

    fs.rmSync(dir, { recursive: true });
  });
});

describe('an unreadable database is a third cause, not a stack trace', () => {
  it('says so for a file that is not a database at all', () => {
    // The realistic Pi failure: an SD card truncates or corrupts the file.
    // better-sqlite3 OPENS it happily and throws at `prepare`, so the guard
    // around the open cannot see this one.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluelinky-corrupt-'));
    const dbPath = path.join(dir, 'vehicle-monitor.db');
    fs.writeFileSync(dbPath, 'this is not a database\n');

    const report = statusReport(dbPath);

    expect(report.code).toBe(1);
    expect(report.stdout).toBe('');
    expect(report.stderr).toContain('cannot read');
    expect(report.stderr).toContain('the monitor writes this database');
    expect(report.stderr).not.toContain('at Database.prepare');

    fs.rmSync(dir, { recursive: true });
  });

  it('says so for an empty file, which opens as a database with no tables', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluelinky-empty-'));
    const dbPath = path.join(dir, 'vehicle-monitor.db');
    fs.writeFileSync(dbPath, '');

    const report = statusReport(dbPath);

    expect(report.code).toBe(1);
    expect(report.stderr).toContain('cannot read');
    // Distinct from NO_USABLE_READING: there is no history here to be missing
    // a car time, so saying "wait for the next tick" would be wrong advice.
    expect(report.stderr).not.toBe(NO_USABLE_READING);

    fs.rmSync(dir, { recursive: true });
  });
});

describe('the reader and the writer resolve the same database', () => {
  it('honours VEHICLE_DB_PATH, which monitor.ts has always honoured', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluelinky-envpath-'));
    const dbPath = path.join(dir, 'elsewhere.db');
    const db = new VehicleDb(dbPath);
    db.insertCheck({
      ts: '2026-09-22T18:00:09.885Z',
      vehicle_name: '2020 SANTA FE',
      range_mi: 88,
      temp_f: null,
      is_fillup: 0,
      odometer_mi: null,
      car_reported_at: '2026-09-22T16:36:29.000Z',
    });
    db.close();

    const previous = process.env.VEHICLE_DB_PATH;
    process.env.VEHICLE_DB_PATH = dbPath;
    try {
      // No argument: this is the path production takes.
      const report = statusReport();
      expect(report.code).toBe(0);
      expect(JSON.parse(report.stdout).reported_at).toBe('2026-09-22T16:36:29.000Z');
    } finally {
      if (previous === undefined) {
        delete process.env.VEHICLE_DB_PATH;
      } else {
        process.env.VEHICLE_DB_PATH = previous;
      }
    }

    fs.rmSync(dir, { recursive: true });
  });
});
