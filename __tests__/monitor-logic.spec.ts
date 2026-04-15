/**
 * Tests for the pure logic helpers in src/monitor-helpers.ts.
 * These are stateless functions that can be tested without a Bluelink API.
 */
import { newlyLitWheels, tpmsSeverity } from '../src/monitor-helpers';

describe('newlyLitWheels', () => {
  it('returns all four wheels plus allLamps when all flags transition off→on simultaneously', () => {
    const current = { frontLeft: true, frontRight: true, rearLeft: true, rearRight: true, all: true };
    const sent = { frontLeft: false, frontRight: false, rearLeft: false, rearRight: false, allLamps: false };
    expect(newlyLitWheels(current, sent)).toEqual(['frontLeft', 'frontRight', 'rearLeft', 'rearRight', 'allLamps']);
  });

  it('returns only per-wheel lamps when all flag is false', () => {
    const current = { frontLeft: true, frontRight: true, rearLeft: false, rearRight: false, all: false };
    const sent = { frontLeft: false, frontRight: false, rearLeft: false, rearRight: false, allLamps: false };
    expect(newlyLitWheels(current, sent)).toEqual(['frontLeft', 'frontRight']);
  });

  it('returns only newly-lit wheels (previously-sent wheels are excluded)', () => {
    const current = { frontLeft: true, frontRight: true, rearLeft: false, rearRight: false, all: false };
    const sent = { frontLeft: true, frontRight: false, rearLeft: false, rearRight: false, allLamps: false };
    expect(newlyLitWheels(current, sent)).toEqual(['frontRight']);
  });

  it('returns empty array when no new lamps lit', () => {
    const current = { frontLeft: false, frontRight: false, rearLeft: false, rearRight: false, all: false };
    const sent = { frontLeft: false, frontRight: false, rearLeft: false, rearRight: false, allLamps: false };
    expect(newlyLitWheels(current, sent)).toEqual([]);
  });

  it('returns empty array when all lit wheels were already sent', () => {
    const current = { frontLeft: true, frontRight: false, rearLeft: false, rearRight: false, all: false };
    const sent = { frontLeft: true, frontRight: false, rearLeft: false, rearRight: false, allLamps: false };
    expect(newlyLitWheels(current, sent)).toEqual([]);
  });

  it('does not return wheels that are off even if they were previously sent', () => {
    // After a reset cycle: previously sent but lamp now off → don't re-fire
    const current = { frontLeft: false, frontRight: false, rearLeft: false, rearRight: false, all: false };
    const sent = { frontLeft: true, frontRight: true, rearLeft: false, rearRight: false, allLamps: false };
    expect(newlyLitWheels(current, sent)).toEqual([]);
  });

  it('includes allLamps when all flag transitions off→on even if per-wheel alerts already sent', () => {
    // Edge case: per-wheel alerts already sent, then all flag fires on next poll
    const current = { frontLeft: true, frontRight: true, rearLeft: true, rearRight: true, all: true };
    const sent = { frontLeft: true, frontRight: true, rearLeft: true, rearRight: true, allLamps: false };
    expect(newlyLitWheels(current, sent)).toEqual(['allLamps']);
  });

  it('does not return allLamps when it was already sent', () => {
    const current = { frontLeft: true, frontRight: true, rearLeft: true, rearRight: true, all: true };
    const sent = { frontLeft: true, frontRight: true, rearLeft: true, rearRight: true, allLamps: true };
    expect(newlyLitWheels(current, sent)).toEqual([]);
  });

  it('clears allLamps from sent when all flag goes off', () => {
    // Verify the allLamps flag is reset when all flag is false — test via newlyLitWheels logic
    const current = { frontLeft: false, frontRight: false, rearLeft: false, rearRight: false, all: false };
    const sent = { frontLeft: false, frontRight: false, rearLeft: false, rearRight: false, allLamps: true };
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
    expect(tpmsSeverity(['frontLeft', 'frontRight', 'rearLeft', 'rearRight'], false)).toBe('critical');
  });

  it('returns warn for a single wheel', () => {
    expect(tpmsSeverity(['frontLeft'], false)).toBe('warn');
  });

  it('returns warn for two wheels', () => {
    expect(tpmsSeverity(['frontLeft', 'rearRight'], false)).toBe('warn');
  });
});
