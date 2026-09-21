import { RuleType } from '@prisma/client';
import { CurrentMetrics, HistoricalBaselines } from '../../analytics/types/analytics.types';
import { EvaluatorExtras, RuleComparisonOutcome } from '../types/rule-engine.types';
import { evaluateDailyLossLimit } from './daily-loss-limit.evaluator';
import { evaluateDailyMarketAnalysis } from './daily-market-analysis.evaluator';
import { evaluateDrawdown } from './drawdown.evaluator';
import { evaluateConsecutiveLosses } from './consecutive-losses.evaluator';
import { evaluateIchimokuBreakout } from './ichimoku-breakout.evaluator';
import { evaluatePositionSizeMultiple } from './position-size-multiple.evaluator';
import { evaluateSupportResistanceProximity } from './support-resistance-proximity.evaluator';
import { evaluateTradeFrequencyMultiple } from './trade-frequency-multiple.evaluator';
import { evaluateMarginUtilization } from './margin-utilization.evaluator';
import { evaluateNoStopLoss } from './no-stop-loss.evaluator';
import { evaluateConcentration } from './concentration.evaluator';
import { evaluateHighImpactEventExposure } from './high-impact-event-exposure.evaluator';

export { evaluateDailyLossLimit } from './daily-loss-limit.evaluator';
export { evaluateDailyMarketAnalysis } from './daily-market-analysis.evaluator';
export { evaluateDrawdown } from './drawdown.evaluator';
export { evaluateConsecutiveLosses } from './consecutive-losses.evaluator';
export { evaluateIchimokuBreakout } from './ichimoku-breakout.evaluator';
export { evaluatePositionSizeMultiple } from './position-size-multiple.evaluator';
export { evaluateSupportResistanceProximity } from './support-resistance-proximity.evaluator';
export { evaluateTradeFrequencyMultiple } from './trade-frequency-multiple.evaluator';
export { evaluateMarginUtilization } from './margin-utilization.evaluator';
export { evaluateNoStopLoss } from './no-stop-loss.evaluator';
export { evaluateConcentration } from './concentration.evaluator';
export { evaluateHighImpactEventExposure } from './high-impact-event-exposure.evaluator';
export { evaluateCompound } from './compound.evaluator';

/** rule_types this registry can evaluate — everything except COMPOUND, which needs component states, not raw metrics. */
export const LEAF_RULE_TYPES: readonly RuleType[] = [
  RuleType.DAILY_LOSS_LIMIT,
  RuleType.DRAWDOWN,
  RuleType.CONSECUTIVE_LOSSES,
  RuleType.POSITION_SIZE_MULTIPLE,
  RuleType.TRADE_FREQUENCY_MULTIPLE,
  RuleType.MARGIN_UTILIZATION,
  RuleType.NO_STOP_LOSS,
  RuleType.CONCENTRATION,
  RuleType.HIGH_IMPACT_EVENT_EXPOSURE,
  RuleType.SUPPORT_RESISTANCE_PROXIMITY,
  RuleType.ICHIMOKU_BREAKOUT,
  RuleType.DAILY_MARKET_ANALYSIS,
];

/**
 * Evaluates one leaf (non-COMPOUND) rule type against pre-fetched metrics.
 * Pure — no I/O, no async — per RULE_ENGINE_SPEC.md §3's "Req. 2 — enforced
 * by construction" box.
 */
export function evaluateLeafRule(
  ruleType: Exclude<RuleType, 'COMPOUND'>,
  parameters: Record<string, unknown>,
  current: CurrentMetrics,
  baseline: HistoricalBaselines,
  extra: EvaluatorExtras = {},
): RuleComparisonOutcome {
  switch (ruleType) {
    case RuleType.DAILY_LOSS_LIMIT:
      return evaluateDailyLossLimit(parameters as any, current);
    case RuleType.DRAWDOWN:
      return evaluateDrawdown(parameters as any, current);
    case RuleType.CONSECUTIVE_LOSSES:
      return evaluateConsecutiveLosses(parameters as any, current);
    case RuleType.POSITION_SIZE_MULTIPLE:
      return evaluatePositionSizeMultiple(parameters as any, current, baseline);
    case RuleType.TRADE_FREQUENCY_MULTIPLE:
      return evaluateTradeFrequencyMultiple(parameters as any, baseline, extra);
    case RuleType.MARGIN_UTILIZATION:
      return evaluateMarginUtilization(parameters as any, current);
    case RuleType.NO_STOP_LOSS:
      return evaluateNoStopLoss(parameters as any, current);
    case RuleType.CONCENTRATION:
      return evaluateConcentration(parameters as any, current);
    case RuleType.HIGH_IMPACT_EVENT_EXPOSURE:
      return evaluateHighImpactEventExposure(parameters as any, current, extra);
    case RuleType.SUPPORT_RESISTANCE_PROXIMITY:
      return evaluateSupportResistanceProximity(parameters as any, extra);
    case RuleType.ICHIMOKU_BREAKOUT:
      return evaluateIchimokuBreakout(parameters as any, extra);
    case RuleType.DAILY_MARKET_ANALYSIS:
      return evaluateDailyMarketAnalysis(parameters as any, extra);
    default: {
      const exhaustive: never = ruleType;
      throw new Error(`No evaluator registered for rule_type ${exhaustive as string}`);
    }
  }
}
