import { describe, expect, it } from 'vitest';
import { evaluatePositionSizeMultiple } from '../../../src/rules/evaluators/position-size-multiple.evaluator';
import { RuleEvaluationStatus } from '../../../src/rules/types/rule-engine.types';
import { currentMetricsFixture, historicalBaselinesFixture } from '../fixtures';

describe('evaluatePositionSizeMultiple', () => {
  const params = { factor: 2, baseline: 'avg' as const };

  it('normal condition, well below threshold → NOT_TRIGGERED', () => {
    const current = currentMetricsFixture({ position: { maximumPositionVolume: 0.25 } });
    const baseline = historicalBaselinesFixture({ averagePositionVolume: 0.2 });
    expect(evaluatePositionSizeMultiple(params, current, baseline).status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('exactly at the threshold (2x baseline) → TRIGGERED (inclusive)', () => {
    const current = currentMetricsFixture({ position: { maximumPositionVolume: 0.4 } });
    const baseline = historicalBaselinesFixture({ averagePositionVolume: 0.2 });
    expect(evaluatePositionSizeMultiple(params, current, baseline).status).toBe(RuleEvaluationStatus.TRIGGERED);
  });

  it('just below threshold → NOT_TRIGGERED', () => {
    const current = currentMetricsFixture({ position: { maximumPositionVolume: 0.39 } });
    const baseline = historicalBaselinesFixture({ averagePositionVolume: 0.2 });
    expect(evaluatePositionSizeMultiple(params, current, baseline).status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('just above threshold → TRIGGERED', () => {
    const current = currentMetricsFixture({ position: { maximumPositionVolume: 0.41 } });
    const baseline = historicalBaselinesFixture({ averagePositionVolume: 0.2 });
    expect(evaluatePositionSizeMultiple(params, current, baseline).status).toBe(RuleEvaluationStatus.TRIGGERED);
  });

  it('the "bad session" fixture (0.50 lots vs 0.20 avg baseline, factor 2) → TRIGGERED', () => {
    const current = currentMetricsFixture({ position: { maximumPositionVolume: 0.5 } });
    const baseline = historicalBaselinesFixture({ averagePositionVolume: 0.2 });
    expect(evaluatePositionSizeMultiple(params, current, baseline).status).toBe(RuleEvaluationStatus.TRIGGERED);
  });

  it('no open positions → NOT_TRIGGERED (a known state, not missing data), even with a valid baseline', () => {
    const current = currentMetricsFixture({ position: { maximumPositionVolume: null } });
    const baseline = historicalBaselinesFixture({ averagePositionVolume: 0.2 });
    const result = evaluatePositionSizeMultiple(params, current, baseline);
    expect(result.status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
    expect(result.reasonCode).toBe('NO_OPEN_POSITIONS');
  });

  it('null baseline (brand-new account, empty window) with an open position → INSUFFICIENT_DATA', () => {
    const current = currentMetricsFixture({ position: { maximumPositionVolume: 0.3 } });
    const baseline = historicalBaselinesFixture({ averagePositionVolume: null });
    expect(evaluatePositionSizeMultiple(params, current, baseline).status).toBe(
      RuleEvaluationStatus.INSUFFICIENT_DATA,
    );
  });

  it('zero baseline → INSUFFICIENT_DATA, never a trivially-satisfied >= 0', () => {
    const current = currentMetricsFixture({ position: { maximumPositionVolume: 0.01 } });
    const baseline = historicalBaselinesFixture({ averagePositionVolume: 0 });
    expect(evaluatePositionSizeMultiple(params, current, baseline).status).toBe(
      RuleEvaluationStatus.INSUFFICIENT_DATA,
    );
  });

  it("baseline: 'max' selects maximumNormalPositionVolume, not averagePositionVolume", () => {
    const current = currentMetricsFixture({ position: { maximumPositionVolume: 1.0 } });
    const baseline = historicalBaselinesFixture({ averagePositionVolume: 0.2, maximumNormalPositionVolume: 0.6 });
    const result = evaluatePositionSizeMultiple({ factor: 2, baseline: 'max' }, current, baseline);
    // threshold = 2 * 0.6 = 1.2; 1.0 >= 1.2 is false
    expect(result.status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('repeated evaluation with unchanged inputs is deterministic', () => {
    const current = currentMetricsFixture({ position: { maximumPositionVolume: 0.5 } });
    const baseline = historicalBaselinesFixture({ averagePositionVolume: 0.2 });
    expect(evaluatePositionSizeMultiple(params, current, baseline)).toEqual(
      evaluatePositionSizeMultiple(params, current, baseline),
    );
  });
});
