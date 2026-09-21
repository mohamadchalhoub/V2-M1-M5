import { describe, expect, it } from 'vitest';
import { calculateIchimokuState, detectIchimokuBreakout } from '../../src/technical-analysis/ichimoku.service';
import { CandleData } from '../../src/market-data/historical-candle.service';

function candle(index: number, high: number, low: number, close?: number): CandleData {
  const openTime = new Date(Date.UTC(2026, 0, 1, index)); // one candle per hour, arbitrary but strictly increasing
  return { openTime, open: (high + low) / 2, high, low, close: close ?? (high + low) / 2, volume: null };
}

/**
 * A flat baseline (constant high/low) makes the Ichimoku cloud constant
 * (spanA = spanB = midpoint) for every index once the 52-period Senkou B
 * window is fully inside the flat region — lets a test control exactly
 * where price sits relative to the cloud without hand-computing a moving
 * cloud value.
 */
function flatBaseline(count: number, high = 1.1, low = 1.09): CandleData[] {
  return Array.from({ length: count }, (_, i) => candle(i, high, low));
}

const CLOUD_MIDPOINT = (1.1 + 1.09) / 2; // 1.095

/**
 * A one-time price-level step (26 flat candles at 1.00, then 51 flat
 * candles at 1.20 — indices 0-76) produces a real, non-degenerate
 * Ichimoku cloud at indices 77-78: Tenkan(9)/Kijun(26) fall entirely in
 * the post-step region (both = 1.20, so spanA = 1.20), while Senkou
 * B(52)'s wider window still spans the step (high 1.20 / low 1.00, so
 * spanB = 1.10) — hand-verified by the window math, not by inspection.
 */
function stepCloudBaseline(): CandleData[] {
  const lowStep = Array.from({ length: 26 }, (_, i) => candle(i, 1.0, 1.0));
  const highStep = Array.from({ length: 51 }, (_, i) => candle(26 + i, 1.2, 1.2));
  return [...lowStep, ...highStep];
}

describe('calculateIchimokuState', () => {
  it('INSUFFICIENT_DATA with fewer than 78 candles (26 displacement + 52 Senkou B period)', () => {
    const state = calculateIchimokuState(flatBaseline(50), 'H1');
    expect(state.position).toBe('INSUFFICIENT_DATA');
    expect(state.spanA).toBeNull();
  });

  it('ABOVE_CLOUD when the latest close is above a flat cloud', () => {
    const candles = [...flatBaseline(100), candle(100, 1.101, 1.099, 1.1)]; // 1.1 > 1.095
    const state = calculateIchimokuState(candles, 'H1');
    expect(state.position).toBe('ABOVE_CLOUD');
    expect(state.spanA).toBeCloseTo(CLOUD_MIDPOINT, 6);
    expect(state.spanB).toBeCloseTo(CLOUD_MIDPOINT, 6);
  });

  it('BELOW_CLOUD when the latest close is below a flat cloud', () => {
    const candles = [...flatBaseline(100), candle(100, 1.091, 1.089, 1.09)]; // 1.09 < 1.095
    expect(calculateIchimokuState(candles, 'H1').position).toBe('BELOW_CLOUD');
  });

  it('INSIDE_CLOUD when the latest close sits between spanA and spanB', () => {
    const candles = [...stepCloudBaseline(), candle(77, 1.15, 1.15, 1.15)];
    const state = calculateIchimokuState(candles, 'H1');
    // Hand-verified from stepCloudBaseline()'s construction: spanA=1.20, spanB=1.10 at index 77.
    expect(state.spanA).toBeCloseTo(1.2, 6);
    expect(state.spanB).toBeCloseTo(1.1, 6);
    expect(state.position).toBe('INSIDE_CLOUD');
  });
});

describe('detectIchimokuBreakout', () => {
  it('null with fewer than 2 candles', () => {
    expect(detectIchimokuBreakout([candle(0, 1.1, 1.09)], 'H1')).toBeNull();
  });

  it('null when insufficient history for the cloud at either compared index', () => {
    expect(detectIchimokuBreakout(flatBaseline(50), 'H1')).toBeNull();
  });

  it('detects a confirmed BULLISH breakout — prior close below the cloud, latest close above it', () => {
    const candles = [...flatBaseline(100), candle(100, 1.095, 1.093, 1.094), candle(101, 1.101, 1.099, 1.1)];
    const breakout = detectIchimokuBreakout(candles, 'H1');
    expect(breakout).toMatchObject({
      direction: 'BULLISH',
      previousState: 'BELOW_CLOUD',
      newState: 'ABOVE_CLOUD',
      breakoutPrice: 1.1,
    });
  });

  it('detects a confirmed BEARISH breakout — prior close above the cloud, latest close below it', () => {
    const candles = [...flatBaseline(100), candle(100, 1.101, 1.099, 1.1), candle(101, 1.091, 1.089, 1.09)];
    const breakout = detectIchimokuBreakout(candles, 'H1');
    expect(breakout).toMatchObject({ direction: 'BEARISH', previousState: 'ABOVE_CLOUD', newState: 'BELOW_CLOUD' });
  });

  it('no breakout when the cloud-side is unchanged between the two closes', () => {
    const candles = [...flatBaseline(100), candle(100, 1.101, 1.099, 1.1), candle(101, 1.102, 1.1, 1.101)];
    expect(detectIchimokuBreakout(candles, 'H1')).toBeNull();
  });

  it('entering the cloud (ABOVE -> INSIDE) is not a confirmed breakout', () => {
    // Hand-verified: the cloud is stable at spanA=1.20/spanB=1.10 across
    // indices 77-78 (stepCloudBaseline's transition is far enough back in
    // both windows). Prior close 1.25 is above the band (ABOVE_CLOUD);
    // latest close 1.15 sits inside it (INSIDE_CLOUD) — never crosses to
    // BELOW, so this must not register as a breakout.
    const candles = [...stepCloudBaseline(), candle(77, 1.25, 1.25, 1.25), candle(78, 1.15, 1.15, 1.15)];
    const state77 = calculateIchimokuState(candles.slice(0, 78), 'H1');
    const state78 = calculateIchimokuState(candles, 'H1');
    expect(state77.position).toBe('ABOVE_CLOUD');
    expect(state78.position).toBe('INSIDE_CLOUD');
    expect(detectIchimokuBreakout(candles, 'H1')).toBeNull();
  });
});
