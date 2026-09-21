import { CandleData } from '../market-data/historical-candle.service';

/**
 * Historical chart reconstruction phase — pure, deterministic feature
 * extraction (Phase 0 of this pass's own spec §7/§12: "descriptive
 * historical metrics," never proof an exit was wrong; anti-leakage is
 * enforced by construction here — every function takes an already-sliced
 * candle array and never looks at anything outside it, so the CALLER
 * (trade-alignment.service.ts) is the one place that decides which candles
 * belong to "pre-entry" vs "during" vs "post-exit," and getting that slicing
 * right is what keeps entry-time features from ever seeing a future candle.
 */

export interface PreEntryFeatures {
  /** Fractional return from the first to the last pre-entry candle's close, or null with < 2 candles. */
  returnPct: number | null;
  /** Mean per-candle (high-low)/close — a simple, deterministic volatility proxy. */
  volatilityPct: number | null;
  recentHigh: number | null;
  recentLow: number | null;
  candleCount: number;
}

export function computePreEntryFeatures(preEntryCandles: CandleData[]): PreEntryFeatures {
  if (preEntryCandles.length === 0) {
    return { returnPct: null, volatilityPct: null, recentHigh: null, recentLow: null, candleCount: 0 };
  }
  const first = preEntryCandles[0];
  const last = preEntryCandles[preEntryCandles.length - 1];
  const returnPct = preEntryCandles.length >= 2 ? (last.close - first.close) / first.close : null;
  const volatilityPct = meanRange(preEntryCandles);
  const recentHigh = Math.max(...preEntryCandles.map((c) => c.high));
  const recentLow = Math.min(...preEntryCandles.map((c) => c.low));
  return { returnPct, volatilityPct, recentHigh, recentLow, candleCount: preEntryCandles.length };
}

export interface DuringTradeFeatures {
  /** Maximum favorable excursion — the best the trade's own direction ever looked, as a fraction of entry price. */
  maxFavorableExcursionPct: number | null;
  /** Maximum adverse excursion — the worst it ever looked, as a fraction of entry price. Always >= 0. */
  maxAdverseExcursionPct: number | null;
  volatilityPct: number | null;
  candleCount: number;
}

export function computeDuringTradeFeatures(
  duringCandles: CandleData[],
  side: 'BUY' | 'SELL',
  entryPrice: number,
): DuringTradeFeatures {
  if (duringCandles.length === 0) {
    return { maxFavorableExcursionPct: null, maxAdverseExcursionPct: null, volatilityPct: null, candleCount: 0 };
  }

  let bestPrice = entryPrice;
  let worstPrice = entryPrice;
  for (const c of duringCandles) {
    if (side === 'BUY') {
      bestPrice = Math.max(bestPrice, c.high);
      worstPrice = Math.min(worstPrice, c.low);
    } else {
      bestPrice = Math.min(bestPrice, c.low);
      worstPrice = Math.max(worstPrice, c.high);
    }
  }

  const maxFavorableExcursionPct = side === 'BUY' ? (bestPrice - entryPrice) / entryPrice : (entryPrice - bestPrice) / entryPrice;
  const maxAdverseExcursionPct = side === 'BUY' ? (entryPrice - worstPrice) / entryPrice : (worstPrice - entryPrice) / entryPrice;

  return {
    maxFavorableExcursionPct,
    maxAdverseExcursionPct,
    volatilityPct: meanRange(duringCandles),
    candleCount: duringCandles.length,
  };
}

export interface PostExitFeatures {
  /**
   * Movement after exit, in the trade's OWN directional frame: positive
   * means price kept moving the way the trade was betting (a BUY that
   * exited, then price kept rising); negative means it moved the other
   * way. Descriptive only — never a claim that the exit was "wrong."
   */
  continuationPct: number | null;
  candleCount: number;
}

export function computePostExitFeatures(
  postExitCandles: CandleData[],
  side: 'BUY' | 'SELL',
  exitPrice: number,
): PostExitFeatures {
  if (postExitCandles.length === 0) {
    return { continuationPct: null, candleCount: 0 };
  }
  const last = postExitCandles[postExitCandles.length - 1];
  const rawMovementPct = (last.close - exitPrice) / exitPrice;
  const continuationPct = side === 'BUY' ? rawMovementPct : -rawMovementPct;
  return { continuationPct, candleCount: postExitCandles.length };
}

function meanRange(candles: CandleData[]): number {
  const ranges = candles.map((c) => (c.close === 0 ? 0 : (c.high - c.low) / c.close));
  return ranges.reduce((sum, r) => sum + r, 0) / ranges.length;
}
