import { CandleTimeframe } from '@prisma/client';
import { CandleData } from '../market-data/historical-candle.service';
import { priceDistanceInPoints } from './point-value';

export type LevelType = 'SUPPORT' | 'RESISTANCE';

export interface SupportResistanceLevel {
  timeframe: CandleTimeframe;
  type: LevelType;
  price: number;
  /** How this level was derived — always FRACTAL_PIVOT today; named explicitly so a future second method doesn't silently conflate with this one. */
  method: 'FRACTAL_PIVOT';
  /** When the (most recent, if merged) contributing pivot candle occurred. */
  timestamp: Date;
  /** How many nearby pivots were merged into this one level. */
  touches: number;
}

export type PriceTrend = 'APPROACHING' | 'RETREATING' | 'FLAT' | 'UNKNOWN';

export interface LevelProximityMatch {
  level: SupportResistanceLevel;
  distancePoints: number;
  /** Whether the current price is currently above or below this level. */
  currentPriceIsAbove: boolean;
  /**
   * Whether price has moved toward or away from this level since `priorPrice`
   * — UNKNOWN when the caller has no prior price to compare against (e.g.
   * too little recent candle history).
   */
  trend: PriceTrend;
}

// Stage 3A addition — how much the distance-to-level has to shrink/grow
// before it counts as real movement rather than sub-point close-price
// noise between two adjacent M5 candles. An implementation constant, not
// user-configurable, matching LEVEL_MERGE_TOLERANCE_POINTS's own precedent
// just above.
const TREND_FLAT_TOLERANCE_POINTS = 1;

function computeTrend(levelPrice: number, currentPrice: number, priorPrice: number | null, distanceNow: number): PriceTrend {
  if (priorPrice === null) return 'UNKNOWN';
  const distancePrior = priceDistanceInPoints(priorPrice, levelPrice);
  const distanceDelta = distancePrior - distanceNow; // positive => distance shrank => price moved toward the level
  if (Math.abs(distanceDelta) <= TREND_FLAT_TOLERANCE_POINTS) return 'FLAT';
  return distanceDelta > 0 ? 'APPROACHING' : 'RETREATING';
}

// User's Rule 1 spec: "meaningful" levels, not every micro-wiggle — a
// fractal pivot (TECHNICAL_ANALYSIS_SPEC.md §1) is the standard, simplest
// deterministic pivot-detection method: a candle whose high/low is the most
// extreme among itself and FRACTAL_WIDTH candles on each side. 2 is the
// conventional default (a 5-candle window) and is small enough to still
// find pivots on D1 data with a realistic lookback.
const FRACTAL_WIDTH = 2;

// A data-cleanliness constant, NOT the user's alert-proximity threshold
// (SUPPORT_RESISTANCE_PROXIMITY_POINTS, applied separately in
// findLevelsNearPrice below) — two fractal pivots a few points apart are
// the same real level, not two "meaningful" ones; merging them avoids
// reporting near-duplicate levels. Deliberately small and fixed (an
// implementation constant, not user-configurable) so it never interferes
// with the user's own proximity-alert threshold.
const LEVEL_MERGE_TOLERANCE_POINTS = 10;

interface RawPivot {
  price: number;
  timestamp: Date;
}

function findFractalPivots(candles: CandleData[]): { highs: RawPivot[]; lows: RawPivot[] } {
  const highs: RawPivot[] = [];
  const lows: RawPivot[] = [];

  for (let i = FRACTAL_WIDTH; i < candles.length - FRACTAL_WIDTH; i++) {
    const candle = candles[i];
    const window = candles.slice(i - FRACTAL_WIDTH, i + FRACTAL_WIDTH + 1);

    if (window.every((c) => c.high <= candle.high)) {
      highs.push({ price: candle.high, timestamp: candle.openTime });
    }
    if (window.every((c) => c.low >= candle.low)) {
      lows.push({ price: candle.low, timestamp: candle.openTime });
    }
  }

  return { highs, lows };
}

/** Collapses pivots within LEVEL_MERGE_TOLERANCE_POINTS of each other into one level (price-sorted, nearest-neighbor merge), keeping the most recent timestamp and a running touch count. */
function mergeNearbyPivots(pivots: RawPivot[], type: LevelType, timeframe: CandleTimeframe): SupportResistanceLevel[] {
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const merged: SupportResistanceLevel[] = [];

  for (const pivot of sorted) {
    const last = merged[merged.length - 1];
    if (last && priceDistanceInPoints(last.price, pivot.price) <= LEVEL_MERGE_TOLERANCE_POINTS) {
      last.price = (last.price * last.touches + pivot.price) / (last.touches + 1);
      last.touches += 1;
      if (pivot.timestamp > last.timestamp) last.timestamp = pivot.timestamp;
    } else {
      merged.push({ timeframe, type, price: pivot.price, method: 'FRACTAL_PIVOT', timestamp: pivot.timestamp, touches: 1 });
    }
  }

  return merged;
}

/**
 * Identifies support/resistance levels from real candle data for one
 * timeframe. Pure — the caller (rule evaluator, via buildExtras) supplies
 * already-fetched candles; no I/O here (TECHNICAL_ANALYSIS_SPEC.md §0's
 * purity convention, matching every rule-engine evaluator).
 */
export function calculateSupportResistanceLevels(candles: CandleData[], timeframe: CandleTimeframe): SupportResistanceLevel[] {
  if (candles.length < FRACTAL_WIDTH * 2 + 1) return [];

  const { highs, lows } = findFractalPivots(candles);
  return [
    ...mergeNearbyPivots(highs, 'RESISTANCE', timeframe),
    ...mergeNearbyPivots(lows, 'SUPPORT', timeframe),
  ].sort((a, b) => a.price - b.price);
}

/**
 * Levels within `proximityPoints` of `currentPrice` — the user's Rule 1
 * threshold, sorted nearest-first. `priorPrice` (Stage 3A addition) is an
 * earlier EURUSD price, used only to compute each match's `trend` —
 * optional and defaulted to `null` (-> `trend: 'UNKNOWN'`) so every existing
 * caller and test keeps working unchanged.
 */
export function findLevelsNearPrice(
  levels: SupportResistanceLevel[],
  currentPrice: number,
  proximityPoints: number,
  priorPrice: number | null = null,
): LevelProximityMatch[] {
  return levels
    .map((level) => {
      const distancePoints = priceDistanceInPoints(currentPrice, level.price);
      return {
        level,
        distancePoints,
        currentPriceIsAbove: currentPrice >= level.price,
        trend: computeTrend(level.price, currentPrice, priorPrice, distancePoints),
      };
    })
    .filter((match) => match.distancePoints <= proximityPoints)
    .sort((a, b) => a.distancePoints - b.distancePoints);
}
