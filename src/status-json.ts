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

import { CheckRow, TpmsRow, VehicleDb, batteryPctOrNull, resolveDbPath } from './vehicle-db';

/**
 * Exactly the keys `producer/fuel_level.py`'s `REQUIRED_STATUS_FIELDS` names.
 *
 * A missing one is indistinguishable, there, from a car that could not be
 * reached — so a rename on this side is a silent outage on that side rather
 * than an error. Exported so a test can pin the emitted key set against it.
 */
export const REQUIRED_STATUS_FIELDS = ['vehicle', 'range_miles', 'reported_at'] as const;

/** The four wheel lamps plus the dash master lamp, as the producer reads them. */
export interface TirePressureWarning {
  front_left: boolean;
  front_right: boolean;
  rear_left: boolean;
  rear_right: boolean;
  all: boolean;
}

/**
 * The status document. The three required fields, plus two optional ones.
 *
 * `battery_12v_percent` and `tire_pressure_warning` are **omitted** rather than
 * nulled when unknown, and `REQUIRED_STATUS_FIELDS` does not grow. The producer
 * picks fields by name, so an old producer ignores a new key and a new producer
 * reads an absent key as `None` — which makes this boundary either-order.
 * Nulling instead would travel as an explicit "the car says 0 lamps lit", and
 * every pre-migration row in production would say it.
 */
export interface StatusDocument {
  vehicle: string;
  range_miles: number;
  reported_at: string;
  battery_12v_percent?: number;
  tire_pressure_warning?: TirePressureWarning;
}

/**
 * One lamp column as a boolean.
 *
 * `!== 0` rather than `Boolean()`: the column is `INTEGER NOT NULL` written only
 * by `insertTpms` as `? 1 : 0`, so the two values it holds are the two it means,
 * and anything else reaching here is a corrupt row that should read as lit
 * rather than as "all clear".
 */
function lampOn(value: number): boolean {
  return value !== 0;
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
 *
 * **`tpms` is a required second argument, with no default.** It must be the TPMS
 * row belonging to `row`, not the newest one in the table — a default of `null`
 * would let a call site that forgot it compile and emit a document whose tire
 * state is silently absent, which is the one failure here that looks like
 * success. `null` means "this check has no TPMS reading", and the key is omitted.
 */
export function buildStatusDocument(
  row: CheckRow | null,
  tpms: TpmsRow | null
): StatusDocument | null {
  if (row === null || !row.car_reported_at) {
    return null;
  }
  const document: StatusDocument = {
    vehicle: row.vehicle_name,
    range_miles: row.range_mi,
    reported_at: row.car_reported_at,
  };
  // `batteryPctOrNull`, not a truthiness test and not `!== undefined`. A row
  // written before the column existed comes back from `SELECT *` as `undefined`
  // rather than `null`, so the declared `number | null` is wrong here and both
  // spellings have to collapse to the same answer; and a reported **0** is a
  // reading that must survive, which `if (row.battery_12v_pct)` would drop.
  const battery = batteryPctOrNull(row.battery_12v_pct);
  if (battery != null) {
    document.battery_12v_percent = battery;
  }
  if (tpms !== null) {
    document.tire_pressure_warning = {
      front_left: lampOn(tpms.front_left),
      front_right: lampOn(tpms.front_right),
      rear_left: lampOn(tpms.rear_left),
      rear_right: lampOn(tpms.rear_right),
      all: lampOn(tpms.all_lamps),
    };
  }
  return document;
}

/**
 * The TPMS row belonging to a check, or null if there is not one to be had.
 *
 * Fetched **by the check's id**, never with `getLastTpms()`: the two disagree
 * whenever the newest check has no TPMS row, and the disagreement is a document
 * reporting this poll's range beside some earlier poll's tire lamps, both halves
 * looking equally fresh.
 *
 * The `catch` is scoped to the optional half on purpose. By the time this runs
 * the required fields are already in hand, so a `tpms_readings` table that is
 * missing (a database from before TPMS existed) or corrupt must cost the tire
 * state and nothing else — letting it reach the outer handler would turn a good
 * range reading into `unreadable`, which the producer can only read as an
 * unreachable car. A failure reading `checks` is not caught here and still does.
 */
function tpmsFor(db: VehicleDb, check: CheckRow | null): TpmsRow | null {
  if (check?.id === undefined) {
    return null;
  }
  try {
    return db.getTpmsForCheck(check.id);
  } catch {
    return null;
  }
}

export function unopenable(dbPath: string, reason: string): string {
  return (
    `cannot open ${dbPath}: ${reason}. This reader never creates the database -- ` +
    'it is written by monitor.ts, so an absent one means the state volume is not ' +
    'mounted or no monitoring run has happened yet.'
  );
}

export function unreadable(dbPath: string, reason: string): string {
  return (
    `cannot read ${dbPath}: ${reason}. The file opened but the history could ` +
    'not be queried, which is corruption or a truncated file rather than a ' +
    'missing one -- the monitor writes this database, so it is the thing to look at.'
  );
}

export const NO_USABLE_READING =
  'no usable reading: the newest row in vehicle-monitor.db has no car report time. ' +
  'Rows written before the car_reported_at column existed never will; the next ' +
  'monitor.ts run writes one that does -- on container start, then hourly at :00.';

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
export function statusReport(dbPath: string = resolveDbPath()): {
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
  // Opening and QUERYING fail separately, and only the first was guarded at
  // first. A zero-byte or corrupt file opens perfectly well and throws at
  // `prepare` -- `no such table: checks`, `file is not a database` -- which is
  // exactly when a sentence is worth most on a Pi with an SD card.
  try {
    const check = db.getLastCheck();
    const document = buildStatusDocument(check, tpmsFor(db, check));
    if (document === null) {
      return { code: 1, stdout: '', stderr: NO_USABLE_READING };
    }
    return { code: 0, stdout: JSON.stringify(document), stderr: '' };
  } catch (err) {
    return {
      code: 1,
      stdout: '',
      stderr: unreadable(dbPath, err instanceof Error ? err.message : String(err)),
    };
  } finally {
    db.close();
  }
}
