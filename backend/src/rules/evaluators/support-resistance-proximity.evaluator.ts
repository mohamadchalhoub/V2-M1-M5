import { SupportResistanceProximityParams } from '../dto/rule-parameters.dto';
import { EvaluatorExtras, RuleComparisonOutcome, RuleEvaluationStatus } from '../types/rule-engine.types';

/**
 * User's Rule 1 — SUPPORT_RESISTANCE_PROXIMITY. Purely EURUSD market data,
 * not an account metric — unlike every other leaf evaluator in this file,
 * this one takes no `current`/`baseline` (the dispatch in evaluators/index.ts
 * calls each evaluator with only the args it actually needs).
 * `extra.supportResistanceMatches` is already computed and filtered to
 * SUPPORT_RESISTANCE_PROXIMITY_POINTS by RuleEngineService.buildExtras
 * (technical-analysis/support-resistance.service.ts) — this function does
 * no I/O and no calculation of its own, only the TRIGGERED/NOT_TRIGGERED
 * decision (RULE_ENGINE_SPEC.md §3's "pure, no I/O" box).
 *
 * A continuous condition ("is price currently within N points of a
 * level"), not a discrete event — re-notification after cooldown expiry
 * while price is still lingering near the level is the same intentional
 * "re-notify" behavior every other continuous-condition rule in this
 * system already has (DRAWDOWN, MARGIN_UTILIZATION), so no extra
 * freshness logic is needed here (unlike ICHIMOKU_BREAKOUT, a genuinely
 * discrete event — see that evaluator's own comment for why it needs one).
 */
export function evaluateSupportResistanceProximity(
  _params: SupportResistanceProximityParams,
  extra: EvaluatorExtras,
): RuleComparisonOutcome {
  const matches = extra.supportResistanceMatches;

  if (matches === undefined) {
    return {
      status: RuleEvaluationStatus.INSUFFICIENT_DATA,
      reasonCode: 'SUPPORT_RESISTANCE_DATA_UNAVAILABLE',
      triggerValues: {},
      baselineValues: {},
    };
  }

  if (matches.length === 0) {
    return {
      status: RuleEvaluationStatus.NOT_TRIGGERED,
      reasonCode: 'NO_LEVEL_WITHIN_PROXIMITY',
      triggerValues: {},
      baselineValues: {},
    };
  }

  // Nearest first (already sorted by findLevelsNearPrice) — the single
  // most relevant level leads triggerValues, with every simultaneous match
  // still reported for a multi-timeframe confluence.
  const nearest = matches[0];

  return {
    status: RuleEvaluationStatus.TRIGGERED,
    reasonCode: 'PRICE_NEAR_SUPPORT_RESISTANCE_LEVEL',
    triggerValues: {
      symbol: 'EURUSD',
      currentPrice: nearest.currentPrice,
      timeframe: nearest.timeframe,
      levelType: nearest.levelType,
      levelPrice: nearest.levelPrice,
      distancePoints: nearest.distancePoints,
      direction: nearest.currentPriceIsAbove ? 'ABOVE' : 'BELOW',
      trend: nearest.trend,
      allMatches: matches,
    },
    baselineValues: {},
  };
}
