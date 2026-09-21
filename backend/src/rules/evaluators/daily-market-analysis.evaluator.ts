import { DailyMarketAnalysisParams } from '../dto/rule-parameters.dto';
import { EvaluatorExtras, RuleComparisonOutcome, RuleEvaluationStatus } from '../types/rule-engine.types';

/**
 * User's Rules 3+4, combined into one daily morning report —
 * SUPPORT_RESISTANCE_PROXIMITY/ICHIMOKU_BREAKOUT are threshold conditions
 * that may or may not be true; this one is a scheduled ANALYSIS that
 * always has something to report once computed, so it always TRIGGERS
 * when `extra.dailyMarketAnalysis` is present. Only ever evaluated via the
 * cron-driven path (RuleEngineService's `ruleTypeFilter`, DailyMarket
 * AnalysisProcessor) — never the snapshot trigger — so "always TRIGGERED"
 * still means "once a day," not "every ~10 seconds."
 */
export function evaluateDailyMarketAnalysis(
  _params: DailyMarketAnalysisParams,
  extra: EvaluatorExtras,
): RuleComparisonOutcome {
  const analysis = extra.dailyMarketAnalysis;

  if (!analysis) {
    return {
      status: RuleEvaluationStatus.INSUFFICIENT_DATA,
      reasonCode: 'DAILY_ANALYSIS_NOT_COMPUTED',
      triggerValues: {},
      baselineValues: {},
    };
  }

  return {
    status: RuleEvaluationStatus.TRIGGERED,
    reasonCode: 'DAILY_MARKET_ANALYSIS_GENERATED',
    triggerValues: { ...analysis } as unknown as Record<string, unknown>,
    baselineValues: {},
  };
}
