/**
 * Tests for the pure logic helpers in src/monitor-helpers.ts.
 * These are stateless functions that can be tested without a Bluelink API.
 */
import americanStatus from './mock/americanStatus.json';
import { carReportedAt, checkRowFrom, newlyLitWheels, tpmsSeverity } from '../src/monitor-helpers';

describe('newlyLitWheels', () => {
  it('returns all four wheels plus allLamps when all flags transition off→on simultaneously', () => {
    const current = {
      frontLeft: true,
      frontRight: true,
      rearLeft: true,
      rearRight: true,
      all: true,
    };
    const sent = {
      frontLeft: false,
      frontRight: false,
      rearLeft: false,
      rearRight: false,
      allLamps: false,
    };
    expect(newlyLitWheels(current, sent)).toEqual([
      'frontLeft',
      'frontRight',
      'rearLeft',
      'rearRight',
      'allLamps',
    ]);
  });

  it('returns only per-wheel lamps when all flag is false', () => {
    const current = {
      frontLeft: true,
      frontRight: true,
      rearLeft: false,
      rearRight: false,
      all: false,
    };
    const sent = {
      frontLeft: false,
      frontRight: false,
      rearLeft: false,
      rearRight: false,
      allLamps: false,
    };
    expect(newlyLitWheels(current, sent)).toEqual(['frontLeft', 'frontRight']);
  });

  it('returns only newly-lit wheels (previously-sent wheels are excluded)', () => {
    const current = {
      frontLeft: true,
      frontRight: true,
      rearLeft: false,
      rearRight: false,
      all: false,
    };
    const sent = {
      frontLeft: true,
      frontRight: false,
      rearLeft: false,
      rearRight: false,
      allLamps: false,
    };
    expect(newlyLitWheels(current, sent)).toEqual(['frontRight']);
  });

  it('returns empty array when no new lamps lit', () => {
    const current = {
      frontLeft: false,
      frontRight: false,
      rearLeft: false,
      rearRight: false,
      all: false,
    };
    const sent = {
      frontLeft: false,
      frontRight: false,
      rearLeft: false,
      rearRight: false,
      allLamps: false,
    };
    expect(newlyLitWheels(current, sent)).toEqual([]);
  });

  it('returns empty array when all lit wheels were already sent', () => {
    const current = {
      frontLeft: true,
      frontRight: false,
      rearLeft: false,
      rearRight: false,
      all: false,
    };
    const sent = {
      frontLeft: true,
      frontRight: false,
      rearLeft: false,
      rearRight: false,
      allLamps: false,
    };
    expect(newlyLitWheels(current, sent)).toEqual([]);
  });

  it('does not return wheels that are off even if they were previously sent', () => {
    // After a reset cycle: previously sent but lamp now off → don't re-fire
    const current = {
      frontLeft: false,
      frontRight: false,
      rearLeft: false,
      rearRight: false,
      all: false,
    };
    const sent = {
      frontLeft: true,
      frontRight: true,
      rearLeft: false,
      rearRight: false,
      allLamps: false,
    };
    expect(newlyLitWheels(current, sent)).toEqual([]);
  });

  it('includes allLamps when all flag transitions off→on even if per-wheel alerts already sent', () => {
    // Edge case: per-wheel alerts already sent, then all flag fires on next poll
    const current = {
      frontLeft: true,
      frontRight: true,
      rearLeft: true,
      rearRight: true,
      all: true,
    };
    const sent = {
      frontLeft: true,
      frontRight: true,
      rearLeft: true,
      rearRight: true,
      allLamps: false,
    };
    expect(newlyLitWheels(current, sent)).toEqual(['allLamps']);
  });

  it('does not return allLamps when it was already sent', () => {
    const current = {
      frontLeft: true,
      frontRight: true,
      rearLeft: true,
      rearRight: true,
      all: true,
    };
    const sent = {
      frontLeft: true,
      frontRight: true,
      rearLeft: true,
      rearRight: true,
      allLamps: true,
    };
    expect(newlyLitWheels(current, sent)).toEqual([]);
  });

  it('clears allLamps from sent when all flag goes off', () => {
    // Verify the allLamps flag is reset when all flag is false — test via newlyLitWheels logic
    const current = {
      frontLeft: false,
      frontRight: false,
      rearLeft: false,
      rearRight: false,
      all: false,
    };
    const sent = {
      frontLeft: false,
      frontRight: false,
      rearLeft: false,
      rearRight: false,
      allLamps: true,
    };
    expect(newlyLitWheels(current, sent)).toEqual([]);
  });
});

describe('tpmsSeverity', () => {
  it('returns critical when all flag is set', () => {
    expect(tpmsSeverity(['frontLeft'], true)).toBe('critical');
  });

  it('returns critical when 3 wheels lit', () => {
    expect(tpmsSeverity(['frontLeft', 'frontRight', 'rearLeft'], false)).toBe('critical');
  });

  it('returns critical when 4 wheels lit', () => {
    expect(tpmsSeverity(['frontLeft', 'frontRight', 'rearLeft', 'rearRight'], false)).toBe(
      'critical'
    );
  });

  it('returns warn for a single wheel', () => {
    expect(tpmsSeverity(['frontLeft'], false)).toBe('warn');
  });

  it('returns warn for two wheels', () => {
    expect(tpmsSeverity(['frontLeft', 'rearRight'], false)).toBe('warn');
  });
});

