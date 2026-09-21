import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider } from '../../src/ai/openrouter-provider';
import { AlertContext } from '../../src/ai/ai-provider.interface';
import type { AiConfig } from '../../src/ai/ai.config';

const config: AiConfig = {
  enabled: true,
  provider: 'openrouter',
  model: 'nvidia/nemotron-3-super-120b-a12b:free',
  apiKey: 'sk-or-v1-test-secret-12345',
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

function mockOpenRouterResponse(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('OpenRouterProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a valid message-content response into an AiAnalysisResult', async () => {
    mockOpenRouterResponse(200, { choices: [{ message: { content: JSON.stringify(VALID_RESULT) } }] });
    const provider = new OpenRouterProvider(config);
    await expect(provider.analyze(context)).resolves.toEqual(VALID_RESULT);
  });

  it('ignores a separate `reasoning` field and only reads `content` (reasoning models put chain-of-thought there)', async () => {
    mockOpenRouterResponse(200, {
      choices: [{ message: { content: JSON.stringify(VALID_RESULT), reasoning: 'not json at all, just thinking...' } }],
    });
    const provider = new OpenRouterProvider(config);
    await expect(provider.analyze(context)).resolves.toEqual(VALID_RESULT);
  });

  it('extracts JSON even if the model wraps it in prose or a code fence', async () => {
    const wrapped = 'Here is the analysis:\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```';
    mockOpenRouterResponse(200, { choices: [{ message: { content: wrapped } }] });
    const provider = new OpenRouterProvider(config);
    await expect(provider.analyze(context)).resolves.toEqual(VALID_RESULT);
  });

  it('throws on a non-2xx response', async () => {
    mockOpenRouterResponse(500, { error: { message: 'server error' } });
    const provider = new OpenRouterProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/500/);
  });

  it('throws on a 429 (free-tier rate limit) the same way as any other non-2xx — the caller (BullMQ) retries', async () => {
    mockOpenRouterResponse(429, { error: { message: 'rate-limited upstream' } });
    const provider = new OpenRouterProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/429/);
  });

  it('throws on a 200 response carrying a top-level embedded error (upstream provider failure surfaced without a non-2xx status)', async () => {
    mockOpenRouterResponse(200, { error: { message: 'Upstream error from Nvidia: Service temporarily overloaded', code: 502 } });
    const provider = new OpenRouterProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/Upstream error from Nvidia/);
  });

  it('throws on a 200 response carrying a per-choice embedded error', async () => {
    mockOpenRouterResponse(200, { choices: [{ message: {}, error: { message: 'model unavailable', code: 503 }, finish_reason: 'error' }] });
    const provider = new OpenRouterProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/model unavailable/);
  });

  it('never includes the API key in an embedded-error message', async () => {
    mockOpenRouterResponse(200, { error: { message: `upstream rejected key ${config.apiKey}` } });
    const provider = new OpenRouterProvider(config);
    try {
      await provider.analyze(context);
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(config.apiKey);
    }
  });

  it('throws on a response with no message content', async () => {
    mockOpenRouterResponse(200, { choices: [{ message: {} }] });
    const provider = new OpenRouterProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/no message content/);
  });

  it('throws on malformed JSON in the content', async () => {
    mockOpenRouterResponse(200, { choices: [{ message: { content: 'not json at all {{{' } }] });
    const provider = new OpenRouterProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow();
  });

  it('rejects a schema-invalid result (e.g. missing a required field)', async () => {
    const { situation_summary, ...incomplete } = VALID_RESULT;
    mockOpenRouterResponse(200, { choices: [{ message: { content: JSON.stringify(incomplete) } }] });
    const provider = new OpenRouterProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/situation_summary/);
  });

  it('never includes the API key in a thrown error message, for any failure path', async () => {
    mockOpenRouterResponse(401, { error: { message: `bad key ${config.apiKey}` } });
    const provider = new OpenRouterProvider(config);
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
    const provider = new OpenRouterProvider(config);
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
    const provider = new OpenRouterProvider({ ...config, requestTimeoutMs: 50 });
    await expect(provider.analyze(context)).rejects.toThrow();
  });
});
