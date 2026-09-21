import { describe, expect, it } from 'vitest';
import { evaluateDailyLossLimit } from '../../../src/rules/evaluators/daily-loss-limit.evaluator';
import { RuleEvaluationStatus } from '../../../src/rules/types/rule-engine.types';
import { currentMetricsFixture } from '../fixtures';

describe('evaluateDailyLossLimit', () => {
  const params = { threshold_pct: 0.05 };

  it('normal condition, well below threshold → NOT_TRIGGERED', () => {
    const current = currentMetricsFixture({ account: { dailyLoss: 200, startingBalance: 10_000 } });
    const result = evaluateDailyLossLimit(params, current);
    expect(result.status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('exactly at threshold → TRIGGERED (inclusive)', () => {
    const current = currentMetricsFixture({ account: { dailyLoss: 500, startingBalance: 10_000 } });
    const result = evaluateDailyLossLimit(params, current);
    expect(result.status).toBe(RuleEvaluationStatus.TRIGGERED);
  });

  it('just below threshold → NOT_TRIGGERED', () => {
    const current = currentMetricsFixture({ account: { dailyLoss: 498, startingBalance: 10_000 } });
    expect(evaluateDailyLossLimit(params, current).status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('just above threshold → TRIGGERED', () => {
    const current = currentMetricsFixture({ account: { dailyLoss: 502, startingBalance: 10_000 } });
    expect(evaluateDailyLossLimit(params, current).status).toBe(RuleEvaluationStatus.TRIGGERED);
  });

  it('null startingBalance → INSUFFICIENT_DATA, never NOT_TRIGGERED', () => {
    const current = currentMetricsFixture({ account: { dailyLoss: 500, startingBalance: null } });
    expect(evaluateDailyLossLimit(params, current).status).toBe(RuleEvaluationStatus.INSUFFICIENT_DATA);
  });

  it('null dailyLoss → INSUFFICIENT_DATA', () => {
    const current = currentMetricsFixture({ account: { dailyLoss: null, startingBalance: 10_000 } });
    expect(evaluateDailyLossLimit(params, current).status).toBe(RuleEvaluationStatus.INSUFFICIENT_DATA);
  });

  it('zero startingBalance → INSUFFICIENT_DATA (never divides by zero)', () => {
    const current = currentMetricsFixture({ account: { dailyLoss: 0, startingBalance: 0 } });
    expect(evaluateDailyLossLimit(params, current).status).toBe(RuleEvaluationStatus.INSUFFICIENT_DATA);
  });

  it('zero dailyLoss (known, boring answer) → NOT_TRIGGERED, not insufficient', () => {
    const current = currentMetricsFixture({ account: { dailyLoss: 0, startingBalance: 10_000 } });
    expect(evaluateDailyLossLimit(params, current).status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('repeated evaluation with unchanged inputs is deterministic', () => {
    const current = currentMetricsFixture({ account: { dailyLoss: 600, startingBalance: 10_000 } });
    const r1 = evaluateDailyLossLimit(params, current);
    const r2 = evaluateDailyLossLimit(params, current);
    expect(r1).toEqual(r2);
  });
});
