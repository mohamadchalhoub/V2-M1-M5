import { describe, expect, it } from 'vitest';
import {
  calculateSupportResistanceLevels,
  findLevelsNearPrice,
  SupportResistanceLevel,
} from '../../src/technical-analysis/support-resistance.service';
import { CandleData } from '../../src/market-data/historical-candle.service';

function candle(openTime: string, high: number, low: number): CandleData {
  return { openTime: new Date(openTime), open: (high + low) / 2, high, low, close: (high + low) / 2, volume: null };
}

function level(overrides: Partial<SupportResistanceLevel> = {}): SupportResistanceLevel {
  return { timeframe: 'H4', type: 'SUPPORT', price: 1.1, method: 'FRACTAL_PIVOT', timestamp: new Date('2026-01-01'), touches: 1, ...overrides };
}

describe('calculateSupportResistanceLevels', () => {
  it('returns nothing with fewer than 2*FRACTAL_WIDTH+1 candles', () => {
    expect(calculateSupportResistanceLevels([candle('2026-01-01T00:00Z', 1.1, 1.09)], 'H1')).toEqual([]);
  });

  it('identifies a single resistance pivot at a clean local high (2 candles on each side)', () => {
    const candles = [
      candle('2026-01-01T00:00Z', 1.1, 1.08),
      candle('2026-01-01T01:00Z', 1.12, 1.09),
      candle('2026-01-01T02:00Z', 1.2, 1.15), // spike up
      candle('2026-01-01T03:00Z', 1.12, 1.09),
      candle('2026-01-01T04:00Z', 1.1, 1.08),
    ];
    const levels = calculateSupportResistanceLevels(candles, 'H1');
    expect(levels).toHaveLength(1);
    expect(levels[0]).toMatchObject({ type: 'RESISTANCE', price: 1.2, timeframe: 'H1', method: 'FRACTAL_PIVOT', touches: 1 });
  });

  it('identifies a single support pivot at a clean local low', () => {
    const candles = [
      candle('2026-01-01T00:00Z', 1.12, 1.1),
      candle('2026-01-01T01:00Z', 1.11, 1.09),
      candle('2026-01-01T02:00Z', 1.05, 1.0), // spike down
      candle('2026-01-01T03:00Z', 1.11, 1.09),
      candle('2026-01-01T04:00Z', 1.12, 1.1),
    ];
    const levels = calculateSupportResistanceLevels(candles, 'H1');
    expect(levels).toHaveLength(1);
    expect(levels[0]).toMatchObject({ type: 'SUPPORT', price: 1.0 });
  });

  it('a monotonic series (no local extremes) produces no levels', () => {
    const candles = Array.from({ length: 7 }, (_, i) => candle(`2026-01-01T0${i}:00Z`, 1.1 + i * 0.001, 1.09 + i * 0.001));
    expect(calculateSupportResistanceLevels(candles, 'H1')).toEqual([]);
  });

  it('merges two resistance pivots within the tolerance into one level with touches=2', () => {
    // Two spikes 5 points (0.00005) apart — within the 10-point merge tolerance.
    const candles = [
      candle('2026-01-01T00:00Z', 1.1, 1.08),
      candle('2026-01-01T01:00Z', 1.12, 1.09),
      candle('2026-01-01T02:00Z', 1.2, 1.15),
      candle('2026-01-01T03:00Z', 1.12, 1.09),
      candle('2026-01-01T04:00Z', 1.1, 1.08),
      candle('2026-01-01T05:00Z', 1.12, 1.09),
      candle('2026-01-01T06:00Z', 1.20005, 1.15), // second spike, 5 points from the first
      candle('2026-01-01T07:00Z', 1.12, 1.09),
      candle('2026-01-01T08:00Z', 1.1, 1.08),
    ];
    const levels = calculateSupportResistanceLevels(candles, 'H1').filter((l) => l.type === 'RESISTANCE');
    expect(levels).toHaveLength(1);
    expect(levels[0].touches).toBe(2);
  });

  it('does NOT merge two resistance pivots outside the tolerance', () => {
    const candles = [
      candle('2026-01-01T00:00Z', 1.1, 1.08),
      candle('2026-01-01T01:00Z', 1.12, 1.09),
      candle('2026-01-01T02:00Z', 1.2, 1.15),
      candle('2026-01-01T03:00Z', 1.12, 1.09),
      candle('2026-01-01T04:00Z', 1.1, 1.08),
      candle('2026-01-01T05:00Z', 1.12, 1.09),
      candle('2026-01-01T06:00Z', 1.25, 1.15), // 5000 points away — clearly outside tolerance
      candle('2026-01-01T07:00Z', 1.12, 1.09),
      candle('2026-01-01T08:00Z', 1.1, 1.08),
    ];
    const levels = calculateSupportResistanceLevels(candles, 'H1').filter((l) => l.type === 'RESISTANCE');
    expect(levels).toHaveLength(2);
  });
});

