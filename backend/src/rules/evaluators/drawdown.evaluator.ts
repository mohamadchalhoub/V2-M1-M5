import { CurrentMetrics } from '../../analytics/types/analytics.types';
import { DrawdownParams } from '../dto/rule-parameters.dto';
import { RuleComparisonOutcome, RuleEvaluationStatus } from '../types/rule-engine.types';

// RULE_ENGINE_SPEC.md §2.2 — drawdown >= threshold_pct, both 0-1 fractions.
export function evaluateDrawdown(
  params: DrawdownParams,
  current: CurrentMetrics,
): RuleComparisonOutcome {
  const { drawdown } = current.account;

  if (drawdown === null) {
    return {
      status: RuleEvaluationStatus.INSUFFICIENT_DATA,
      reasonCode: 'DRAWDOWN_MISSING_DATA',
      triggerValues: { drawdown },
      baselineValues: {},
    };
  }

  const triggered = drawdown >= params.threshold_pct;

  return {
    status: triggered ? RuleEvaluationStatus.TRIGGERED : RuleEvaluationStatus.NOT_TRIGGERED,
    reasonCode: triggered ? 'DRAWDOWN_ABOVE_THRESHOLD' : 'DRAWDOWN_BELOW_THRESHOLD',
    triggerValues: { drawdown },
    baselineValues: {},
  };
}
