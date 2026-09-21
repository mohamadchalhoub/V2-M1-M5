import { CandleData } from '../market-data/historical-candle.service';
import { priceDistanceInPoints } from '../technical-analysis/point-value';
import { RuleLevelType } from './types';
import { WeeklyRangeLevels } from './weekly-range-levels.service';

export type LevelState = 'NOT_TOUCHED' | 'TOUCHED_WAITING' | 'READY' | 'BROKEN';

/**
 * The friend's actual answers (not a guess): "when touch resistance or
 * support take order after 50 point and bet on a bounce" (entry) + "when
 * price breaks levels: don't take any order, just wait the next
 * opportunity" (Rule 5). Read together, this needs a single state machine
 * per level, not just a static distance check:
 *
 *   NOT_TOUCHED    price has never reached the level since it became active
 *   TOUCHED_WAITING price touched the level, but hasn't yet retraced enough
 *                   to confirm a bounce, and hasn't overshot far enough to
 *                   count as broken either
 *   READY          touched AND retraced >= entryRetracePoints — enter now
 *   BROKEN         touched AND overshot >= levelBreakOvershootPoints without
 *                  retracing first — the friend's rule says stop trading
 *                  this level for the rest of its active week
 *
 * PLACEHOLDER reconciliation (AUTONOMOUS_RULE_ENGINE_SPEC.md §2.5): the
 * friend gave the 50-point retrace number for ENTRY but never said how far
 * a level has to be breached to count as "broken" rather than just a normal
 * pre-bounce overshoot. Using the SAME 50-point number for both is this
 * project's own reconciliation of his two separate answers, not something
 * he stated — it produces a clean race (whichever happens first, a 50pt
 * retrace back or a 50pt push further through, decides READY vs BROKEN),
 * but a different break threshold is equally plausible and should be
 * confirmed.
 *
 * `candlesSinceLevelActive` must be every candle from the moment this
 * level became tradeable (the reference week's end) up to "now," in
 * chronological order — the touch/overshoot/retrace state depends on the
 * full path, not just the current price.
 */
export function evaluateLevelState(
  levelPrice: number,
  levelType: RuleLevelType,
  candlesSinceLevelActive: CandleData[],
  currentPrice: number,
  entryRetracePoints: number,
  levelBreakOvershootPoints: number,
): LevelState {
  const isResistance = levelType === 'RESISTANCE';
  const touchExtreme = isResistance
    ? Math.max(levelPrice, ...candlesSinceLevelActive.map((c) => c.high))
    : Math.min(levelPrice, ...candlesSinceLevelActive.map((c) => c.low));

  const touched = isResistance ? touchExtreme > levelPrice : touchExtreme < levelPrice;
  if (!touched) return 'NOT_TOUCHED';

  const overshootPoints = priceDistanceInPoints(touchExtreme, levelPrice);
  if (overshootPoints >= levelBreakOvershootPoints) return 'BROKEN';

  const retracePoints = isResistance ? priceDistanceInPoints(levelPrice, currentPrice) : priceDistanceInPoints(currentPrice, levelPrice);
  const retracedAwayFromLevel = isResistance ? currentPrice < levelPrice : currentPrice > levelPrice;
  if (retracedAwayFromLevel && retracePoints >= entryRetracePoints) return 'READY';

  return 'TOUCHED_WAITING';
}

/**
 * The friend's Rule (spec §2.3): "don't take any order if the market moves
 * hard — up or down more than 500 points within 1 or 2 hours." Net
 * directional move (latest close vs. the close of the oldest candle inside
 * the window), not the bar-to-bar range — a blanket gate checked before any
 * level logic, applies regardless of which level might otherwise be valid.
 */
export function isVolatilitySpike(recentCandles: CandleData[], now: Date, windowHours: number, maxPoints: number): boolean {
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const inWindow = recentCandles.filter((c) => c.openTime >= windowStart && c.openTime <= now);
  if (inWindow.length < 2) return false;
  const oldest = inWindow[0];
  const newest = inWindow[inWindow.length - 1];
  return priceDistanceInPoints(oldest.close, newest.close) >= maxPoints;
}

/**
 * The friend's Rule (spec §2.4): "don't count on every support and
 * resistance — [only take it] when support or resistance on H4 and D1 are
 * [too] close." Reuses `calculateWeeklyRangeLevels` on D1 candles for the
 * SAME reference week window as the H4 levels, then checks proximity.
 * `d1Levels` is null when there isn't enough D1 history for the window —
 * treated as "not confirmed" (fail closed: don't count on the H4 level
 * absent D1 corroboration), never assumed confirmed by default.
 */
export function hasConfluence(h4Price: number, d1Levels: WeeklyRangeLevels | null, levelType: RuleLevelType, toleranceyPoints: number): boolean {
  if (!d1Levels) return false;
  const d1Price = levelType === 'RESISTANCE' ? d1Levels.resistance : d1Levels.support;
  return priceDistanceInPoints(h4Price, d1Price) <= toleranceyPoints;
}
