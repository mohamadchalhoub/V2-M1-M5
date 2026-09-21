import { describe, expect, it } from 'vitest';
import { MockAiProvider } from '../../src/ai/mock-provider';
import { AlertContext } from '../../src/ai/ai-provider.interface';
import { validateAiAnalysisResult } from '../../src/ai/validate-ai-result';
import { checkSafety } from '../../src/ai/safety-filter';

const context: AlertContext = {
  alertId: 'a1',
  ruleType: 'DRAWDOWN',
  ruleName: 'drawdown guard',
  triggerValues: { drawdown: 0.038 },
  baselineSnapshot: {},
  triggeredAt: new Date('2026-01-01T00:00:00Z'),
  similarPastEvents: [{ alertId: 'a0', triggeredAt: new Date('2025-12-01T00:00:00Z'), briefOutcome: 'resolved' }],
  marketContext: { exposedCurrencies: [], upcomingHighImpactEvents: [], recentNews: [] },
  historicalPatternContext: {
    symbol: 'EURUSD',
    buy: { sampleSize: 0, winRate: null, averagePnl: null, confidence: 'LOW' },
    sell: { sampleSize: 0, winRate: null, averagePnl: null, confidence: 'LOW' },
  },
};

describe('MockAiProvider', () => {
  it('returns a result deterministically, with no network call', async () => {
    const provider = new MockAiProvider();
    const first = await provider.analyze(context);
    const second = await provider.analyze(context);
    expect(first).toEqual(second);
  });

  it('produces output that passes the same validation and safety gates a real provider must pass', async () => {
    const provider = new MockAiProvider();
    const result = await provider.analyze(context);

    const validated = validateAiAnalysisResult(result);
    expect(['MONITOR', 'REDUCE_RISK', 'AVOID_NEW_EXPOSURE', 'REVIEW_POSITION']).toContain(validated.recommended_action);

    const safety = checkSafety(validated);
    expect(safety.flagged).toBe(false);
  });

  it('carries similarPastEvents through from the context it was given', async () => {
    const provider = new MockAiProvider();
    const result = await provider.analyze(context);
    expect(result.similar_past_events).toEqual([
      { alert_id: 'a0', triggered_at: '2025-12-01T00:00:00.000Z', brief_outcome: 'resolved' },
    ]);
  });
});
