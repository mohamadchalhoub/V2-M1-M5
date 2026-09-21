import { describe, expect, it } from 'vitest';
import { calculateAtr, calculateEma, H1_ATR_PERIOD, H4_EMA_FAST, H4_EMA_SLOW, isAtrSettled, isEmaSettled } from '../../src/trend-breakout/indicators';
import { CandleData } from '../../src/market-data/historical-candle.service';

function c(openTime: string, o: number, h: number, l: number, close: number): CandleData {
  return { openTime: new Date(openTime), open: o, high: h, low: l, close, volume: null };
}

describe('calculateEma', () => {
  it('is null before warm-up and a plain SMA-seeded EMA from the warm-up index onward', () => {
    const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const series = calculateEma(closes, { period: 3, settleMultiplier: 1 });
    expect(series[0]).toBeNull();
    expect(series[1]).toBeNull();
    // Seed at index 2 = SMA(1,2,3) = 2
    expect(series[2]).toBeCloseTo(2, 10);
    // alpha = 2/4 = 0.5; EMA[3] = 4*0.5 + 2*0.5 = 3
    expect(series[3]).toBeCloseTo(3, 10);
    // EMA[4] = 5*0.5 + 3*0.5 = 4
    expect(series[4]).toBeCloseTo(4, 10);
  });

  it('is entirely null when there are fewer candles than the period', () => {
    const series = calculateEma([1, 2], { period: 5, settleMultiplier: 1 });
    expect(series.every((v) => v === null)).toBe(true);
  });
});

describe('isEmaSettled', () => {
  it("requires period * settleMultiplier bars, not just `period`, for EMA200's 5x settle buffer", () => {
    expect(isEmaSettled(H4_EMA_SLOW.period - 1, H4_EMA_SLOW)).toBe(false); // just computable, not settled
    expect(isEmaSettled(H4_EMA_SLOW.period * H4_EMA_SLOW.settleMultiplier - 2, H4_EMA_SLOW)).toBe(false);
    expect(isEmaSettled(H4_EMA_SLOW.period * H4_EMA_SLOW.settleMultiplier - 1, H4_EMA_SLOW)).toBe(true);
  });

  it('EMA50 settles at a much shorter warm-up than EMA200', () => {
    const requiredForFast = H4_EMA_FAST.period * H4_EMA_FAST.settleMultiplier;
    const requiredForSlow = H4_EMA_SLOW.period * H4_EMA_SLOW.settleMultiplier;
    expect(requiredForFast).toBeLessThan(requiredForSlow);
  });
});

describe('calculateAtr (Wilder smoothing)', () => {
  it('matches a hand-computed Wilder ATR on a small fixed example', () => {
    // 5 candles, period 3. TR[0] = high-low (no prior close, by convention).
    const candles = [
      c('2026-01-01T00:00Z', 10, 12, 8, 10), // TR = 4
      c('2026-01-01T01:00Z', 10, 13, 9, 11), // TR = max(4, |13-10|=3, |9-10|=1) = 4
      c('2026-01-01T02:00Z', 11, 14, 10, 12), // TR = max(4, |14-11|=3, |10-11|=1) = 4
      c('2026-01-01T03:00Z', 12, 20, 11, 19), // TR = max(9, |20-12|=8, |11-12|=1) = 9
      c('2026-01-01T04:00Z', 19, 21, 18, 20), // TR = max(3, |21-19|=2, |18-19|=1) = 3
    ];
    const atr = calculateAtr(candles, 3);
    expect(atr[0]).toBeNull();
    expect(atr[1]).toBeNull();
    // seed = avg(TR[0..2]) = avg(4,4,4) = 4
    expect(atr[2]).toBeCloseTo(4, 10);
    // ATR[3] = (4*2 + 9) / 3 = 17/3
    expect(atr[3]).toBeCloseTo(17 / 3, 10);
    // ATR[4] = ((17/3)*2 + 3) / 3
    expect(atr[4]).toBeCloseTo((17 / 3) * (2 / 3) + 3 / 3, 6);
  });

  it('defaults to the 14-period Wilder ATR', () => {
    const candles = Array.from({ length: 20 }, (_, i) => c(`2026-01-01T${String(i).padStart(2, '0')}:00Z`, 1, 1.001, 0.999, 1));
    const atr = calculateAtr(candles);
    expect(atr[H1_ATR_PERIOD - 2]).toBeNull();
    expect(atr[H1_ATR_PERIOD - 1]).not.toBeNull();
  });
});

describe('isAtrSettled', () => {
  it('requires 3x the ATR period by default', () => {
    expect(isAtrSettled(H1_ATR_PERIOD * 3 - 2)).toBe(false);
    expect(isAtrSettled(H1_ATR_PERIOD * 3 - 1)).toBe(true);
  });
});
