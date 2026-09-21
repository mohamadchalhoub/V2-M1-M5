import { describe, expect, it } from 'vitest';
import { evaluateConcentration } from '../../../src/rules/evaluators/concentration.evaluator';
import { RuleEvaluationStatus } from '../../../src/rules/types/rule-engine.types';
import { currentMetricsFixture } from '../fixtures';

describe('evaluateConcentration', () => {
  const params = { threshold_pct: 0.7 };

  it('no open positions → NOT_TRIGGERED (nothing to concentrate), not insufficient data', () => {
    const current = currentMetricsFixture({
      position: { maximumSymbolConcentrationPct: null, maximumDirectionConcentrationPct: null },
    });
    const result = evaluateConcentration(params, current);
    expect(result.status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
    expect(result.reasonCode).toBe('NO_OPEN_POSITIONS');
  });

  it('well-diversified positions, both below threshold → NOT_TRIGGERED', () => {
    const current = currentMetricsFixture({
      position: { maximumSymbolConcentrationPct: 0.4, maximumDirectionConcentrationPct: 0.5 },
    });
    expect(evaluateConcentration(params, current).status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('symbol concentration at the threshold (inclusive) → TRIGGERED', () => {
    const current = currentMetricsFixture({
      position: { maximumSymbolConcentrationPct: 0.7, maximumDirectionConcentrationPct: 0.3 },
    });
    const result = evaluateConcentration(params, current);
    expect(result.status).toBe(RuleEvaluationStatus.TRIGGERED);
    expect(result.reasonCode).toBe('SYMBOL_CONCENTRATION_ABOVE_THRESHOLD');
  });

  it('direction concentration above threshold (e.g. 100% BUY) → TRIGGERED', () => {
    const current = currentMetricsFixture({
      position: { maximumSymbolConcentrationPct: 0.3, maximumDirectionConcentrationPct: 1.0 },
    });
    const result = evaluateConcentration(params, current);
    expect(result.status).toBe(RuleEvaluationStatus.TRIGGERED);
    expect(result.reasonCode).toBe('DIRECTION_CONCENTRATION_ABOVE_THRESHOLD');
  });

  it('both symbol and direction concentration above threshold (a single position) → TRIGGERED, combined reason', () => {
    const current = currentMetricsFixture({
      position: { maximumSymbolConcentrationPct: 1.0, maximumDirectionConcentrationPct: 1.0 },
    });
    const result = evaluateConcentration(params, current);
    expect(result.status).toBe(RuleEvaluationStatus.TRIGGERED);
    expect(result.reasonCode).toBe('SYMBOL_AND_DIRECTION_CONCENTRATION_ABOVE_THRESHOLD');
  });

  it('just below threshold → NOT_TRIGGERED', () => {
    const current = currentMetricsFixture({
      position: { maximumSymbolConcentrationPct: 0.69, maximumDirectionConcentrationPct: 0.2 },
    });
    expect(evaluateConcentration(params, current).status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('repeated evaluation with unchanged inputs is deterministic', () => {
    const current = currentMetricsFixture({
      position: { maximumSymbolConcentrationPct: 0.8, maximumDirectionConcentrationPct: 0.8 },
    });
    expect(evaluateConcentration(params, current)).toEqual(evaluateConcentration(params, current));
  });
});
