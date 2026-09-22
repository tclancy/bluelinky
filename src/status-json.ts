/**
 * One JSON object describing the car's latest known fuel state, for machines.
 *
 * The consumer is parsons-pulse's `producer/fuel_level.py`, which runs a
 * command, parses one JSON object off stdout, and posts it to the fridge
 * dashboard's hub. It deliberately ships no default for that command; this
 * module is the command.
 *
 * **It reads the local history rather than calling Hyundai.** `monitor.ts`
 * already polls hourly and writes every reading to `vehicle-monitor.db`, which
 * is the same cadence the producer needs. A second login would double the API
 * traffic against the car, add a network round-trip to a timer that has to
 * finish, and put the Bluelink credentials on a second execution path — three
 * costs for a number already sitting on disk.
 */

import { CheckRow, VehicleDb, defaultDbPath } from './vehicle-db';

/**
 * Exactly the keys `producer/fuel_level.py`'s `REQUIRED_STATUS_FIELDS` names.
 *
 * A missing one is indistinguishable, there, from a car that could not be
 * reached — so a rename on this side is a silent outage on that side rather
 * than an error. Exported so a test can pin the emitted key set against it.
 */
export const REQUIRED_STATUS_FIELDS = ['vehicle', 'range_miles', 'reported_at'] as const;

export interface StatusDocument {
  vehicle: string;
  range_miles: number;
  reported_at: string;
}

/**
 * The status document for one check row, or null if that row cannot support one.
 *
 * Null rather than a partial object, and null rather than a fallback: the
 * producer treats an unusable document exactly as it treats an unreachable
 * car, which is the honest reading of "we do not have this".
 *
 * **`reported_at` is the car's time, never `ts`.** Substituting the check time
 * would make `reported_at` permanently under an hour old, which silently
 * disables the dashboard's three-day vehicle-quiet signal — a car that has not
 * phoned home in a week would render as a confident, fresh number. Every row
 * written before `car_reported_at` existed has a null there, so the fallback is
 * the tempting move and is the bug.
 *
 * `fuel_percent` is absent on purpose. The contract marks it optional, and this
 * API is never asked for a percentage; omitting it travels to the hub as an
 * explicit null rather than an invented number.
 */
export function buildStatusDocument(row: CheckRow | null): StatusDocument | null {
  if (row === null || !row.car_reported_at) {
    return null;
  }
  return {
    vehicle: row.vehicle_name,
    range_miles: row.range_mi,
    reported_at: row.car_reported_at,
  };
}

export function unopenable(dbPath: string, reason: string): string {
  return (
    `cannot open ${dbPath}: ${reason}. This reader never creates the database -- ` +
    'it is written by monitor.ts, so an absent one means the state volume is not ' +
    'mounted or no monitoring run has happened yet.'
  );
}

export const NO_USABLE_READING =
  'no usable reading: the newest row in vehicle-monitor.db has no car report time. ' +
  'Rows written before the car_reported_at column existed never will; the next ' +
  'monitor.ts run (hourly, top of the hour) writes one that does.';

/**
 * What the entry point should print, and with which exit code.
 *
 * Returns the report rather than printing it because `src/` is under an
 * ESLint `no-console: error` rule -- and the constraint turns out to be the
 * better design anyway: the tests below assert the exact bytes of stdout and
 * stderr without spying on a global, and nothing in this module can be the
 * thing that writes to a terminal.
 *
 * The database is opened **read-only**. The monitor owns this file and is
 * writing to it on the hour, and `FUEL_STATUS_COMMAND` runs unattended on a
 * timer; read-only makes "the reader corrupted the history" impossible rather
 * than merely unintended. It also will not CREATE a missing file, so "the
 * state volume is not mounted" stays distinguishable from "no readings yet"
 * instead of being papered over with an empty database.
 */
export function statusReport(dbPath: string = defaultDbPath()): {
  code: number;
  stdout: string;
  stderr: string;
} {
  // better-sqlite3 signals an unopenable file by throwing, and an uncaught
  // throw reaches the fuel producer as a Node stack trace on stderr -- which
  // it can only read as an unreachable car, with seven lines of internals
  // attached. Say it in a sentence and exit the way a missing reading does.
  let db: VehicleDb;
  try {
    db = new VehicleDb(dbPath, { readonly: true });
  } catch (err) {
    return {
      code: 1,
      stdout: '',
      stderr: unopenable(dbPath, err instanceof Error ? err.message : String(err)),
    };
  }
  try {
    const document = buildStatusDocument(db.getLastCheck());
    if (document === null) {
      return { code: 1, stdout: '', stderr: NO_USABLE_READING };
    }
    return { code: 0, stdout: JSON.stringify(document), stderr: '' };
  } finally {
    db.close();
  }
}
