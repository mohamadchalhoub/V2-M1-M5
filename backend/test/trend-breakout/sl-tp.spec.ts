import { describe, expect, it } from 'vitest';
import { computeRawDistances, computeRoundedSlTp, isSlTpError } from '../../src/trend-breakout/sl-tp';

describe('computeRawDistances', () => {
  it('is 1.5x A for the stop and 3x A for the target', () => {
    const { rawStopDistance, rawTargetDistance } = computeRawDistances(0.001);
    expect(rawStopDistance).toBeCloseTo(0.0015, 10);
    expect(rawTargetDistance).toBeCloseTo(0.003, 10);
  });
});

describe('computeRoundedSlTp', () => {
  it('computes a correct 2:1 BUY bracket, rounded to the broker increment', () => {
    const result = computeRoundedSlTp('BUY', 1.1, 0.001, 0.00001);
    expect(isSlTpError(result)).toBe(false);
    if (!isSlTpError(result)) {
      expect(result.stopLoss).toBeCloseTo(1.1 - 0.0015, 5);
      expect(result.takeProfit).toBeCloseTo(1.1 + 0.003, 5);
      expect(result.stopLoss).toBeLessThan(1.1);
      expect(result.takeProfit).toBeGreaterThan(1.1);
    }
  });

  it('mirrors correctly for a SELL', () => {
    const result = computeRoundedSlTp('SELL', 1.1, 0.001, 0.00001);
    expect(isSlTpError(result)).toBe(false);
    if (!isSlTpError(result)) {
      expect(result.stopLoss).toBeGreaterThan(1.1);
      expect(result.takeProfit).toBeLessThan(1.1);
    }
  });

  it('rounds gold-scale prices to a 0.01 increment without floating-point noise', () => {
    const result = computeRoundedSlTp('BUY', 2650.37, 1.2345, 0.01);
    expect(isSlTpError(result)).toBe(false);
    if (!isSlTpError(result)) {
      // Rounded to 2 decimals, never something like 2648.634999999998.
      expect(Number.isInteger(result.stopLoss * 100)).toBe(true);
      expect(Number.isInteger(result.takeProfit * 100)).toBe(true);
    }
  });

  it('rejects rather than silently expands when the increment is invalid', () => {
    const result = computeRoundedSlTp('BUY', 1.1, 0.001, 0);
    expect(isSlTpError(result)).toBe(true);
  });

  it('rejects rather than silently expands when ATR is non-positive', () => {
    const result = computeRoundedSlTp('BUY', 1.1, 0, 0.00001);
    expect(isSlTpError(result)).toBe(true);
  });

  it('rejects a pathological setup where the increment would collapse the stop distance to zero', () => {
    // ATR so tiny that 1.5xA rounds to less than half an increment.
    const result = computeRoundedSlTp('BUY', 1.1, 0.0000001, 0.01);
    expect(isSlTpError(result)).toBe(true);
  });

  it('reports the ROUNDED distance, which can differ slightly from the raw 1.5x/3x distance', () => {
    const result = computeRoundedSlTp('BUY', 1.10003, 0.001, 0.0001); // increment coarser than the raw stop distance's own precision
    expect(isSlTpError(result)).toBe(false);
    if (!isSlTpError(result)) {
      const raw = computeRawDistances(0.001);
      // Not necessarily exactly equal after rounding to a coarser increment.
      expect(result.roundedStopDistance).toBeCloseTo(raw.rawStopDistance, 3);
    }
  });
});
