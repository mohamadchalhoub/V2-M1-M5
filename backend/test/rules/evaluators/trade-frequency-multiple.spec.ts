import { describe, expect, it } from 'vitest';
import { evaluateTradeFrequencyMultiple } from '../../../src/rules/evaluators/trade-frequency-multiple.evaluator';
import { RuleEvaluationStatus } from '../../../src/rules/types/rule-engine.types';
import { historicalBaselinesFixture } from '../fixtures';

describe('evaluateTradeFrequencyMultiple', () => {
  const params = { factor: 2, window_minutes: 60 };

  it('normal condition, well below threshold → NOT_TRIGGERED', () => {
    const baseline = historicalBaselinesFixture({ averageTradesPerHour: 2 }); // threshold = 2*2 = 4
    const result = evaluateTradeFrequencyMultiple(params, baseline, { tradesInWindow: 2 });
    expect(result.status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('exactly at threshold → TRIGGERED (inclusive)', () => {
    const baseline = historicalBaselinesFixture({ averageTradesPerHour: 2 }); // threshold = 4
    const result = evaluateTradeFrequencyMultiple(params, baseline, { tradesInWindow: 4 });
    expect(result.status).toBe(RuleEvaluationStatus.TRIGGERED);
  });

  it('just below threshold → NOT_TRIGGERED', () => {
    const baseline = historicalBaselinesFixture({ averageTradesPerHour: 2 });
    const result = evaluateTradeFrequencyMultiple(params, baseline, { tradesInWindow: 3 });
    expect(result.status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('just above threshold → TRIGGERED', () => {
    const baseline = historicalBaselinesFixture({ averageTradesPerHour: 2 });
    const result = evaluateTradeFrequencyMultiple(params, baseline, { tradesInWindow: 5 });
    expect(result.status).toBe(RuleEvaluationStatus.TRIGGERED);
  });

  it('null averageTradesPerHour (brand-new account) → INSUFFICIENT_DATA', () => {
    const baseline = historicalBaselinesFixture({ averageTradesPerHour: null });
    const result = evaluateTradeFrequencyMultiple(params, baseline, { tradesInWindow: 10 });
    expect(result.status).toBe(RuleEvaluationStatus.INSUFFICIENT_DATA);
  });

  it('zero averageTradesPerHour → INSUFFICIENT_DATA, never a trivially-satisfied >= 0', () => {
    const baseline = historicalBaselinesFixture({ averageTradesPerHour: 0 });
    const result = evaluateTradeFrequencyMultiple(params, baseline, { tradesInWindow: 1 });
    expect(result.status).toBe(RuleEvaluationStatus.INSUFFICIENT_DATA);
  });

  it('tradesInWindow not provided by the orchestrator → INSUFFICIENT_DATA, not treated as 0', () => {
    const baseline = historicalBaselinesFixture({ averageTradesPerHour: 2 });
    const result = evaluateTradeFrequencyMultiple(params, baseline, {});
    expect(result.status).toBe(RuleEvaluationStatus.INSUFFICIENT_DATA);
  });

  it('a window shorter than an hour scales the baseline down correctly', () => {
    // window_minutes=30, averageTradesPerHour=4 → baselineForWindow=2, factor=3 → threshold=6
    const baseline = historicalBaselinesFixture({ averageTradesPerHour: 4 });
    const result = evaluateTradeFrequencyMultiple({ factor: 3, window_minutes: 30 }, baseline, {
      tradesInWindow: 6,
    });
    expect(result.status).toBe(RuleEvaluationStatus.TRIGGERED);
  });

  it('repeated evaluation with unchanged inputs is deterministic', () => {
    const baseline = historicalBaselinesFixture({ averageTradesPerHour: 2 });
    const extra = { tradesInWindow: 6 };
    expect(evaluateTradeFrequencyMultiple(params, baseline, extra)).toEqual(
      evaluateTradeFrequencyMultiple(params, baseline, extra),
    );
  });
});
