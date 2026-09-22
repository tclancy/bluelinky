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
    car_reported_at TEXT
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
    if (!existing.includes(column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  /** Insert a monitoring check. Returns the new row id. */
  insertCheck(row: Omit<CheckRow, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO checks (ts, vehicle_name, range_mi, temp_f, is_fillup, odometer_mi, car_reported_at)
      VALUES (@ts, @vehicle_name, @range_mi, @temp_f, @is_fillup, @odometer_mi, @car_reported_at)
    `);
    const result = stmt.run(row);
    return Number(result.lastInsertRowid);
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

  close(): void {
    this.db.close();
  }
}

/** Returns the path to the SQLite DB inside the state directory. */
export function defaultDbPath(): string {
  return path.join(process.cwd(), 'state', 'vehicle-monitor.db');
}
