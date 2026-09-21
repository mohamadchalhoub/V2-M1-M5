import { CandleData } from '../market-data/historical-candle.service';

/**
 * §5 — "Define the EMA/ATR initialization and required warm-up explicitly.
 * Use the same implementation in backtesting and operation." Both functions
 * below are the ONLY implementation of each indicator anywhere in the
 * trend-breakout strategy — the live signal-engine call path and the
 * backtest both import these same functions, never a re-derived copy.
 *
 * Every function here is pure (no I/O, no Date.now()) and returns one value
 * PER INPUT CANDLE, aligned by index, with `null` for every index that is
 * still within the indicator's own warm-up period — a caller can zip the
 * result back against the original candle array without an off-by-one.
 */

export interface EmaConfig {
  period: number;
  /**
   * How many multiples of `period` must exist before an EMA value is
   * considered SETTLED enough to trade on, not merely computable. An
   * SMA-seeded EMA is technically defined starting at index `period - 1`,
   * but the seed's own influence decays slowly (recursively, never fully to
   * zero) — computable is not the same as trustworthy. 5x period is a
   * commonly used convergence heuristic (roughly the point an EMA's
   * remaining seed-weight has decayed under ~1%) and is used here as an
   * explicit, documented choice, not a guess-and-see default: for EMA200
   * this requires 1000 H4 candles (~166 days) of history before the FIRST
   * signal may ever be evaluated — "require adequate historical warm-up...
   * do not trade on partially initialized indicators" (§5).
   */
  settleMultiplier: number;
}

export const H4_EMA_FAST: EmaConfig = { period: 50, settleMultiplier: 5 };
export const H4_EMA_SLOW: EmaConfig = { period: 200, settleMultiplier: 5 };
// ATR converges much faster than an EMA of the same period (Wilder
// smoothing's alpha = 1/period vs. EMA's 2/(period+1) is a slower-moving
// average, but is applied to True Range, a naturally mean-reverting series
// with no long-memory trend component the way price itself has) — 3x
// period is this project's own explicit, documented (not silently
// different) choice for "settled," short of the 5x used for the trend EMAs.
export const H1_ATR_PERIOD = 14;
export const H1_ATR_SETTLE_MULTIPLIER = 3;

/**
 * EMA seeded with a plain SMA of the first `period` closes (the standard,
 * most common EMA initialization) — index `period - 1` is the first
 * computable value; every earlier index is `null` (undefined, not zero —
 * never treated as "EMA equals zero").
 */
export function calculateEma(closes: number[], config: EmaConfig): (number | null)[] {
  const { period } = config;
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return result;

  const alpha = 2 / (period + 1);
  const seed = average(closes.slice(0, period));
  result[period - 1] = seed;

  let prev = seed;
  for (let i = period; i < closes.length; i++) {
    const value = closes[i] * alpha + prev * (1 - alpha);
    result[i] = value;
    prev = value;
  }
  return result;
}

/** Index `i` is SETTLED (trustworthy, not merely computable) once at least `period * settleMultiplier` closes have fed into it — i.e. `i >= period * settleMultiplier - 1`. */
export function isEmaSettled(index: number, config: EmaConfig): boolean {
  return index >= config.period * config.settleMultiplier - 1;
}

function average(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * True Range for candle `i` — the standard three-way max, using the
 * PREVIOUS candle's close. Candle 0 has no previous close, so its TR is
 * documented here as simply its own high-low range (the universal
 * convention when no prior bar exists — there is no gap component to
 * measure yet).
 */
function trueRange(candles: CandleData[], i: number): number {
  const c = candles[i];
  if (i === 0) return c.high - c.low;
  const prevClose = candles[i - 1].close;
  return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
}

/**
 * ATR with Wilder smoothing (§5's explicit requirement — NOT a plain SMA or
 * an EMA-of-TR with the standard 2/(N+1) alpha, both of which are common
 * but different indicators). The first ATR value (index `period - 1`) is
 * seeded as the simple average of the first `period` True Range values;
 * every subsequent value follows Wilder's own recurrence
 * `ATR_i = (ATR_{i-1} * (period - 1) + TR_i) / period` — equivalent to an
 * EMA with alpha = 1/period, deliberately different from `calculateEma`
 * above (which always uses alpha = 2/(period+1)) because that IS what
 * "Wilder smoothing" specifically means, not an arbitrary implementation
 * choice.
 */
export function calculateAtr(candles: CandleData[], period: number = H1_ATR_PERIOD): (number | null)[] {
  const result: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period) return result;

  const trueRanges = candles.map((_, i) => trueRange(candles, i));
  const seed = average(trueRanges.slice(0, period));
  result[period - 1] = seed;

  let prev = seed;
  for (let i = period; i < candles.length; i++) {
    const value = (prev * (period - 1) + trueRanges[i]) / period;
    result[i] = value;
    prev = value;
  }
  return result;
}

export function isAtrSettled(index: number, period: number = H1_ATR_PERIOD, settleMultiplier: number = H1_ATR_SETTLE_MULTIPLIER): boolean {
  return index >= period * settleMultiplier - 1;
}
