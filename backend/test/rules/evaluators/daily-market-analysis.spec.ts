import { describe, expect, it } from 'vitest';
import { evaluateDailyMarketAnalysis } from '../../../src/rules/evaluators/daily-market-analysis.evaluator';
import { DailyMarketAnalysisPayload } from '../../../src/rules/types/rule-engine.types';

function payload(): DailyMarketAnalysisPayload {
  return {
    symbol: 'EURUSD',
    currentPrice: 1.1,
    marketBias: 'BULLISH',
    biasConfidence: 0.667,
    biasReasons: ['H4 Ichimoku trend condition is bullish (price above the cloud)'],
    fibonacci: {
      swingHigh: 1.15,
      swingLow: 1.05,
      direction: 'BULLISH',
      levels: [{ ratio: 0.618, price: 1.0882 }],
      nearestLevelRatio: 0.618,
      nearestLevelPrice: 1.0882,
    },
    supportResistance: [{ timeframe: 'H4', levelType: 'RESISTANCE', price: 1.12 }],
    ichimoku: [{ timeframe: 'H4', position: 'ABOVE_CLOUD', spanA: 1.09, spanB: 1.08 }],
    upcomingEconomicEvents: [],
    recentNews: [],
    timestamp: '2026-09-05T05:00:00.000Z',
  };
}

describe('evaluateDailyMarketAnalysis', () => {
  it('INSUFFICIENT_DATA when the daily analysis was not computed', () => {
    const result = evaluateDailyMarketAnalysis({}, {});
    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.reasonCode).toBe('DAILY_ANALYSIS_NOT_COMPUTED');
  });

  it('always TRIGGERED once the analysis is computed — a scheduled report, not a threshold', () => {
    const result = evaluateDailyMarketAnalysis({}, { dailyMarketAnalysis: payload() });
    expect(result.status).toBe('TRIGGERED');
    expect(result.reasonCode).toBe('DAILY_MARKET_ANALYSIS_GENERATED');
  });

  it('triggerValues carries the full analysis payload through unmodified', () => {
    const p = payload();
    const result = evaluateDailyMarketAnalysis({}, { dailyMarketAnalysis: p });
    expect(result.triggerValues).toEqual(p);
  });
});
