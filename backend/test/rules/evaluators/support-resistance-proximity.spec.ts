import { describe, expect, it } from 'vitest';
import { evaluateSupportResistanceProximity } from '../../../src/rules/evaluators/support-resistance-proximity.evaluator';
import { SupportResistanceProximitySignal } from '../../../src/rules/types/rule-engine.types';

function match(overrides: Partial<SupportResistanceProximitySignal> = {}): SupportResistanceProximitySignal {
  return {
    timeframe: 'H4',
    levelType: 'RESISTANCE',
    levelPrice: 1.1,
    currentPrice: 1.0996,
    distancePoints: 40,
    currentPriceIsAbove: false,
    trend: 'UNKNOWN',
    ...overrides,
  };
}

describe('evaluateSupportResistanceProximity', () => {
  it('INSUFFICIENT_DATA when extras were never computed', () => {
    const result = evaluateSupportResistanceProximity({}, {});
    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.reasonCode).toBe('SUPPORT_RESISTANCE_DATA_UNAVAILABLE');
  });

  it('NOT_TRIGGERED when no level is within proximity', () => {
    const result = evaluateSupportResistanceProximity({}, { supportResistanceMatches: [] });
    expect(result.status).toBe('NOT_TRIGGERED');
    expect(result.reasonCode).toBe('NO_LEVEL_WITHIN_PROXIMITY');
  });

  it('TRIGGERED with the nearest match leading triggerValues', () => {
    const near = match({ distancePoints: 10, levelPrice: 1.0997 });
    const far = match({ distancePoints: 45, levelPrice: 1.1045 });
    const result = evaluateSupportResistanceProximity({}, { supportResistanceMatches: [near, far] });
    expect(result.status).toBe('TRIGGERED');
    expect(result.reasonCode).toBe('PRICE_NEAR_SUPPORT_RESISTANCE_LEVEL');
    expect(result.triggerValues).toMatchObject({
      symbol: 'EURUSD',
      timeframe: 'H4',
      levelType: 'RESISTANCE',
      levelPrice: 1.0997,
      distancePoints: 10,
    });
    expect((result.triggerValues.allMatches as unknown[])).toHaveLength(2);
  });

  it('reports direction ABOVE/BELOW from currentPriceIsAbove', () => {
    const above = evaluateSupportResistanceProximity({}, { supportResistanceMatches: [match({ currentPriceIsAbove: true })] });
    expect(above.triggerValues.direction).toBe('ABOVE');
    const below = evaluateSupportResistanceProximity({}, { supportResistanceMatches: [match({ currentPriceIsAbove: false })] });
    expect(below.triggerValues.direction).toBe('BELOW');
  });

  it('passes the nearest match\'s trend through to triggerValues unchanged', () => {
    const result = evaluateSupportResistanceProximity({}, { supportResistanceMatches: [match({ trend: 'APPROACHING' })] });
    expect(result.triggerValues.trend).toBe('APPROACHING');
  });
});
