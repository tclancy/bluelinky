/**
 * SQLite database for vehicle monitoring history.
 *
 * Three tables:
 *   checks        — one row per monitoring run (fuel range + fillup flag + odometer)
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
    odometer_mi REAL
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

export class VehicleDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(SCHEMA);
  }

  /** Insert a monitoring check. Returns the new row id. */
  insertCheck(row: Omit<CheckRow, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO checks (ts, vehicle_name, range_mi, temp_f, is_fillup, odometer_mi)
      VALUES (@ts, @vehicle_name, @range_mi, @temp_f, @is_fillup, @odometer_mi)
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
      (this.db
        .prepare('SELECT * FROM checks ORDER BY id DESC LIMIT 1')
        .get() as CheckRow | undefined) ?? null
    );
  }

  /** Return the most recent TPMS reading, or null if no history. */
  getLastTpms(): TpmsRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM tpms_readings ORDER BY id DESC LIMIT 1')
        .get() as TpmsRow | undefined) ?? null
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
