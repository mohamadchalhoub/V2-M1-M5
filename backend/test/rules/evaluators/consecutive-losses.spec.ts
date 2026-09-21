import { describe, expect, it } from 'vitest';
import { evaluateConsecutiveLosses } from '../../../src/rules/evaluators/consecutive-losses.evaluator';
import { RuleEvaluationStatus } from '../../../src/rules/types/rule-engine.types';
import { currentMetricsFixture } from '../fixtures';

describe('evaluateConsecutiveLosses', () => {
  const params = { count: 4 };

  it('normal condition, well below threshold → NOT_TRIGGERED', () => {
    const current = currentMetricsFixture({ sequences: { currentConsecutiveLosses: 1 } });
    expect(evaluateConsecutiveLosses(params, current).status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('exactly at threshold → TRIGGERED (inclusive)', () => {
    const current = currentMetricsFixture({ sequences: { currentConsecutiveLosses: 4 } });
    expect(evaluateConsecutiveLosses(params, current).status).toBe(RuleEvaluationStatus.TRIGGERED);
  });

  it('just below threshold → NOT_TRIGGERED', () => {
    const current = currentMetricsFixture({ sequences: { currentConsecutiveLosses: 3 } });
    expect(evaluateConsecutiveLosses(params, current).status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('just above threshold → TRIGGERED', () => {
    const current = currentMetricsFixture({ sequences: { currentConsecutiveLosses: 5 } });
    expect(evaluateConsecutiveLosses(params, current).status).toBe(RuleEvaluationStatus.TRIGGERED);
  });

  it('a brand-new account (zero trades, streak 0) never returns INSUFFICIENT_DATA', () => {
    const current = currentMetricsFixture({ sequences: { currentConsecutiveLosses: 0 } });
    expect(evaluateConsecutiveLosses(params, current).status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('repeated evaluation with unchanged inputs is deterministic', () => {
    const current = currentMetricsFixture({ sequences: { currentConsecutiveLosses: 4 } });
    expect(evaluateConsecutiveLosses(params, current)).toEqual(evaluateConsecutiveLosses(params, current));
  });
});
