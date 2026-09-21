import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../../src/ai/anthropic-provider';
import { AlertContext } from '../../src/ai/ai-provider.interface';
import type { AiConfig } from '../../src/ai/ai.config';

const config: AiConfig = {
  enabled: true,
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  apiKey: 'sk-test-secret-12345',
  requestTimeoutMs: 2000,
};

const context: AlertContext = {
  alertId: 'a1',
  ruleType: 'DRAWDOWN',
  ruleName: 'drawdown guard',
  triggerValues: { drawdown: 0.038 },
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

const VALID_RESULT = {
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

function mockAnthropicResponse(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('AnthropicProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a valid text-JSON response into an AiAnalysisResult', async () => {
    mockAnthropicResponse(200, { content: [{ type: 'text', text: JSON.stringify(VALID_RESULT) }] });
    const provider = new AnthropicProvider(config);
    await expect(provider.analyze(context)).resolves.toEqual(VALID_RESULT);
  });

  it('extracts JSON even if the model wraps it in prose or a code fence', async () => {
    const wrapped = 'Here is the analysis:\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```';
    mockAnthropicResponse(200, { content: [{ type: 'text', text: wrapped }] });
    const provider = new AnthropicProvider(config);
    await expect(provider.analyze(context)).resolves.toEqual(VALID_RESULT);
  });

  it('throws on a non-2xx response', async () => {
    mockAnthropicResponse(500, { error: 'server error' });
    const provider = new AnthropicProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/500/);
  });

  it('throws on a response with no text content block', async () => {
    mockAnthropicResponse(200, { content: [] });
    const provider = new AnthropicProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/no text content/);
  });

  it('throws on malformed JSON in the text block', async () => {
    mockAnthropicResponse(200, { content: [{ type: 'text', text: 'not json at all {{{' }] });
    const provider = new AnthropicProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow();
  });

  it('rejects a schema-invalid result (e.g. missing a required field)', async () => {
    const { situation_summary, ...incomplete } = VALID_RESULT;
    mockAnthropicResponse(200, { content: [{ type: 'text', text: JSON.stringify(incomplete) }] });
    const provider = new AnthropicProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/situation_summary/);
  });

  it('never includes the API key in a thrown error message, for any failure path', async () => {
    mockAnthropicResponse(401, { error: `bad key ${config.apiKey}` });
    const provider = new AnthropicProvider(config);
    try {
      await provider.analyze(context);
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(config.apiKey);
    }
  });

  it('never includes the API key in a network-error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error(`connection refused — key ${config.apiKey} in context`);
    });
    const provider = new AnthropicProvider(config);
    try {
      await provider.analyze(context);
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(config.apiKey);
    }
  });

  it('times out and rejects if the request takes longer than requestTimeoutMs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit)?.signal;
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const provider = new AnthropicProvider({ ...config, requestTimeoutMs: 50 });
    await expect(provider.analyze(context)).rejects.toThrow();
  });
});
