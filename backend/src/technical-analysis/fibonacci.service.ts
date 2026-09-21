import { CandleData } from '../market-data/historical-candle.service';

// Standard Fibonacci retracement ratios, centralized here rather than
// scattered as magic numbers through the code (user's own instruction).
export const FIBONACCI_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

export type FibonacciSwingDirection = 'BULLISH' | 'BEARISH';

export interface FibonacciLevel {
  ratio: (typeof FIBONACCI_RATIOS)[number];
  price: number;
}

export interface FibonacciAnalysis {
  swingHigh: { price: number; timestamp: Date };
  swingLow: { price: number; timestamp: Date };
  /** BULLISH = swing high is more recent than the swing low (an up-move being retraced downward); BEARISH = the reverse. */
  direction: FibonacciSwingDirection;
  levels: FibonacciLevel[];
  currentPrice: number;
  nearestLevel: FibonacciLevel;
}

/**
 * Deterministic swing selection (user's own explicit requirement — "do not
 * randomly choose a high and low"): the highest high and lowest low within
 * the supplied candle window (the caller passes an already-bounded lookback,
 * e.g. FIBONACCI_LOOKBACK days of D1 candles) — the standard, simplest
 * deterministic swing-detection method. Direction follows from which
 * extreme occurred more recently: if the high is the more recent of the
 * two, price most recently moved UP into it, so retracement is measured
 * DOWN from the high toward the low (BULLISH swing, now retracing); if the
 * low is more recent, the reverse (BEARISH swing, now retracing upward).
 * Pure — candles are already-fetched.
 */
export function calculateFibonacciAnalysis(candles: CandleData[], currentPrice: number): FibonacciAnalysis | null {
  if (candles.length === 0) return null;

  let swingHigh = candles[0];
  let swingLow = candles[0];
  for (const candle of candles) {
    if (candle.high > swingHigh.high) swingHigh = candle;
    if (candle.low < swingLow.low) swingLow = candle;
  }

  const range = swingHigh.high - swingLow.low;
  if (range <= 0) return null; // flat/insufficient data — nothing to measure

  const direction: FibonacciSwingDirection = swingHigh.openTime.getTime() >= swingLow.openTime.getTime() ? 'BULLISH' : 'BEARISH';

  const levels: FibonacciLevel[] = FIBONACCI_RATIOS.map((ratio) => ({
    ratio,
    price: direction === 'BULLISH' ? swingHigh.high - ratio * range : swingLow.low + ratio * range,
  }));

  const nearestLevel = levels.reduce((nearest, level) =>
    Math.abs(level.price - currentPrice) < Math.abs(nearest.price - currentPrice) ? level : nearest,
  );

  return {
    swingHigh: { price: swingHigh.high, timestamp: swingHigh.openTime },
    swingLow: { price: swingLow.low, timestamp: swingLow.openTime },
    direction,
    levels,
    currentPrice,
    nearestLevel,
  };
}
