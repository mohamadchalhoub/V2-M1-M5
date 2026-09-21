import { CurrentMetrics } from '../../analytics/types/analytics.types';
import { ConcentrationParams } from '../dto/rule-parameters.dto';
import { RuleComparisonOutcome, RuleEvaluationStatus } from '../types/rule-engine.types';

// Live-test production-readiness pass (item F, CONCENTRATION) — excessive
// exposure in one symbol OR one direction (all-BUY/all-SELL), each already
// computed by position.metrics.ts from the open-positions rows it fetches
// anyway. Deliberately does NOT attempt cross-instrument correlation (e.g.
// XAUUSD vs XAGUSD) — the current architecture has no correlation data
// source, and inventing one is explicitly out of scope for this pass.
export function evaluateConcentration(
  params: ConcentrationParams,
  current: CurrentMetrics,
): RuleComparisonOutcome {
  const { maximumSymbolConcentrationPct, maximumDirectionConcentrationPct } = current.position;

  if (maximumSymbolConcentrationPct === null || maximumDirectionConcentrationPct === null) {
    // Both are null together (currentTotalVolume === 0) or not at all —
    // nothing open is a known state, not missing data.
    return {
      status: RuleEvaluationStatus.NOT_TRIGGERED,
      reasonCode: 'NO_OPEN_POSITIONS',
      triggerValues: { maximumSymbolConcentrationPct, maximumDirectionConcentrationPct },
      baselineValues: {},
    };
  }

  const symbolTriggered = maximumSymbolConcentrationPct >= params.threshold_pct;
  const directionTriggered = maximumDirectionConcentrationPct >= params.threshold_pct;
  const triggered = symbolTriggered || directionTriggered;

  let reasonCode: string;
  if (symbolTriggered && directionTriggered) {
    reasonCode = 'SYMBOL_AND_DIRECTION_CONCENTRATION_ABOVE_THRESHOLD';
  } else if (symbolTriggered) {
    reasonCode = 'SYMBOL_CONCENTRATION_ABOVE_THRESHOLD';
  } else if (directionTriggered) {
    reasonCode = 'DIRECTION_CONCENTRATION_ABOVE_THRESHOLD';
  } else {
    reasonCode = 'CONCENTRATION_BELOW_THRESHOLD';
  }

  return {
    status: triggered ? RuleEvaluationStatus.TRIGGERED : RuleEvaluationStatus.NOT_TRIGGERED,
    reasonCode,
    triggerValues: { maximumSymbolConcentrationPct, maximumDirectionConcentrationPct },
    baselineValues: {},
  };
}
