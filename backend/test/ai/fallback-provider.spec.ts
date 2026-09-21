import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FallbackAiProvider } from '../../src/ai/fallback-provider';
import { AiAnalysisResult, AiProvider, AlertContext } from '../../src/ai/ai-provider.interface';

const context: AlertContext = {
  alertId: 'a1',
  ruleType: 'DRAWDOWN',
  ruleName: 'drawdown guard',
  triggerValues: {},
  baselineSnapshot: {},
  triggeredAt: new Date('2026-01-01T00:00:00Z'),
  similarPastEvents: [],
  marketContext: { exposedCurrencies: [], upcomingHighImpactEvents: [], recentNews: [] },
  historicalPatternContext: {
    symbol: 'EURUSD',
    buy: { sampleSize: 0, winRate: null, averagePnl: null, confidence: 'LOW' },
    sell: { sampleSize: 0, winRate: null, averagePnl: null, confidence: 'LOW' },
  },
};

const RESULT: AiAnalysisResult = {
  situation_summary: 's',
  historical_comparison: 'h',
  similar_past_events: [],
  statistical_context: 'c',
  market_risk: 'LOW',
  exposure_risk: 'LOW',
  event_risk: 'LOW',
  news_sentiment: 'NEUTRAL',
  confidence: 0.5,
  assessment: 'a',
  recommended_action: 'MONITOR',
};

function fakeProvider(behavior: 'succeed' | 'fail'): AiProvider {
  return {
    analyze: vi.fn(async () => {
      if (behavior === 'fail') throw new Error('provider unavailable');
      return RESULT;
    }),
  };
}

describe('FallbackAiProvider', () => {
  it('returns the first provider\'s result without calling the second, when the first succeeds', async () => {
    const first = fakeProvider('succeed');
    const second = fakeProvider('succeed');
    const provider = new FallbackAiProvider([first, second]);

    await expect(provider.analyze(context)).resolves.toEqual(RESULT);
    expect(second.analyze).not.toHaveBeenCalled();
  });

  it('falls back to the second provider when the first fails', async () => {
    const first = fakeProvider('fail');
    const second = fakeProvider('succeed');
    const provider = new FallbackAiProvider([first, second]);

    await expect(provider.analyze(context)).resolves.toEqual(RESULT);
    expect(first.analyze).toHaveBeenCalledOnce();
    expect(second.analyze).toHaveBeenCalledOnce();
  });

  it('throws the last provider\'s error when every provider in the chain fails', async () => {
    const first = fakeProvider('fail');
    const second = fakeProvider('fail');
    const provider = new FallbackAiProvider([first, second]);

    await expect(provider.analyze(context)).rejects.toThrow('provider unavailable');
  });

  it('works with a single provider (no fallback configured) — behaves exactly like that provider alone', async () => {
    const only = fakeProvider('succeed');
    const provider = new FallbackAiProvider([only]);
    await expect(provider.analyze(context)).resolves.toEqual(RESULT);
  });

  it('rejects construction with an empty provider list', () => {
    expect(() => new FallbackAiProvider([])).toThrow(/at least one provider/);
  });

  describe('retry (reliability pass)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries a transient failure on the first provider (2s/4s/8s backoff) before falling back — a real recovery never reaches the second provider', async () => {
      const first: AiProvider = {
        analyze: vi.fn().mockRejectedValueOnce(new Error('503 Service Unavailable')).mockResolvedValueOnce(RESULT),
      };
      const second = fakeProvider('succeed');
      const provider = new FallbackAiProvider([first, second]);

      const promise = provider.analyze(context);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(promise).resolves.toEqual(RESULT);
      expect(first.analyze).toHaveBeenCalledTimes(2);
      expect(second.analyze).not.toHaveBeenCalled();
    });

    it('exhausts all 4 attempts (1 + 3 retries) on a persistently transient first provider, then falls back to the second', async () => {
      const first: AiProvider = { analyze: vi.fn().mockRejectedValue(new Error('429 rate limit')) };
      const second = fakeProvider('succeed');
      const provider = new FallbackAiProvider([first, second]);

      const promise = provider.analyze(context);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);
      await vi.advanceTimersByTimeAsync(8000);
      await expect(promise).resolves.toEqual(RESULT);
      expect(first.analyze).toHaveBeenCalledTimes(4);
      expect(second.analyze).toHaveBeenCalledOnce();
    });

    it('does not retry a non-transient failure — falls back to the second provider immediately, no delay needed', async () => {
      const first = fakeProvider('fail'); // 'provider unavailable' — not transient
      const second = fakeProvider('succeed');
      const provider = new FallbackAiProvider([first, second]);

      await expect(provider.analyze(context)).resolves.toEqual(RESULT);
      expect(first.analyze).toHaveBeenCalledOnce();
    });
  });
});
