/**
 * SQLite database for vehicle monitoring history.
 *
 * Three tables:
 *   checks        — one row per monitoring run (fuel range + fillup flag +
 *                   odometer + when the car itself last reported)
 *   tpms_readings — per-wheel lamp state per run
 *   alerts        — history of every alert sent
 *
 * The database lives in the state directory (Docker volume) alongside the
 * existing alert-state JSON file. Idempotent: safe to re-run initDb() on
 * every start — CREATE TABLE IF NOT EXISTS everywhere.
 */

import Database from 'better-sqlite3';
import * as path from 'path';

export interface CheckRow {
  id?: number;
  ts: string;
  vehicle_name: string;
  range_mi: number;
  temp_f: number | null;
  is_fillup: number; // 0 or 1
  odometer_mi: number | null;
  /**
   * When the CAR last reported to Hyundai, from `status.lastupdate`.
   *
   * Not the same question as `ts`, which is when *we* ran. A parked car keeps
   * answering with the reading it filed days ago, so a consumer that wants to
   * know whether the vehicle is still talking needs this and cannot derive it
   * from `ts`. Nullable because the API may omit it, and because every row
   * written before this column existed has nothing to put here.
   */
  car_reported_at: string | null;
  /**
   * The 12V starter battery's state of charge, 0-100, from `battery.batSoc`.
   *
   * Not the traction battery: this car is an ICE Santa Fe and `batSoc` is the
   * accessory battery the starter draws on. Nullable for the same two reasons
   * as `car_reported_at` — the API may omit it, and the 3787 rows written
   * before this column existed have nothing to put here.
   *
   * **Required rather than optional on purpose.** `Omit<CheckRow, 'id'>` is the
   * insert shape, so a required field forces every writer to say what it knows;
   * an optional one lets a call site that forgot the field compile, and the
   * value it would then store is the one reading this column must never carry —
   * a confident number nobody measured.
   *
   * Reading is the asymmetric half: `getLastCheck()` is a `SELECT *` cast, so a
   * row written before the migration yields `undefined` here, not `null`, and
   * the declared type does not say so. Test it with `== null`, never `=== null`.
   */
  battery_12v_pct: number | null;
}

export interface TpmsRow {
  id?: number;
  check_id: number;
  ts: string;
  front_left: number;
  front_right: number;
  rear_left: number;
  rear_right: number;
  all_lamps: number;
}

export interface AlertRow {
  id?: number;
  ts: string;
  alert_type: string; // fuel_low | fuel_critical | fillup | tpms_warn | tpms_critical
  details: string; // JSON
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS checks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT    NOT NULL,
    vehicle_name TEXT   NOT NULL,
    range_mi    REAL    NOT NULL,
    temp_f      REAL,
    is_fillup   INTEGER NOT NULL DEFAULT 0,
    odometer_mi REAL,
    car_reported_at TEXT,
    battery_12v_pct INTEGER
  );

  CREATE TABLE IF NOT EXISTS tpms_readings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id    INTEGER NOT NULL REFERENCES checks(id),
    ts          TEXT    NOT NULL,
    front_left  INTEGER NOT NULL,
    front_right INTEGER NOT NULL,
    rear_left   INTEGER NOT NULL,
    rear_right  INTEGER NOT NULL,
    all_lamps   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT    NOT NULL,
    alert_type  TEXT    NOT NULL,
    details     TEXT    NOT NULL
  );
