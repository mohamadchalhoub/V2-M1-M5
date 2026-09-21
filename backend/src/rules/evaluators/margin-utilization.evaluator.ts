import { CurrentMetrics } from '../../analytics/types/analytics.types';
import { MarginUtilizationParams } from '../dto/rule-parameters.dto';
import { RuleComparisonOutcome, RuleEvaluationStatus } from '../types/rule-engine.types';

// Live-test production-readiness pass (item C, MARGIN_UTILIZATION) —
// dangerous margin usage: margin_level (%) at or below a configured floor.
// margin_level === 0 with margin === 0 is MT5's own convention for "no
// margin currently in use" (nothing open, or everything hedged to zero
// margin) — never a low-margin-level warning, since there's nothing at risk.
// Only a genuinely in-use, low margin_level (margin > 0 and marginLevel at
// or below the floor) is meaningful.
export function evaluateMarginUtilization(
  params: MarginUtilizationParams,
  current: CurrentMetrics,
): RuleComparisonOutcome {
  const { margin, marginLevel } = current.account;

  if (margin === null || marginLevel === null) {
    return {
      status: RuleEvaluationStatus.INSUFFICIENT_DATA,
      reasonCode: 'MARGIN_MISSING_DATA',
      triggerValues: { margin, marginLevel },
      baselineValues: {},
    };
  }

  if (margin <= 0) {
    // No margin in use — nothing open (or fully hedged). A known, safe
    // state, not something to warn about, regardless of the reported level.
    return {
      status: RuleEvaluationStatus.NOT_TRIGGERED,
      reasonCode: 'NO_MARGIN_IN_USE',
      triggerValues: { margin, marginLevel },
      baselineValues: {},
    };
  }

  const triggered = marginLevel <= params.min_margin_level_pct;

  return {
    status: triggered ? RuleEvaluationStatus.TRIGGERED : RuleEvaluationStatus.NOT_TRIGGERED,
    reasonCode: triggered ? 'MARGIN_LEVEL_BELOW_FLOOR' : 'MARGIN_LEVEL_ABOVE_FLOOR',
    triggerValues: { margin, marginLevel },
    baselineValues: {},
  };
}
