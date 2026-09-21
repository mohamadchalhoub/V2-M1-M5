import { describe, expect, it } from 'vitest';
import { evaluateNoStopLoss } from '../../../src/rules/evaluators/no-stop-loss.evaluator';
import { RuleEvaluationStatus } from '../../../src/rules/types/rule-engine.types';
import { currentMetricsFixture } from '../fixtures';

describe('evaluateNoStopLoss', () => {
  it('no open positions → NOT_TRIGGERED', () => {
    const current = currentMetricsFixture({ position: { openPositionsWithoutStopLoss: 0 } });
    const result = evaluateNoStopLoss({}, current);
    expect(result.status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
    expect(result.reasonCode).toBe('ALL_POSITIONS_PROTECTED');
  });

  it('one unprotected open position → TRIGGERED', () => {
    const current = currentMetricsFixture({ position: { openPositionsWithoutStopLoss: 1 } });
    const result = evaluateNoStopLoss({}, current);
    expect(result.status).toBe(RuleEvaluationStatus.TRIGGERED);
    expect(result.reasonCode).toBe('POSITIONS_WITHOUT_STOP_LOSS');
    expect(result.triggerValues.openPositionsWithoutStopLoss).toBe(1);
  });

  it('multiple unprotected positions → TRIGGERED, count reflected in triggerValues', () => {
    const current = currentMetricsFixture({ position: { openPositionsWithoutStopLoss: 3 } });
    expect(evaluateNoStopLoss({}, current).triggerValues.openPositionsWithoutStopLoss).toBe(3);
  });

  it('never returns INSUFFICIENT_DATA — the count is always a known value', () => {
    const current = currentMetricsFixture({ position: { openPositionsWithoutStopLoss: 0 } });
    expect(evaluateNoStopLoss({}, current).status).not.toBe(RuleEvaluationStatus.INSUFFICIENT_DATA);
  });

  it('repeated evaluation with unchanged inputs is deterministic', () => {
    const current = currentMetricsFixture({ position: { openPositionsWithoutStopLoss: 2 } });
    expect(evaluateNoStopLoss({}, current)).toEqual(evaluateNoStopLoss({}, current));
  });
});