`;

export interface VehicleDbOptions {
  /**
   * Open without write access and skip schema setup.
   *
   * A reader must not be the thing that migrates the database: `initSchema`
   * issues DDL, and DDL on a `readonly` connection throws. Skipping it also
   * means a reader opened against a pre-migration file simply finds no
   * `car_reported_at` on the row — which `buildStatusDocument` already treats
   * as "no usable reading" — instead of failing to open at all.
   */
  readonly?: boolean;
}

export class VehicleDb {
  private db: Database.Database;

  constructor(dbPath: string, options: VehicleDbOptions = {}) {
    this.db = new Database(dbPath, { readonly: options.readonly === true });
    // `journal_mode` is itself a write to the database header, so it is not
    // available on a readonly connection and must not be attempted there.
    if (!options.readonly) {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma('foreign_keys = ON');
    if (!options.readonly) {
      this.initSchema();
    }
  }

  private initSchema(): void {
    this.db.exec(SCHEMA);
    this.addColumnIfMissing('checks', 'car_reported_at', 'TEXT');
    this.addColumnIfMissing('checks', 'battery_12v_pct', 'INTEGER');
  }

  /**
   * Add a column to a table that may already exist.
   *
   * `CREATE TABLE IF NOT EXISTS` is a no-op against a table that is already
   * there, so the schema string above can only ever describe a database
   * created *after* the column was added. Production is not one: plexpi's
   * `vehicle-monitor.db` held 3787 `checks` rows before `car_reported_at`
   * existed. Without this, every test would pass against a fresh table while
   * the only database that matters stayed on the old shape.
   *
   * Driven off `PRAGMA table_info` rather than catching the duplicate-column
   * error, so a genuine failure still raises.
   */
  private addColumnIfMissing(table: string, column: string, type: string): void {
    const existing = (
      this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).map(c => c.name);
    if (existing.includes(column)) {
      return;
    }
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch (err) {
      // `entrypoint.sh` runs a check on container start, and cron runs one at
      // :00, so two writers can in principle open this within the one-run
      // migration window and both see the column missing. Losing that race is
      // success -- the column is there. EVERY other error still raises.
      if (!(err instanceof Error) || !/duplicate column name/i.test(err.message)) {
        throw err;
      }
    }
  }

  /** Insert a monitoring check. Returns the new row id. */
  insertCheck(row: Omit<CheckRow, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO checks (ts, vehicle_name, range_mi, temp_f, is_fillup, odometer_mi, car_reported_at, battery_12v_pct)
      VALUES (@ts, @vehicle_name, @range_mi, @temp_f, @is_fillup, @odometer_mi, @car_reported_at, @battery_12v_pct)
    `);
    const result = stmt.run(row);
    return Number(result.lastInsertRowid);
  }

  /**
   * Insert a check and its TPMS reading as one unit. Returns the check's id.
   *
   * The two inserts were sequential and unwrapped, which let a reader see a
   * check with no TPMS row — and the status reader now looks the TPMS row up
   * *by* the newest check's id, so that window renders as "this car reports no
   * tire lamps" rather than as a momentary gap. `better-sqlite3`'s
   * `transaction()` is synchronous and both statements are, so the window
   * closes with no change to the call site's shape.
   *
   * `check_id` is supplied here rather than by the caller: it does not exist
   * until the first statement has run, and asking a caller for it is asking it
   * to run the two statements itself, which is the thing being fixed.
   */
  insertCheckWithTpms(check: Omit<CheckRow, 'id'>, tpms: Omit<TpmsRow, 'id' | 'check_id'>): number {
    const both = this.db.transaction((): number => {
      const checkId = this.insertCheck(check);
      this.insertTpms({ ...tpms, check_id: checkId });
      return checkId;
    });
    return both();
  }

  /** Insert a TPMS reading linked to a check. */
  insertTpms(row: Omit<TpmsRow, 'id'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO tpms_readings (check_id, ts, front_left, front_right, rear_left, rear_right, all_lamps)
      VALUES (@check_id, @ts, @front_left, @front_right, @rear_left, @rear_right, @all_lamps)
    `);
    stmt.run(row);
  }

  /** Insert an alert record. */
  insertAlert(row: Omit<AlertRow, 'id'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO alerts (ts, alert_type, details)
      VALUES (@ts, @alert_type, @details)
    `);
    stmt.run(row);
  }

  /** Return the most recent check, or null if no history. */
  getLastCheck(): CheckRow | null {
    return (
      (this.db.prepare('SELECT * FROM checks ORDER BY id DESC LIMIT 1').get() as
        | CheckRow
        | undefined) ?? null
    );
  }

  /** Return the most recent TPMS reading, or null if no history. */
  getLastTpms(): TpmsRow | null {
    return (
      (this.db.prepare('SELECT * FROM tpms_readings ORDER BY id DESC LIMIT 1').get() as
        | TpmsRow
        | undefined) ?? null
    );
  }

  /**
   * The TPMS reading belonging to one check, or null if that check has none.
   *
   * Distinct from `getLastTpms()`, and the distinction is the whole reason this
   * exists. A consumer that reports a range from the newest check alongside
   * lamps from `getLastTpms()` is describing two different polls whenever the
   * newest check has no TPMS row — a failed TPMS insert, or a pre-`tpms_readings`
   * row — and the mismatch is invisible because both halves look fresh.
   */
  getTpmsForCheck(checkId: number): TpmsRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM tpms_readings WHERE check_id = ? ORDER BY id DESC LIMIT 1')
        .get(checkId) as TpmsRow | undefined) ?? null
    );
  }

  close(): void {
    this.db.close();
  }
}

/**
 * `battery_12v_pct`'s one coercion rule, for both sides of the round-trip.
 *
 * Lives beside the column rather than in the writer because the reader needs
 * exactly the same predicate and the two must not drift: SQLite's typing is
 * dynamic, so an `INTEGER` column will hand back whatever was put in it, and a
 * pre-migration row hands back `undefined` from a `SELECT *`.
 *
 * `Number.isFinite`, not `typeof value === 'number'`: `NaN` is a number, and
 * `batSoc` arrives through an `as VehicleStatus` cast over a vendor parser, so
 * its runtime type is a claim. **A reported 0 survives as 0** — a flat battery
 * is a reading, and the one value this must never invent is a plausible one.
 */
export function batteryPctOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The database both the writer and the reader must agree on.
 *
 * `monitor.ts` honoured `VEHICLE_DB_PATH` (documented in `.env.example`) and
 * the status reader originally called `defaultDbPath()` directly, so setting
 * that variable pointed the reader at a file the monitor never writes -- a
 * permanent exit 1 that the fuel producer can only read as an unreachable car.
 * Resolved in one place so the two cannot diverge again.
 */
export function resolveDbPath(): string {
  return process.env.VEHICLE_DB_PATH ?? defaultDbPath();
}

/** Returns the path to the SQLite DB inside the state directory. */
export function defaultDbPath(): string {
  return path.join(process.cwd(), 'state', 'vehicle-monitor.db');
}