describe('carReportedAt', () => {
  it('normalises a Date to an ISO string', () => {
    expect(carReportedAt(new Date('2026-09-19T11:04:00.000Z'))).toBe('2026-09-19T11:04:00.000Z');
  });

  it('accepts an ISO string, because the vendor parser is reached through a cast', () => {
    expect(carReportedAt('2026-09-19T11:04:00.000Z')).toBe('2026-09-19T11:04:00.000Z');
  });

  it('returns null for null and undefined', () => {
    expect(carReportedAt(null)).toBeNull();
    expect(carReportedAt(undefined)).toBeNull();
  });

  it('returns null for an empty or blank string', () => {
    expect(carReportedAt('')).toBeNull();
    expect(carReportedAt('   ')).toBeNull();
  });

  it('returns null for an Invalid Date rather than throwing', () => {
    // `new Date('nonsense')` IS a Date, so an instanceof guard passes it
    // through, and `.toISOString()` on it throws a RangeError -- which would
    // abort the entire monitoring run over its least important field.
    const invalid = new Date('nonsense');
    expect(invalid instanceof Date).toBe(true);
    expect(() => invalid.toISOString()).toThrow();
    expect(carReportedAt(invalid)).toBeNull();
    expect(carReportedAt('nonsense')).toBeNull();
  });

  it('returns null for a shape that is neither a Date nor a string', () => {
    expect(carReportedAt(1758279840000)).toBeNull();
    expect(carReportedAt({ when: 'yesterday' })).toBeNull();
  });
});

describe('checkRowFrom', () => {
  // `ts` and `lastupdate` are deliberately three days apart. A fixture where
  // they coincide cannot tell the correct mapping from `car_reported_at: ts`,
  // which is the mistake this function exists to make unmakeable.
  const run = {
    ts: '2026-09-22T18:00:09.885Z',
    vehicleName: '2020 SANTA FE',
    rangeMi: 88,
    tempF: 63.7,
    isFillup: false,
    odometerMi: null,
    lastupdate: new Date('2026-09-19T11:04:00.000Z'),
  };

  it('maps the car report time from lastupdate, not from ts', () => {
    const row = checkRowFrom(run);
    expect(row.car_reported_at).toBe('2026-09-19T11:04:00.000Z');
    expect(row.ts).toBe('2026-09-22T18:00:09.885Z');
    expect(row.car_reported_at).not.toBe(row.ts);
  });

  it('carries the rest of the run through unchanged', () => {
    expect(checkRowFrom(run)).toEqual({
      ts: '2026-09-22T18:00:09.885Z',
      vehicle_name: '2020 SANTA FE',
      range_mi: 88,
      temp_f: 63.7,
      is_fillup: 0,
      odometer_mi: null,
      car_reported_at: '2026-09-19T11:04:00.000Z',
    });
  });

  it('booleans the fill-up flag into SQLite 0/1', () => {
    expect(checkRowFrom({ ...run, isFillup: true }).is_fillup).toBe(1);
    expect(checkRowFrom({ ...run, isFillup: false }).is_fillup).toBe(0);
  });

  it('leaves car_reported_at null when the car did not say, rather than using ts', () => {
    expect(checkRowFrom({ ...run, lastupdate: null }).car_reported_at).toBeNull();
  });
});

describe('carReportedAt against what the vendor parser actually produces', () => {
  it('accepts the American parser output shape', () => {
    // Every other case in this file is a hand-written literal, which pins my
    // assumption rather than the vendor's behaviour. `american.vehicle.ts:301`
    // is `lastupdate: new Date(vehicleStatus?.dateTime)`, so this reproduces
    // that expression against the repo's own captured API response.
    const captured = americanStatus.dateTime;
    const asTheParserMakesIt = new Date(captured);

    expect(carReportedAt(asTheParserMakesIt)).toBe('2020-05-20T23:20:39.000Z');
  });

  it('control: an absent dateTime is the Invalid Date the guard exists for', () => {
    // Same expression with the field missing -- `new Date(undefined)`. If the
    // live account ever stops sending `dateTime`, this is the shape that
    // arrives, and it must become null rather than throw or become "now".
    expect(carReportedAt(new Date(undefined as unknown as string))).toBeNull();
  });

  it("control: Hyundai's compact spelling would NOT parse, and must not be invented", () => {
    // `YYYYMMDDHHmmss` appears elsewhere in this API. `new Date()` on it is an
    // Invalid Date in Node, so it returns null -- the honest answer -- rather
    // than a plausible-looking wrong timestamp.
    expect(carReportedAt(new Date('20260922123629'))).toBeNull();
  });
});