describe('findLevelsNearPrice', () => {
  it('returns levels within the threshold, sorted nearest-first', () => {
    const levels = [level({ price: 1.1004 }), level({ price: 1.1002 }), level({ price: 1.2 })];
    const matches = findLevelsNearPrice(levels, 1.1, 50); // 50 points = 0.0005
    expect(matches.map((m) => m.level.price)).toEqual([1.1002, 1.1004]);
  });

  it('excludes levels outside the threshold', () => {
    const levels = [level({ price: 1.2 })];
    expect(findLevelsNearPrice(levels, 1.1, 50)).toEqual([]);
  });

  it('reports whether the current price is above or below each matched level', () => {
    const levels = [level({ price: 1.1002 }), level({ price: 1.0998 })];
    const matches = findLevelsNearPrice(levels, 1.1, 50);
    const above = matches.find((m) => m.level.price === 1.0998);
    const below = matches.find((m) => m.level.price === 1.1002);
    expect(above?.currentPriceIsAbove).toBe(true);
    expect(below?.currentPriceIsAbove).toBe(false);
  });

  it('a price exactly at the threshold boundary is included (inclusive)', () => {
    const levels = [level({ price: 1.1005 })]; // exactly 50 points from 1.1
    expect(findLevelsNearPrice(levels, 1.1, 50)).toHaveLength(1);
  });

  it('reports trend UNKNOWN when no priorPrice is given (default, and every pre-Stage-3A caller)', () => {
    const matches = findLevelsNearPrice([level({ price: 1.1002 })], 1.1, 50);
    expect(matches[0].trend).toBe('UNKNOWN');
  });

  it('reports APPROACHING when price has moved closer to the level since priorPrice', () => {
    // Level at 1.1002 (above current 1.1). Price moved up from 1.0990 (120 points away) to 1.1 (20 points away) — closer.
    const matches = findLevelsNearPrice([level({ price: 1.1002 })], 1.1, 50, 1.099);
    expect(matches[0].trend).toBe('APPROACHING');
  });

  it('reports RETREATING when price has moved farther from the level since priorPrice', () => {
    // Level at 1.1002. Price moved from 1.1001 (10 points away) to 1.1 (20 points away) — farther.
    const matches = findLevelsNearPrice([level({ price: 1.1002 })], 1.1, 50, 1.1001);
    expect(matches[0].trend).toBe('RETREATING');
  });

  it('reports FLAT when the distance-to-level barely changed (within TREND_FLAT_TOLERANCE_POINTS)', () => {
    // Level at 1.1002. Distance was 19.9 points, now 20 points — 0.1 point change, well under the 1-point tolerance.
    const matches = findLevelsNearPrice([level({ price: 1.1002 })], 1.1, 50, 1.100001);
    expect(matches[0].trend).toBe('FLAT');
  });
});
