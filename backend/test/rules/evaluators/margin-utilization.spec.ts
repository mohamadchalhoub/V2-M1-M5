import { describe, expect, it } from 'vitest';
import { evaluateMarginUtilization } from '../../../src/rules/evaluators/margin-utilization.evaluator';
import { RuleEvaluationStatus } from '../../../src/rules/types/rule-engine.types';
import { currentMetricsFixture } from '../fixtures';

describe('evaluateMarginUtilization', () => {
  const params = { min_margin_level_pct: 150 };

  it('no margin in use (nothing open) → NOT_TRIGGERED, never treated as a low level', () => {
    const current = currentMetricsFixture({ account: { margin: 0, marginLevel: 0 } });
    const result = evaluateMarginUtilization(params, current);
    expect(result.status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
    expect(result.reasonCode).toBe('NO_MARGIN_IN_USE');
  });

  it('margin in use, margin level comfortably above the floor → NOT_TRIGGERED', () => {
    const current = currentMetricsFixture({ account: { margin: 500, marginLevel: 400 } });
    expect(evaluateMarginUtilization(params, current).status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('margin in use, margin level at the floor (inclusive) → TRIGGERED', () => {
    const current = currentMetricsFixture({ account: { margin: 500, marginLevel: 150 } });
    const result = evaluateMarginUtilization(params, current);
    expect(result.status).toBe(RuleEvaluationStatus.TRIGGERED);
    expect(result.reasonCode).toBe('MARGIN_LEVEL_BELOW_FLOOR');
  });

  it('margin in use, margin level below the floor → TRIGGERED', () => {
    const current = currentMetricsFixture({ account: { margin: 800, marginLevel: 105 } });
    expect(evaluateMarginUtilization(params, current).status).toBe(RuleEvaluationStatus.TRIGGERED);
  });

  it('no snapshot yet (margin/marginLevel null) → INSUFFICIENT_DATA', () => {
    const current = currentMetricsFixture({ account: { margin: null, marginLevel: null } });
    expect(evaluateMarginUtilization(params, current).status).toBe(RuleEvaluationStatus.INSUFFICIENT_DATA);
  });

  it('repeated evaluation with unchanged inputs is deterministic', () => {
    const current = currentMetricsFixture({ account: { margin: 500, marginLevel: 120 } });
    expect(evaluateMarginUtilization(params, current)).toEqual(evaluateMarginUtilization(params, current));
  });
});
