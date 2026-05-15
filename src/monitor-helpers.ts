/**
 * Pure helper functions for vehicle monitoring.
 * Extracted here so tests can import them without triggering
 * the credential validation side effects in monitor.ts.
 */

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
