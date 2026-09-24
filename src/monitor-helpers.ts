/**
 * Pure helper functions for vehicle monitoring.
 * Extracted here so tests can import them without triggering
 * the credential validation side effects in monitor.ts.
 */

import type { CheckRow as CheckRowShape } from './vehicle-db';

/** The insertable shape of a `checks` row (no `id` until SQLite assigns one). */
type CheckRow = Omit<CheckRowShape, 'id'>;

// ── Temperature ───────────────────────────────────────────────────────────────

/** Returns current outdoor temperature in °F from Open-Meteo, or null on failure. */
export async function fetchOutdoorTempF(lat: string, lon: string): Promise<number | null> {
  try {
    const url =
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${lat}&longitude=${lon}` +
      '&current=temperature_2m&temperature_unit=fahrenheit&forecast_days=1';
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { current?: { temperature_2m?: number } };
    return data?.current?.temperature_2m ?? null;
  } catch {
    return null;
  }
}

// ── TPMS ──────────────────────────────────────────────────────────────────────

export interface TpmsLamps {
  frontLeft: boolean;
  frontRight: boolean;
  rearLeft: boolean;
  rearRight: boolean;
  all: boolean;
}

export interface TpmsAlertDedup {
  frontLeft: boolean;
  frontRight: boolean;
  rearLeft: boolean;
  rearRight: boolean;
  allLamps: boolean; // tracks the all-wheels flag independently
}

/**
 * Returns list of wheel names whose lamps are newly ON (off→on transition).
 * Includes 'allLamps' if the all-wheels flag transitioned from false → true.
 */
export function newlyLitWheels(current: TpmsLamps, sentState: TpmsAlertDedup): string[] {
  const wheels: Array<'frontLeft' | 'frontRight' | 'rearLeft' | 'rearRight'> = [
    'frontLeft',
    'frontRight',
    'rearLeft',
    'rearRight',
  ];
  const result: string[] = wheels.filter(w => current[w] && !sentState[w]);
  if (current.all && !sentState.allLamps) {
    result.push('allLamps');
  }
  return result;
}

/** Returns severity based on how many wheels are lit or whether the all flag is set. */
export function tpmsSeverity(litWheels: string[], allFlag: boolean): 'warn' | 'critical' {
  if (allFlag || litWheels.length >= 3) return 'critical';
  return 'warn';
}

/**
 * `status.lastupdate` as an ISO string for `checks.car_reported_at`, or null.
 *
 * The declared type is `Date | null`, but this value crosses a vendor parser
 * that is not ours and is reached through an `as VehicleStatus` cast, so the
 * runtime shape is a claim rather than a guarantee — an ISO string is the
 * likely other spelling. Both are accepted and anything else becomes null,
 * because the consumer of this column would rather have nothing than a
 * timestamp it cannot trust.
 *
 * `Invalid Date` is the case worth naming: it is a `Date`, so it passes an
 * `instanceof` check, and `toISOString()` on it *throws* rather than returning
 * a bad string. Left unguarded that would take down the whole monitoring run
 * over the least important field in it.
 */
export function carReportedAt(lastupdate: unknown): string | null {
  const candidate =
    lastupdate instanceof Date
      ? lastupdate
      : typeof lastupdate === 'string' && lastupdate.trim() !== ''
      ? new Date(lastupdate)
      : null;
  if (candidate === null || Number.isNaN(candidate.getTime())) {
    return null;
  }
  return candidate.toISOString();
}

/**
 * The `checks` row for one monitoring run.
 *
 * Extracted from `monitor.ts` because the interesting part of it is a
 * *mapping*, and the mapping has a wrong answer that looks right: `ts` and
 * `car_reported_at` are both timestamps, both in scope at the call site, and
 * only one of them answers "when did the car last report". Inside `monitor.ts`
 * that assignment sits in an async Bluelink callback and no test can reach it;
 * here it is six lines that one can.
 */
export function checkRowFrom(run: {
  ts: string;
  vehicleName: string;
  rangeMi: number;
  tempF: number | null;
  isFillup: boolean;
  odometerMi: number | null;
  lastupdate: unknown;
}): CheckRow {
  return {
    ts: run.ts,
    vehicle_name: run.vehicleName,
    range_mi: run.rangeMi,
    temp_f: run.tempF,
    is_fillup: run.isFillup ? 1 : 0,
    odometer_mi: run.odometerMi,
    car_reported_at: carReportedAt(run.lastupdate),
  };
}
