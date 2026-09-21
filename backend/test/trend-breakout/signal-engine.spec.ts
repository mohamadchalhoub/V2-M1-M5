import { describe, expect, it } from 'vitest';
import { CandleData } from '../../src/market-data/historical-candle.service';
import { calculateAtr, calculateEma, H4_EMA_FAST, H4_EMA_SLOW } from '../../src/trend-breakout/indicators';
import { BREAKOUT_LOOKBACK_BARS, evaluateTrendBreakoutSignal } from '../../src/trend-breakout/signal-engine';

function h4(openTimeMs: number, close: number): CandleData {
  return { openTime: new Date(openTimeMs), open: close, high: close + 0.0005, low: close - 0.0005, close, volume: null };
}

/** A long, steadily rising H4 series — after warm-up, close > EMA200 and EMA50 > EMA200 (a clean, unambiguous bullish regime). */
function bullishH4Candles(count: number): CandleData[] {
  const start = new Date('2020-01-01T00:00:00Z').getTime();
  const candles: CandleData[] = [];
  for (let i = 0; i < count; i++) {
    candles.push(h4(start + i * 4 * 3600_000, 1.0 + i * 0.0002));
  }
  return candles;
}
/** Mirror: a long, steadily falling H4 series for a bearish regime. */
function bearishH4Candles(count: number): CandleData[] {
  const start = new Date('2020-01-01T00:00:00Z').getTime();
  const candles: CandleData[] = [];
  for (let i = 0; i < count; i++) {
    candles.push(h4(start + i * 4 * 3600_000, 2.0 - i * 0.0002));
  }
  return candles;
}

function h1(openTimeMs: number, o: number, hh: number, l: number, close: number): CandleData {
  return { openTime: new Date(openTimeMs), open: o, high: hh, low: l, close, volume: null };
}

/** A flat, tightly-ranging H1 series (all within [99.9, 100.1]) long enough to settle ATR and provide a stable 20-bar range, followed by caller-supplied additional candles (e.g. the signal candle). */
function flatH1Candles(warmupCount: number, extra: CandleData[] = []): CandleData[] {
  const start = new Date('2026-01-05T00:00:00Z').getTime(); // a Monday, clear of any weekend edge cases
  const candles: CandleData[] = [];
  for (let i = 0; i < warmupCount; i++) {
    const base = 100 + (i % 2 === 0 ? 0.02 : -0.02); // small oscillation, deterministic
    candles.push(h1(start + i * 3600_000, base, base + 0.03, base - 0.03, base));
  }
  return [...candles, ...extra.map((c, i) => ({ ...c, openTime: new Date(start + (warmupCount + i) * 3600_000) }))];
}

const MIN_H1_WARMUP = 60; // comfortably above ATR settle (42) and breakout lookback+2 (22)

