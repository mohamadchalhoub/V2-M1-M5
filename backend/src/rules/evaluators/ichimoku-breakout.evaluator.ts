import { IchimokuBreakoutParams } from '../dto/rule-parameters.dto';
import { EvaluatorExtras, RuleComparisonOutcome, RuleEvaluationStatus } from '../types/rule-engine.types';

// A discrete-event rule needs a freshness window that a continuous-
// condition rule (SUPPORT_RESISTANCE_PROXIMITY) does not: without one, the
// same already-alerted breakout would re-trigger every time cooldown
// expires, because `detectIchimokuBreakout` is a stateless "did the last
// two closed candles cross the cloud" comparison — it keeps reporting the
// same historical breakout for as long as that candle remains "the
// latest." 15 minutes comfortably outlasts the collector's own 5-minute
// candle-sync cadence (plus normal network jitter) while still being far
// shorter than the shortest watched timeframe (M30) — see
// TECHNICAL_ANALYSIS_SPEC.md §2 for the full reasoning, including why the
// rule's own cooldownSeconds must be set LONGER than this window (so a
// stale breakout goes NOT_TRIGGERED — and RuleState back to INACTIVE —
// before cooldown could ever expire and re-notify on it).
// Exported (not just module-local) so rule-definitions.service.ts can
// enforce, at creation/update time, that an ICHIMOKU_BREAKOUT rule's own
// cooldownSeconds is set longer than this window — see that file's own
// comment for why a shorter cooldown would let a stale breakout re-notify.
export const BREAKOUT_FRESHNESS_MS = 15 * 60_000;

/**
 * User's Rule 2 — ICHIMOKU_BREAKOUT. Purely EURUSD market data,
 * `extra.ichimokuBreakouts` is already computed (across every configured
 * ICHIMOKU_TIMEFRAMES) by RuleEngineService.buildExtras
 * (technical-analysis/ichimoku.service.ts's `detectIchimokuBreakout`) —
 * this function does no I/O, only the freshness filter and the
 * TRIGGERED/NOT_TRIGGERED decision.
 */
export function evaluateIchimokuBreakout(
  _params: IchimokuBreakoutParams,
  extra: EvaluatorExtras,
): RuleComparisonOutcome {
  const breakouts = extra.ichimokuBreakouts;
  const now = extra.now ?? new Date();

  if (breakouts === undefined) {
    return {
      status: RuleEvaluationStatus.INSUFFICIENT_DATA,
      reasonCode: 'ICHIMOKU_DATA_UNAVAILABLE',
      triggerValues: {},
      baselineValues: {},
    };
  }

  const freshBreakouts = breakouts.filter((b) => now.getTime() - new Date(b.timestamp).getTime() <= BREAKOUT_FRESHNESS_MS);

  if (freshBreakouts.length === 0) {
    return {
      status: RuleEvaluationStatus.NOT_TRIGGERED,
      reasonCode: 'NO_FRESH_ICHIMOKU_BREAKOUT',
      triggerValues: {},
      baselineValues: {},
    };
  }

  return {
    status: RuleEvaluationStatus.TRIGGERED,
    reasonCode: 'ICHIMOKU_BREAKOUT_DETECTED',
    triggerValues: {
      symbol: 'EURUSD',
      breakouts: freshBreakouts,
    },
    baselineValues: {},
  };
}
