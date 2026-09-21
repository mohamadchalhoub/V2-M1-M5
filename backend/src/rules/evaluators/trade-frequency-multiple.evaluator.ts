import { HistoricalBaselines } from '../../analytics/types/analytics.types';
import { round2 } from '../../analytics/util';
import { TradeFrequencyMultipleParams } from '../dto/rule-parameters.dto';
import { EvaluatorExtras, RuleComparisonOutcome, RuleEvaluationStatus } from '../types/rule-engine.types';

// RULE_ENGINE_SPEC.md §2.5 / ANALYTICS_SPEC.md §2.6. The baseline side is
// derived from averageTradesPerHour (a rate), scaled to window_minutes — no
// second analytics query. A zero or unavailable baseline is
// INSUFFICIENT_DATA, same rationale as POSITION_SIZE_MULTIPLE: multiplying a
// factor by zero would make any nonzero activity spuriously trigger.
export function evaluateTradeFrequencyMultiple(
  params: TradeFrequencyMultipleParams,
  baseline: HistoricalBaselines,
  extra: EvaluatorExtras,
): RuleComparisonOutcome {
  const tradesInWindow = extra.tradesInWindow ?? null;

  if (tradesInWindow === null || baseline.averageTradesPerHour === null) {
    return {
      status: RuleEvaluationStatus.INSUFFICIENT_DATA,
      reasonCode: 'TRADE_FREQUENCY_MISSING_DATA',
      triggerValues: { tradesInWindow },
      baselineValues: { averageTradesPerHour: baseline.averageTradesPerHour },
    };
  }

  const baselineForWindow = round2(baseline.averageTradesPerHour * (params.window_minutes / 60));

  if (baselineForWindow === 0) {
    return {
      status: RuleEvaluationStatus.INSUFFICIENT_DATA,
      reasonCode: 'TRADE_FREQUENCY_BASELINE_ZERO',
      triggerValues: { tradesInWindow },
      baselineValues: { averageTradesPerHour: baseline.averageTradesPerHour, baselineForWindow },
    };
  }

  const thresholdCount = round2(params.factor * baselineForWindow);
  const triggered = tradesInWindow >= thresholdCount;

  return {
    status: triggered ? RuleEvaluationStatus.TRIGGERED : RuleEvaluationStatus.NOT_TRIGGERED,
    reasonCode: triggered ? 'TRADE_FREQUENCY_ABOVE_MULTIPLE' : 'TRADE_FREQUENCY_BELOW_MULTIPLE',
    triggerValues: { tradesInWindow, thresholdCount },
    baselineValues: { averageTradesPerHour: baseline.averageTradesPerHour, baselineForWindow },
  };
}