describe('evaluateTrendBreakoutSignal', () => {
  it('HOLDs with a specific reason when H4 warm-up is insufficient', () => {
    const result = evaluateTrendBreakoutSignal({ h4Candles: bullishH4Candles(10), h1Candles: flatH1Candles(MIN_H1_WARMUP) });
    expect(result.direction).toBeNull();
    expect(result.gateResults.find((g) => g.gate === 'h4_warmup')?.passed).toBe(false);
  });

  it('HOLDs with no clear trend regime when H4 close/EMA50/EMA200 disagree', () => {
    // An oscillating H4 series (sine wave) — scanned (using the real
    // calculateEma, not hand-derived numbers) for an index past warm-up
    // where neither the bullish nor bearish regime condition holds, i.e. a
    // genuine disagreement between the latest close, EMA50, and EMA200.
    const start = new Date('2020-01-01T00:00:00Z').getTime();
    const closes = Array.from({ length: 1400 }, (_, i) => 1.1 + 0.05 * Math.sin(i / 60));
    const ema50 = calculateEma(closes, H4_EMA_FAST);
    const ema200 = calculateEma(closes, H4_EMA_SLOW);
    const minIndex = H4_EMA_SLOW.period * H4_EMA_SLOW.settleMultiplier - 1;
    let ambiguousIndex = -1;
    for (let i = minIndex; i < closes.length; i++) {
      const bullish = closes[i] > ema200[i]! && ema50[i]! > ema200[i]!;
      const bearish = closes[i] < ema200[i]! && ema50[i]! < ema200[i]!;
      if (!bullish && !bearish) {
        ambiguousIndex = i;
        break;
      }
    }
    expect(ambiguousIndex).toBeGreaterThan(-1); // sanity: the oscillating series must actually produce a disagreement somewhere

    const flatH4 = closes.slice(0, ambiguousIndex + 1).map((c, i) => h4(start + i * 4 * 3600_000, c));
    const result = evaluateTrendBreakoutSignal({ h4Candles: flatH4, h1Candles: flatH1Candles(MIN_H1_WARMUP) });
    expect(result.direction).toBeNull();
    expect(result.gateResults.find((g) => g.gate === 'h4_trend')?.passed).toBe(false);
  });

  it('identifies a BUY: bullish H4 regime + fresh H1 breakout above the preceding 20-bar high, ATR range ok', () => {
    const h4Candles = bullishH4Candles(1050);
    const warmup = flatH1Candles(MIN_H1_WARMUP);
    // ATR through the candle immediately preceding S (this flat series' true range is a steady ~0.07, so 2xA ~ 0.14 — S's own range below must stay comfortably under that):
    const atrSeries = calculateAtr(warmup);
    const atr = atrSeries.at(-1)!;
    const lastTime = warmup.at(-1)!.openTime.getTime();
    // S breaks clearly above the 100.05 range high, with a small range (well under 2*A).
    const s = h1(lastTime + 3600_000, 100.06, 100.09, 100.06, 100.08);
    const h1Candles = [...warmup, s];

    const result = evaluateTrendBreakoutSignal({ h4Candles, h1Candles });
    expect(result.direction).toBe('BUY');
    expect(result.atr).toBeCloseTo(atr, 10);
    expect(result.h1!.rangeHigh).toBeCloseTo(100.05, 6); // the 20-bar high EXCLUDING S
    expect(result.gateResults.every((g) => g.passed)).toBe(true);
  });

  it('identifies a SELL symmetrically in a bearish regime', () => {
    const h4Candles = bearishH4Candles(1050);
    const warmup = flatH1Candles(MIN_H1_WARMUP);
    const lastTime = warmup.at(-1)!.openTime.getTime();
    const s = h1(lastTime + 3600_000, 99.94, 99.94, 99.91, 99.92); // breaks below the 99.95 range low, small range
    const h1Candles = [...warmup, s];

    const result = evaluateTrendBreakoutSignal({ h4Candles, h1Candles });
    expect(result.direction).toBe('SELL');
  });

  it('excludes the signal candle S itself from its own 20-bar breakout range', () => {
    const h4Candles = bullishH4Candles(1050);
    const warmup = flatH1Candles(MIN_H1_WARMUP);
    const lastTime = warmup.at(-1)!.openTime.getTime();
    // S has an enormous high, but that must NOT leak into "the preceding 20-bar high" used to judge IT.
    const s = h1(lastTime + 3600_000, 100.05, 105, 100.05, 100.2);
    const result = evaluateTrendBreakoutSignal({ h4Candles, h1Candles: [...warmup, s] });
    expect(result.h1!.rangeHigh).toBeLessThan(101); // not 105 — S's own high never entered the range calc
  });

  it('rejects a PERSISTENT breakout (condition 4): no fresh signal when the previous H1 candle already broke its own prior range', () => {
    const h4Candles = bullishH4Candles(1050);
    const warmup = flatH1Candles(MIN_H1_WARMUP);
    const lastTime = warmup.at(-1)!.openTime.getTime();
    // The PREVIOUS candle already closed above ITS OWN preceding-20 high...
    const prev = h1(lastTime + 3600_000, 100.05, 100.3, 100.05, 100.3);
    // ...and S continues even higher — still technically > S's own preceding-20 high (which now includes `prev`), but not a FRESH breakout.
    const s = h1(lastTime + 2 * 3600_000, 100.35, 100.5, 100.3, 100.45);
    const result = evaluateTrendBreakoutSignal({ h4Candles, h1Candles: [...warmup, prev, s] });
    expect(result.direction).toBeNull();
    expect(result.gateResults.find((g) => g.gate === 'fresh_breakout')?.passed).toBe(false);
  });

  it('allows a FRESH breakout immediately following a non-breakout previous candle', () => {
    const h4Candles = bullishH4Candles(1050);
    const warmup = flatH1Candles(MIN_H1_WARMUP);
    const lastTime = warmup.at(-1)!.openTime.getTime();
    // Previous candle stays INSIDE the range (no breakout).
    const prev = h1(lastTime + 3600_000, 100.0, 100.02, 99.98, 100.0);
    const s = h1(lastTime + 2 * 3600_000, 100.06, 100.08, 100.05, 100.07);
    const result = evaluateTrendBreakoutSignal({ h4Candles, h1Candles: [...warmup, prev, s] });
    expect(result.direction).toBe('BUY');
  });

  it('rejects (condition 5) when S’s own range exceeds 2 x frozen ATR', () => {
    const h4Candles = bullishH4Candles(1050);
    const warmup = flatH1Candles(MIN_H1_WARMUP);
    const lastTime = warmup.at(-1)!.openTime.getTime();
    // A huge-range signal candle — breaks out, but its own range is enormous relative to the tiny ATR this flat series produces.
    const s = h1(lastTime + 3600_000, 100.05, 102, 99, 100.2);
    const result = evaluateTrendBreakoutSignal({ h4Candles, h1Candles: [...warmup, s] });
    expect(result.direction).toBeNull();
    expect(result.gateResults.find((g) => g.gate === 'atr_range_filter')?.passed).toBe(false);
  });

  it('uses strict inequality: a breakout exactly AT the range high does not qualify', () => {
    const h4Candles = bullishH4Candles(1050);
    const warmup = flatH1Candles(MIN_H1_WARMUP);
    const lastTime = warmup.at(-1)!.openTime.getTime();
    const rangeCandles = warmup.slice(-BREAKOUT_LOOKBACK_BARS);
    const rangeHigh = Math.max(...rangeCandles.map((c) => c.high));
    const s = h1(lastTime + 3600_000, rangeHigh, rangeHigh, rangeHigh - 0.01, rangeHigh); // close === rangeHigh exactly
    const result = evaluateTrendBreakoutSignal({ h4Candles, h1Candles: [...warmup, s] });
    expect(result.direction).toBeNull();
    expect(result.gateResults.find((g) => g.gate === 'h1_breakout')?.passed).toBe(false);
  });
});
