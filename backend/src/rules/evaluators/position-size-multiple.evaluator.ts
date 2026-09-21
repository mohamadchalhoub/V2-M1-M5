import { CurrentMetrics, HistoricalBaselines } from '../../analytics/types/analytics.types';
import { round2 } from '../../analytics/util';
import { PositionSizeMultipleParams } from '../dto/rule-parameters.dto';
import { RuleComparisonOutcome, RuleEvaluationStatus } from '../types/rule-engine.types';

// RULE_ENGINE_SPEC.md §2.4 / decision 3 (per Phase 4 approval): use
// maximumPositionVolume (live) against averagePositionVolume or
// maximumNormalPositionVolume (baseline, selected by params.baseline). A
// zero or unavailable baseline is INSUFFICIENT_DATA — never divide by zero,
// never treat a missing historical baseline as zero.
export function evaluatePositionSizeMultiple(
  params: PositionSizeMultipleParams,
  current: CurrentMetrics,
  baseline: HistoricalBaselines,
): RuleComparisonOutcome {
  const maximumPositionVolume = current.position.maximumPositionVolume;

  // Nothing open is a known state, not missing data (RULE_ENGINE_SPEC.md
  // §8): there is verifiably no oversized position right now, regardless of
  // what the baseline says — checked before the baseline so this answer
  // never depends on baseline availability.
  if (maximumPositionVolume === null) {
    return {
      status: RuleEvaluationStatus.NOT_TRIGGERED,
      reasonCode: 'NO_OPEN_POSITIONS',
      triggerValues: { maximumPositionVolume: null },
      baselineValues: {},
    };
  }

  const baselineValue =
    params.baseline === 'avg' ? baseline.averagePositionVolume : baseline.maximumNormalPositionVolume;

  if (baselineValue === null || baselineValue === 0) {
    return {
      status: RuleEvaluationStatus.INSUFFICIENT_DATA,
      reasonCode:
        baselineValue === null
          ? 'POSITION_SIZE_BASELINE_UNAVAILABLE'
          : 'POSITION_SIZE_BASELINE_ZERO',
      triggerValues: { maximumPositionVolume },
      baselineValues: { baselineField: params.baseline, baselineValue },
    };
  }

  const thresholdVolume = round2(params.factor * baselineValue);
  const triggered = maximumPositionVolume >= thresholdVolume;

  return {
    status: triggered ? RuleEvaluationStatus.TRIGGERED : RuleEvaluationStatus.NOT_TRIGGERED,
    reasonCode: triggered ? 'POSITION_SIZE_ABOVE_MULTIPLE' : 'POSITION_SIZE_BELOW_MULTIPLE',
    triggerValues: { maximumPositionVolume, thresholdVolume },
    baselineValues: { baselineField: params.baseline, baselineValue },
  };
}
