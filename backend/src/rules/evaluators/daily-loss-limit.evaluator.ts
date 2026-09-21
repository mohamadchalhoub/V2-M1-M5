import { CurrentMetrics } from '../../analytics/types/analytics.types';
import { round4 } from '../../analytics/util';
import { DailyLossLimitParams } from '../dto/rule-parameters.dto';
import { RuleComparisonOutcome, RuleEvaluationStatus } from '../types/rule-engine.types';

// RULE_ENGINE_SPEC.md §2.1 — dailyLoss / startingBalance >= threshold_pct.
export function evaluateDailyLossLimit(
  params: DailyLossLimitParams,
  current: CurrentMetrics,
): RuleComparisonOutcome {
  const { dailyLoss, startingBalance } = current.account;

  if (startingBalance === null || startingBalance <= 0 || dailyLoss === null) {
    return {
      status: RuleEvaluationStatus.INSUFFICIENT_DATA,
      reasonCode: 'DAILY_LOSS_LIMIT_MISSING_DATA',
      triggerValues: { dailyLoss, startingBalance },
      baselineValues: {},
    };
  }

  const lossPct = round4(dailyLoss / startingBalance);
  const triggered = lossPct >= params.threshold_pct;

  return {
    status: triggered ? RuleEvaluationStatus.TRIGGERED : RuleEvaluationStatus.NOT_TRIGGERED,
    reasonCode: triggered ? 'DAILY_LOSS_ABOVE_THRESHOLD' : 'DAILY_LOSS_BELOW_THRESHOLD',
    triggerValues: { dailyLoss, startingBalance, lossPct },
    baselineValues: {},
  };
}
