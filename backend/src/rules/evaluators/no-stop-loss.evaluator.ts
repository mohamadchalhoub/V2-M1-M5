import { CurrentMetrics } from '../../analytics/types/analytics.types';
import { NoStopLossParams } from '../dto/rule-parameters.dto';
import { RuleComparisonOutcome, RuleEvaluationStatus } from '../types/rule-engine.types';

// Live-test production-readiness pass (item E, NO_STOP_LOSS) — a monitoring
// warning, not trading advice: at least one open position has no stop-loss
// protection. Parameterless (see rule-parameters.dto.ts). Never
// INSUFFICIENT_DATA — openPositionsWithoutStopLoss is a direct count over
// already-fetched rows, 0 for "no positions" and "all protected" alike,
// both a known, non-triggering state.
export function evaluateNoStopLoss(
  _params: NoStopLossParams,
  current: CurrentMetrics,
): RuleComparisonOutcome {
  const { openPositionsWithoutStopLoss } = current.position;
  const triggered = openPositionsWithoutStopLoss > 0;

  return {
    status: triggered ? RuleEvaluationStatus.TRIGGERED : RuleEvaluationStatus.NOT_TRIGGERED,
    reasonCode: triggered ? 'POSITIONS_WITHOUT_STOP_LOSS' : 'ALL_POSITIONS_PROTECTED',
    triggerValues: { openPositionsWithoutStopLoss },
    baselineValues: {},
  };
}
