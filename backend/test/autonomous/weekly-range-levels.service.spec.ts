import { describe, expect, it } from 'vitest';
import {
  calculateWeeklyRangeLevels,
  detectLevelBreak,
  getPreviousCompletedWeekBounds,
} from '../../src/autonomous/weekly-range-levels.service';
import { CandleData } from '../../src/market-data/historical-candle.service';

function candle(openTime: string, high: number, low: number): CandleData {
  return { openTime: new Date(openTime), open: (high + low) / 2, high, low, close: (high + low) / 2, volume: null };
}

describe('getPreviousCompletedWeekBounds', () => {
  it('returns the prior Mon-Mon UTC range when asOf is mid-week', () => {
    // Wednesday 2026-09-09 — the week containing it starts Monday 2026-09-07.
    const { start, end } = getPreviousCompletedWeekBounds(new Date('2026-09-09T12:00:00Z'));
    expect(start.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-07T00:00:00.000Z');
  });

  it('treats asOf falling exactly on a Monday as still in the current (not-yet-completed) week', () => {
    const { start, end } = getPreviousCompletedWeekBounds(new Date('2026-09-07T00:00:01Z'));
    expect(start.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-07T00:00:00.000Z');
  });

  it('handles a Sunday correctly (still counts as part of the week starting the prior Monday)', () => {
    const { start, end } = getPreviousCompletedWeekBounds(new Date('2026-09-13T23:00:00Z')); // Sunday
    expect(start.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-07T00:00:00.000Z');
  });
});

describe('calculateWeeklyRangeLevels', () => {
  const asOf = new Date('2026-09-09T12:00:00Z'); // reference week: 2026-08-31 .. 2026-09-07

  it('returns null when no candles fall within the reference week', () => {
    const candles = [candle('2026-09-08T00:00:00Z', 1.2, 1.1)]; // after the reference week ended
    expect(calculateWeeklyRangeLevels(candles, asOf)).toBeNull();
  });

  it("computes the week's absolute highest high and lowest low (Rule 4), not a pivot/fractal method", () => {
    const candles = [
      candle('2026-08-31T00:00:00Z', 1.1, 1.09),
      candle('2026-09-02T08:00:00Z', 1.15, 1.095), // highest high
      candle('2026-09-04T04:00:00Z', 1.12, 1.085), // lowest low
      candle('2026-09-06T20:00:00Z', 1.11, 1.1),
    ];
    const levels = calculateWeeklyRangeLevels(candles, asOf);
    expect(levels).not.toBeNull();
    expect(levels!.resistance).toBe(1.15);
    expect(levels!.support).toBe(1.085);
    expect(levels!.candleCount).toBe(4);
    expect(levels!.referenceWeekStart.toISOString()).toBe('2026-08-31T00:00:00.000Z');
  });

  it('excludes candles outside the reference week even if adjacent', () => {
    const candles = [
      candle('2026-08-30T23:00:00Z', 1.5, 1.4), // one hour before the week starts — must be excluded
      candle('2026-09-01T00:00:00Z', 1.1, 1.05),
      candle('2026-09-07T00:00:00Z', 1.6, 1.55), // exactly at the week's exclusive end — must be excluded
    ];
    const levels = calculateWeeklyRangeLevels(candles, asOf);
    expect(levels!.resistance).toBe(1.1);
    expect(levels!.support).toBe(1.05);
    expect(levels!.candleCount).toBe(1);
  });
});

describe('detectLevelBreak', () => {
  const levels = {
    referenceWeekStart: new Date('2026-08-31T00:00:00Z'),
    referenceWeekEnd: new Date('2026-09-07T00:00:00Z'),
    resistance: 1.15,
    support: 1.08,
    candleCount: 10,
  };

  it('reports no break when subsequent price stays within the range', () => {
    const candles = [candle('2026-09-07T04:00:00Z', 1.12, 1.1)];
    expect(detectLevelBreak(levels, candles)).toEqual({ resistanceBroken: false, supportBroken: false });
  });

  it('detects a resistance break', () => {
    const candles = [candle('2026-09-08T00:00:00Z', 1.16, 1.14)];
    expect(detectLevelBreak(levels, candles)).toEqual({ resistanceBroken: true, supportBroken: false });
  });

  it('detects a support break', () => {
    const candles = [candle('2026-09-08T00:00:00Z', 1.09, 1.07)];
    expect(detectLevelBreak(levels, candles)).toEqual({ resistanceBroken: false, supportBroken: true });
  });

  it('ignores candles from before the reference week ended', () => {
    // Would break resistance, but it's still inside the reference week itself.
    const candles = [candle('2026-09-03T00:00:00Z', 1.3, 1.2)];
    expect(detectLevelBreak(levels, candles)).toEqual({ resistanceBroken: false, supportBroken: false });
  });
});
