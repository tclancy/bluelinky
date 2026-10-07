import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { CheckRow, TpmsRow, VehicleDb } from '../src/vehicle-db';
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
    battery_12v_pct: 84,
    ...overrides,
  };
}

/**
 * The TPMS row belonging to the check above, with ONE lamp lit.
 *
 * Not all-off and not all-on: a fixture whose five booleans are identical
 * cannot tell a correct per-wheel mapping from a transposed one, and the
 * document's whole job is to say *which* wheel.
 */
function tpms(overrides: Partial<TpmsRow> = {}): TpmsRow {
  return {
    id: 3787,
    check_id: 3787,
    ts: '2026-09-22T18:00:09.885Z',
    front_left: 1,
    front_right: 0,
    rear_left: 0,
    rear_right: 0,
    all_lamps: 0,
    ...overrides,
  };
}

/**
 * A row as `SELECT *` returns it from a database written before the battery
 * column existed: the key is **absent**, which reads as `undefined` and not as
 * `null`. That distinction is why `buildStatusDocument` cannot use `!== null`.
 */
function preMigrationRow(): CheckRow {
  const legacy = row();
  delete (legacy as Partial<CheckRow>).battery_12v_pct;
  return legacy;
}

describe('buildStatusDocument', () => {
  it('emits the three fields the fuel producer requires, and only those, from a bare row', () => {
    expect(buildStatusDocument(preMigrationRow(), null)).toEqual({
      vehicle: '2020 SANTA FE',
      range_miles: 88,
      reported_at: '2026-09-19T11:04:00.000Z',
    });
  });

  it('reports the CAR time, never the check time', () => {
    const document = buildStatusDocument(row(), tpms());
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

  it('emits exactly the required keys plus the two optional ones, for a full row', () => {
    // An exact key SET, not a subset check. The previous version of this
    // assertion stayed green through the whole battery/TPMS addition only
    // because its fixture lacked the new column -- a test that pins "nothing
    // else" against a fixture that cannot produce anything else is pinning the
    // fixture, not the document.
    expect(Object.keys(buildStatusDocument(row(), tpms())!).sort()).toEqual(
      [...REQUIRED_STATUS_FIELDS, 'battery_12v_percent', 'tire_pressure_warning'].sort()
    );
  });

  it('emits exactly the required keys and nothing else, for a pre-migration row', () => {
    // The 3787 production rows written before either field existed. This is
    // the assertion that makes the boundary either-order: an old row must still
    // produce a document an old producer can read, with no key it would have to
    // ignore and no key invented to fill a gap.
    expect(Object.keys(buildStatusDocument(preMigrationRow(), null)!).sort()).toEqual(
      [...REQUIRED_STATUS_FIELDS].sort()
    );
  });

  it('control: the pre-migration fixture really lacks the battery column', () => {
    // Without this, the test above passes just as well against a fixture that
    // has the column -- and would then be asserting the opposite of its name.
    expect('battery_12v_pct' in preMigrationRow()).toBe(false);
    expect('battery_12v_pct' in row()).toBe(true);
  });

  it('omits the battery key independently of the TPMS key, and vice versa', () => {
    // Two separate sources of absence, so two separate omissions. One guard
    // covering both would make a car with a battery reading and a failed TPMS
    // insert publish neither.
    expect(Object.keys(buildStatusDocument(row(), null)!).sort()).toEqual(
      [...REQUIRED_STATUS_FIELDS, 'battery_12v_percent'].sort()
    );
    expect(Object.keys(buildStatusDocument(preMigrationRow(), tpms())!).sort()).toEqual(
      [...REQUIRED_STATUS_FIELDS, 'tire_pressure_warning'].sort()
    );
  });

  it('reports the battery percentage the row carries', () => {
    expect(buildStatusDocument(row(), tpms())!.battery_12v_percent).toBe(84);
  });

  it('emits a reported 0 rather than omitting it', () => {
    // A flat 12V battery is the single most worth-reporting value this field
    // ever carries, and it is the one a truthiness guard drops.
    const document = buildStatusDocument(row({ battery_12v_pct: 0 }), tpms())!;
    expect(document.battery_12v_percent).toBe(0);
    expect('battery_12v_percent' in document).toBe(true);
  });

  it('omits the battery key for an explicit null and for an absent column alike', () => {
    expect(
      'battery_12v_percent' in buildStatusDocument(row({ battery_12v_pct: null }), null)!
    ).toBe(false);
    expect('battery_12v_percent' in buildStatusDocument(preMigrationRow(), null)!).toBe(false);
  });

  it('maps each wheel lamp to its own key rather than transposing them', () => {
    // The fixture lights ONE lamp. An all-off or all-on fixture would pass
    // under any permutation of the five assignments.
    expect(buildStatusDocument(row(), tpms())!.tire_pressure_warning).toEqual({
      front_left: true,
      front_right: false,
      rear_left: false,
      rear_right: false,
      all: false,
    });
    expect(
      buildStatusDocument(row(), tpms({ front_left: 0, rear_right: 1 }))!.tire_pressure_warning
    ).toEqual({
      front_left: false,
      front_right: false,
      rear_left: false,
      rear_right: true,
      all: false,
    });
  });

  it('emits booleans, not the 0/1 integers the column stores', () => {
    // `core/validation.py` on the hub side 400s a non-bool, and `producer`
    // sanitises one to None -- so a 1 here costs the tire reading silently.
    const warning = buildStatusDocument(row(), tpms())!.tire_pressure_warning!;
    for (const value of Object.values(warning)) {
      expect(typeof value).toBe('boolean');
    }
    expect(Object.keys(warning).sort()).toEqual(
      ['all', 'front_left', 'front_right', 'rear_left', 'rear_right'].sort()
    );
  });

  it('carries the dash master lamp separately from the four wheels', () => {
    expect(buildStatusDocument(row(), tpms({ all_lamps: 1 }))!.tire_pressure_warning).toEqual({
      front_left: true,
      front_right: false,
      rear_left: false,
      rear_right: false,
      all: true,
    });
  });

  it('returns null when there is no history at all', () => {
    expect(buildStatusDocument(null, null)).toBeNull();
  });

  it('returns null rather than falling back to the check time', () => {
    // Every one of the 3787 pre-upgrade rows has a null car time. Falling back
    // to `ts` would make a car that has not phoned home in a week render as a
    // fresh reading -- the failure this whole column exists to prevent.
    expect(buildStatusDocument(row({ car_reported_at: null }), tpms())).toBeNull();
  });

  it('returns null when the car time is blank rather than absent', () => {
    expect(buildStatusDocument(row({ car_reported_at: '' }), tpms())).toBeNull();
  });

  it('passes a fractional range through as a number', () => {
    // The column is REAL and the hub coerces with round(); emitting a string
    // here would be a 400 naming a field that looks right in the log.
    const document = buildStatusDocument(row({ range_mi: 311.7 }), tpms());
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
      battery_12v_pct: null,
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

  it('takes the tire lamps from the same check as the range, not the newest TPMS row', () => {
    // The defect this pins: `getLastTpms()` and `getLastCheck()` are two
    // independent "newest" queries. Here the newest CHECK deliberately has NO
    // TPMS row, while an earlier check has one with a lamp lit. A document
    // built from `getLastTpms()` reports this poll's range beside the earlier
    // poll's tire state, and both halves look equally fresh.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluelinky-tpms-pairing-'));
    const dbPath = path.join(dir, 'vehicle-monitor.db');
    const db = new VehicleDb(dbPath);

    const older = db.insertCheck({
      ts: '2026-09-22T17:00:09.885Z',
      vehicle_name: '2020 SANTA FE',
      range_mi: 95,
      temp_f: 63.7,
      is_fillup: 0,
      odometer_mi: null,
      car_reported_at: '2026-09-19T10:04:00.000Z',
      battery_12v_pct: 81,
    });
    db.insertTpms({
      check_id: older,
      ts: '2026-09-22T17:00:09.885Z',
      front_left: 1,
      front_right: 1,
      rear_left: 1,
      rear_right: 1,
      all_lamps: 1,
    });
    db.insertCheck({
      ts: '2026-09-22T18:00:09.885Z',
      vehicle_name: '2020 SANTA FE',
      range_mi: 88,
      temp_f: 63.7,
      is_fillup: 0,
      odometer_mi: null,
      car_reported_at: '2026-09-19T11:04:00.000Z',
      battery_12v_pct: 84,
    });
    db.close();

    const report = statusReport(dbPath);
    const document = JSON.parse(report.stdout);

    // Control: we really are reading the newer check.
    expect(document.range_miles).toBe(88);
    expect(document.battery_12v_percent).toBe(84);
    // And it has no tire state, rather than borrowing the older check's.
    expect('tire_pressure_warning' in document).toBe(false);

    fs.rmSync(dir, { recursive: true });
  });

  it('still reports the range when tpms_readings does not exist at all', () => {
    // A database from before TPMS existed: `checks` has a usable row and the
    // other table is simply absent. Looking the TPMS row up unguarded throws
    // `no such table: tpms_readings` here, and that reached the outer handler
    // as `unreadable` -- turning a perfectly good range reading into what the
    // producer can only read as an unreachable car. One optional field must
    // never be able to cost the required ones.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluelinky-no-tpms-table-'));
    const dbPath = path.join(dir, 'vehicle-monitor.db');

    const raw = new Database(dbPath);
    raw.exec(
      'CREATE TABLE checks (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,' +
        ' vehicle_name TEXT NOT NULL, range_mi REAL NOT NULL, temp_f REAL,' +
        ' is_fillup INTEGER NOT NULL DEFAULT 0, odometer_mi REAL, car_reported_at TEXT)'
    );
    raw
      .prepare(
        'INSERT INTO checks (ts, vehicle_name, range_mi, temp_f, is_fillup, odometer_mi,' +
          " car_reported_at) VALUES ('2026-10-07T21:00:00.000Z', '2020 SANTA FE', 236, 60.7, 0," +
          " NULL, '2026-10-07T20:24:54.000Z')"
      )
      .run();
    raw.close();

    // Control: the table really is missing, so the assertion below is not
    // passing against a database that simply has an empty tpms_readings.
    const probe = new Database(dbPath, { readonly: true });
    const tables = (
      probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map(t => t.name);
    probe.close();
    expect(tables).not.toContain('tpms_readings');

    const report = statusReport(dbPath);

    expect(report.stderr).toBe('');
    expect(report.code).toBe(0);
    const document = JSON.parse(report.stdout);
    expect(document.range_miles).toBe(236);
    expect('tire_pressure_warning' in document).toBe(false);

    fs.rmSync(dir, { recursive: true });
  });

  it('emits both optional fields end to end for a check written with its TPMS row', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluelinky-full-'));
    const dbPath = path.join(dir, 'vehicle-monitor.db');
    const db = new VehicleDb(dbPath);

    // The writer's own path, so this asserts the round-trip rather than a
    // hand-built pair of rows the monitor would never produce.
    db.insertCheckWithTpms(
      {
        ts: '2026-09-22T18:00:09.885Z',
        vehicle_name: '2020 SANTA FE',
        range_mi: 236,
        temp_f: 63.7,
        is_fillup: 0,
        odometer_mi: null,
        car_reported_at: '2026-10-07T21:24:54.000Z',
        battery_12v_pct: 84,
      },
      {
        ts: '2026-09-22T18:00:09.885Z',
        front_left: 0,
        front_right: 0,
        rear_left: 1,
        rear_right: 0,
        all_lamps: 0,
      }
    );
    db.close();

    const report = statusReport(dbPath);

    expect(report.code).toBe(0);
    expect(report.stderr).toBe('');
    // The exact bytes the spec's D2 wire contract shows, as JSON.
    expect(JSON.parse(report.stdout)).toEqual({
      vehicle: '2020 SANTA FE',
      range_miles: 236,
      reported_at: '2026-10-07T21:24:54.000Z',
      battery_12v_percent: 84,
      tire_pressure_warning: {
        front_left: false,
        front_right: false,
        rear_left: true,
        rear_right: false,
        all: false,
      },
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
    expect(columns).not.toContain('battery_12v_pct');

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
      battery_12v_pct: null,
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
