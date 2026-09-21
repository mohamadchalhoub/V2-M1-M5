import { describe, expect, it } from 'vitest';
import { evaluateDrawdown } from '../../../src/rules/evaluators/drawdown.evaluator';
import { RuleEvaluationStatus } from '../../../src/rules/types/rule-engine.types';
import { currentMetricsFixture } from '../fixtures';

describe('evaluateDrawdown', () => {
  const params = { threshold_pct: 0.03 };

  it('normal condition, well below threshold → NOT_TRIGGERED', () => {
    const current = currentMetricsFixture({ account: { drawdown: 0.01 } });
    expect(evaluateDrawdown(params, current).status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('exactly at threshold → TRIGGERED (inclusive)', () => {
    const current = currentMetricsFixture({ account: { drawdown: 0.03 } });
    expect(evaluateDrawdown(params, current).status).toBe(RuleEvaluationStatus.TRIGGERED);
  });

  it('just below threshold → NOT_TRIGGERED', () => {
    const current = currentMetricsFixture({ account: { drawdown: 0.029 } });
    expect(evaluateDrawdown(params, current).status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('just above threshold → TRIGGERED', () => {
    const current = currentMetricsFixture({ account: { drawdown: 0.031 } });
    expect(evaluateDrawdown(params, current).status).toBe(RuleEvaluationStatus.TRIGGERED);
  });

  it('the "bad session" fixture value (3.8% drawdown, 3% threshold) → TRIGGERED', () => {
    const current = currentMetricsFixture({ account: { drawdown: 0.038 } });
    expect(evaluateDrawdown(params, current).status).toBe(RuleEvaluationStatus.TRIGGERED);
  });

  it('null drawdown (no snapshots yet) → INSUFFICIENT_DATA', () => {
    const current = currentMetricsFixture({ account: { drawdown: null } });
    expect(evaluateDrawdown(params, current).status).toBe(RuleEvaluationStatus.INSUFFICIENT_DATA);
  });

  it('zero drawdown (at the all-time peak) → NOT_TRIGGERED, not insufficient', () => {
    const current = currentMetricsFixture({ account: { drawdown: 0 } });
    expect(evaluateDrawdown(params, current).status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('repeated evaluation with unchanged inputs is deterministic', () => {
    const current = currentMetricsFixture({ account: { drawdown: 0.05 } });
    expect(evaluateDrawdown(params, current)).toEqual(evaluateDrawdown(params, current));
  });
});
