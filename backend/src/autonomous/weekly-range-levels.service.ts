import { CandleData } from '../market-data/historical-candle.service';

export interface WeeklyRangeLevels {
  /** Monday 00:00 UTC of the reference week. */
  referenceWeekStart: Date;
  /** Exclusive — the following Monday 00:00 UTC. */
  referenceWeekEnd: Date;
  /** Highest H4 high printed during the reference week — the friend's Rule 4 "highest resistance". */
  resistance: number;
  /** Lowest H4 low printed during the reference week — the friend's Rule 4 "lowest support". */
  support: number;
  candleCount: number;
}

/**
 * Placeholder interpretation of the friend's Rule 4 ("highest resistance"/
 * "lowest support") — the absolute highest high and lowest low the
 * reference timeframe printed during the week, not a swing-pivot method
 * like `support-resistance.service.ts`'s FRACTAL_PIVOT detection (that
 * service answers a different question — "where are the meaningful turning
 * points" — for the existing behavior-monitoring alert; the friend's rule
 * asks for the week's literal extremes). See
 * AUTONOMOUS_RULE_ENGINE_SPEC.md §1 for why this reading was chosen.
 */
function mondayStartUtc(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const diffToMonday = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d;
}

/**
 * Placeholder interpretation of the friend's Rules 7/8 (break + recalculation)
 * — the simplest reading: the reference week is always the most recently
 * completed calendar week (Mon 00:00 UTC – Sun 23:59:59.999 UTC) as of
 * `asOf`, recomputed every week on a rolling basis. This deliberately does
 * NOT implement a separate mid-week "level broken, recalculate now" event —
 * that reading of Rules 7/8 is ambiguous as written
 * (AUTONOMOUS_DEMO_TRADING_PLAN.md §13.3) and needs the friend's own worked
 * examples before it can be built without guessing. `detectLevelBreak`
 * below exists to surface how often that would actually matter, as data to
 * bring back to that conversation.
 */
export function getPreviousCompletedWeekBounds(asOf: Date): { start: Date; end: Date } {
  const currentWeekStart = mondayStartUtc(asOf);
  const start = new Date(currentWeekStart);
  start.setUTCDate(start.getUTCDate() - 7);
  return { start, end: currentWeekStart };
}

/** Null when no candles exist for the reference week (e.g. insufficient history). */
export function calculateWeeklyRangeLevels(candles: CandleData[], asOf: Date): WeeklyRangeLevels | null {
  const { start, end } = getPreviousCompletedWeekBounds(asOf);
  const weekCandles = candles.filter((c) => c.openTime >= start && c.openTime < end);
  if (weekCandles.length === 0) return null;

  let resistance = -Infinity;
  let support = Infinity;
  for (const c of weekCandles) {
    if (c.high > resistance) resistance = c.high;
    if (c.low < support) support = c.low;
  }

  return { referenceWeekStart: start, referenceWeekEnd: end, resistance, support, candleCount: weekCandles.length };
}

/**
 * Telemetry only — not consumed by the decision logic in
 * `autonomous-rule-engine.service.ts` yet, since what SHOULD happen on a
 * break is exactly the ambiguity noted above. This answers "did price
 * actually trade beyond the reference level after the reference week
 * ended," so a real answer from the friend can be checked against what
 * actually happens in the data, instead of guessed at.
 */
export function detectLevelBreak(
  levels: WeeklyRangeLevels,
  candlesSinceReferenceWeek: CandleData[],
): { resistanceBroken: boolean; supportBroken: boolean } {
  const relevant = candlesSinceReferenceWeek.filter((c) => c.openTime >= levels.referenceWeekEnd);
  return {
    resistanceBroken: relevant.some((c) => c.high > levels.resistance),
    supportBroken: relevant.some((c) => c.low < levels.support),
  };
}
