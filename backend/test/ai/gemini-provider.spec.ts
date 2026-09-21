import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '../../src/ai/gemini-provider';
import { AlertContext } from '../../src/ai/ai-provider.interface';
import type { AiConfig } from '../../src/ai/ai.config';

const config: AiConfig = {
  enabled: true,
  provider: 'gemini',
  model: 'gemini-3.6-flash',
  apiKey: 'AQ.test-secret-12345',
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

function mockGeminiResponse(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

function candidateResponse(text: string, finishReason = 'STOP') {
  return { candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason }] };
}

describe('GeminiProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a valid candidate-text response into an AiAnalysisResult', async () => {
    mockGeminiResponse(200, candidateResponse(JSON.stringify(VALID_RESULT)));
    const provider = new GeminiProvider(config);
    await expect(provider.analyze(context)).resolves.toEqual(VALID_RESULT);
  });

  it('extracts JSON even if the model wraps it in prose or a code fence', async () => {
    const wrapped = 'Here is the analysis:\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```';
    mockGeminiResponse(200, candidateResponse(wrapped));
    const provider = new GeminiProvider(config);
    await expect(provider.analyze(context)).resolves.toEqual(VALID_RESULT);
  });

  it('throws on a non-2xx response', async () => {
    mockGeminiResponse(500, { error: { message: 'server error' } });
    const provider = new GeminiProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/500/);
  });

  it('throws on a 429 (rate limit) the same way as any other non-2xx — the caller (BullMQ / FallbackAiProvider) handles it', async () => {
    mockGeminiResponse(429, { error: { message: 'rate limited' } });
    const provider = new GeminiProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/429/);
  });

  it('throws a clear error when the prompt was blocked (200 OK, no candidates)', async () => {
    mockGeminiResponse(200, { promptFeedback: { blockReason: 'SAFETY' } });
    const provider = new GeminiProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/blocked.*SAFETY/i);
  });

  it('throws on a response with no candidate content, naming the finishReason', async () => {
    mockGeminiResponse(200, { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] });
    const provider = new GeminiProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/MAX_TOKENS/);
  });

  it('throws on malformed JSON in the candidate text', async () => {
    mockGeminiResponse(200, candidateResponse('not json at all {{{'));
    const provider = new GeminiProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow();
  });

  it('rejects a schema-invalid result (e.g. missing a required field)', async () => {
    const { situation_summary, ...incomplete } = VALID_RESULT;
    mockGeminiResponse(200, candidateResponse(JSON.stringify(incomplete)));
    const provider = new GeminiProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/situation_summary/);
  });

  it('never includes the API key in a thrown error message, for any failure path — critical here since Gemini puts the key in the URL', async () => {
    mockGeminiResponse(401, { error: { message: `bad key ${config.apiKey}` } });
    const provider = new GeminiProvider(config);
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
    const provider = new GeminiProvider(config);
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
    const provider = new GeminiProvider({ ...config, requestTimeoutMs: 50 });
    await expect(provider.analyze(context)).rejects.toThrow();
  });
});
