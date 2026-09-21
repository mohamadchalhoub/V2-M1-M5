import { CurrentMetrics } from '../../analytics/types/analytics.types';
import { ConsecutiveLossesParams } from '../dto/rule-parameters.dto';
import { RuleComparisonOutcome, RuleEvaluationStatus } from '../types/rule-engine.types';

// RULE_ENGINE_SPEC.md §2.3 — currentConsecutiveLosses is never null
// (ANALYTICS_SPEC.md §2.5: 0 for a zero-trade account), so this evaluator
// never returns INSUFFICIENT_DATA on its own.
export function evaluateConsecutiveLosses(
  params: ConsecutiveLossesParams,
  current: CurrentMetrics,
): RuleComparisonOutcome {
  const streak = current.sequences.currentConsecutiveLosses;
  const triggered = streak >= params.count;

  return {
    status: triggered ? RuleEvaluationStatus.TRIGGERED : RuleEvaluationStatus.NOT_TRIGGERED,
    reasonCode: triggered ? 'CONSECUTIVE_LOSSES_ABOVE_THRESHOLD' : 'CONSECUTIVE_LOSSES_BELOW_THRESHOLD',
    triggerValues: { currentConsecutiveLosses: streak },
    baselineValues: {},
  };
}
