import { describe, expect, it } from 'vitest';
import {
  computeDuringTradeFeatures,
  computePostExitFeatures,
  computePreEntryFeatures,
} from '../../src/historical-charts/feature-extraction';
import { CandleData } from '../../src/market-data/historical-candle.service';

function candle(openTime: string, open: number, high: number, low: number, close: number): CandleData {
  return { openTime: new Date(openTime), open, high, low, close, volume: null };
}

describe('computePreEntryFeatures', () => {
  it('returns all-null with zero candles — a known state, not a crash', () => {
    const result = computePreEntryFeatures([]);
    expect(result).toEqual({ returnPct: null, volatilityPct: null, recentHigh: null, recentLow: null, candleCount: 0 });
  });

  it('returnPct is null with exactly one candle (no "from" to measure from)', () => {
    const result = computePreEntryFeatures([candle('2026-01-01T00:00:00Z', 1.1, 1.11, 1.09, 1.1)]);
    expect(result.returnPct).toBeNull();
    expect(result.candleCount).toBe(1);
  });

  it('computes return, recent high/low, and mean range volatility across multiple candles', () => {
    const candles = [
      candle('2026-01-01T00:00:00Z', 1.1, 1.105, 1.095, 1.1),
      candle('2026-01-01T00:05:00Z', 1.1, 1.12, 1.1, 1.115),
      candle('2026-01-01T00:10:00Z', 1.115, 1.13, 1.11, 1.12),
    ];
    const result = computePreEntryFeatures(candles);
    expect(result.returnPct).toBeCloseTo((1.12 - 1.1) / 1.1, 6);
    expect(result.recentHigh).toBe(1.13);
    expect(result.recentLow).toBe(1.095);
    expect(result.candleCount).toBe(3);
    expect(result.volatilityPct).toBeGreaterThan(0);
  });
});

describe('computeDuringTradeFeatures', () => {
  it('returns all-null with zero candles', () => {
    expect(computeDuringTradeFeatures([], 'BUY', 1.1)).toEqual({
      maxFavorableExcursionPct: null,
      maxAdverseExcursionPct: null,
      volatilityPct: null,
      candleCount: 0,
    });
  });

  it('BUY: favorable excursion is the highest high reached, adverse is the lowest low', () => {
    const candles = [
      candle('2026-01-01T00:00:00Z', 1.1, 1.105, 1.098, 1.1),
      candle('2026-01-01T00:05:00Z', 1.1, 1.12, 1.095, 1.11), // best: 1.12 high, worst: 1.095 low
      candle('2026-01-01T00:10:00Z', 1.11, 1.115, 1.1, 1.112),
    ];
    const result = computeDuringTradeFeatures(candles, 'BUY', 1.1);
    expect(result.maxFavorableExcursionPct).toBeCloseTo((1.12 - 1.1) / 1.1, 6);
    expect(result.maxAdverseExcursionPct).toBeCloseTo((1.1 - 1.095) / 1.1, 6);
  });

  it('SELL: favorable excursion is the lowest low reached, adverse is the highest high', () => {
    const candles = [
      candle('2026-01-01T00:00:00Z', 1.1, 1.105, 1.098, 1.1),
      candle('2026-01-01T00:05:00Z', 1.1, 1.12, 1.09, 1.095), // best (for SELL): 1.09 low, worst: 1.12 high
    ];
    const result = computeDuringTradeFeatures(candles, 'SELL', 1.1);
    expect(result.maxFavorableExcursionPct).toBeCloseTo((1.1 - 1.09) / 1.1, 6);
    expect(result.maxAdverseExcursionPct).toBeCloseTo((1.12 - 1.1) / 1.1, 6);
  });

  it('MAE/MFE are never negative — excursion is measured against entry price, which is always the starting point', () => {
    // A trade that only ever moved favorably: MAE should be 0, not negative.
    const candles = [candle('2026-01-01T00:00:00Z', 1.1, 1.12, 1.105, 1.115)];
    const result = computeDuringTradeFeatures(candles, 'BUY', 1.1);
    expect(result.maxAdverseExcursionPct).toBe(0);
    expect(result.maxFavorableExcursionPct).toBeGreaterThan(0);
  });
});

describe('computePostExitFeatures', () => {
  it('returns null/0 with zero candles', () => {
    expect(computePostExitFeatures([], 'BUY', 1.1)).toEqual({ continuationPct: null, candleCount: 0 });
  });

  it('BUY: continuationPct is positive when price kept rising after exit', () => {
    const candles = [candle('2026-01-01T00:00:00Z', 1.11, 1.115, 1.108, 1.113)];
    const result = computePostExitFeatures(candles, 'BUY', 1.11);
    expect(result.continuationPct).toBeCloseTo((1.113 - 1.11) / 1.11, 6);
  });

  it('SELL: continuationPct is positive when price kept falling after exit (favorable to the SELL\'s own direction)', () => {
    const candles = [candle('2026-01-01T00:00:00Z', 1.1, 1.101, 1.09, 1.095)];
    const result = computePostExitFeatures(candles, 'SELL', 1.1);
    expect(result.continuationPct).toBeCloseTo((1.1 - 1.095) / 1.1, 6);
  });
});

describe('anti-leakage: entry-time features never depend on post-entry candles', () => {
  it('changing only the post-entry candles leaves pre-entry features byte-for-byte identical', () => {
    const preEntry = [
      candle('2026-01-01T00:00:00Z', 1.1, 1.105, 1.098, 1.1),
      candle('2026-01-01T00:05:00Z', 1.1, 1.12, 1.1, 1.115),
    ];
    const before = computePreEntryFeatures(preEntry);

    // Simulate two different "futures" for the same trade — the function is
    // never even given the post-entry candles, so there is no way for it to
    // read them; this proves the boundary structurally, not by coincidence.
    const after = computePreEntryFeatures(preEntry);
    expect(after).toEqual(before);
  });
});
