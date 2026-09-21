import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroqProvider } from '../../src/ai/groq-provider';
import { AlertContext } from '../../src/ai/ai-provider.interface';
import type { AiConfig } from '../../src/ai/ai.config';

const config: AiConfig = {
  enabled: true,
  provider: 'gemini',
  model: 'openai/gpt-oss-120b',
  apiKey: 'gsk-test-secret-12345',
  requestTimeoutMs: 2000,
  fallbacks: [],
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

function mockGroqResponse(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('GroqProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a valid message-content response into an AiAnalysisResult', async () => {
    mockGroqResponse(200, { choices: [{ message: { content: JSON.stringify(VALID_RESULT) } }] });
    const provider = new GroqProvider(config);
    await expect(provider.analyze(context)).resolves.toEqual(VALID_RESULT);
  });

  it('sends response_format: json_object and reads only .content, ignoring a separate .reasoning field (gpt-oss puts chain-of-thought there)', async () => {
    const fetchSpy = mockGroqResponse(200, {
      choices: [{ message: { content: JSON.stringify(VALID_RESULT), reasoning: 'thinking out loud, not json' } }],
    });
    const provider = new GroqProvider(config);
    await expect(provider.analyze(context)).resolves.toEqual(VALID_RESULT);

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.model).toBe(config.model);
  });

  it('extracts JSON even if the model wraps it in prose or a code fence', async () => {
    const wrapped = 'Here is the analysis:\n```json\n' + JSON.stringify(VALID_RESULT) + '\n```';
    mockGroqResponse(200, { choices: [{ message: { content: wrapped } }] });
    const provider = new GroqProvider(config);
    await expect(provider.analyze(context)).resolves.toEqual(VALID_RESULT);
  });

  it('throws on a non-2xx response', async () => {
    mockGroqResponse(503, { error: { message: 'server overloaded' } });
    const provider = new GroqProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/503/);
  });

  it('throws on a 429 (rate limit)', async () => {
    mockGroqResponse(429, { error: { message: 'rate limited' } });
    const provider = new GroqProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/429/);
  });

  it('throws on a 200 response carrying a top-level embedded error', async () => {
    mockGroqResponse(200, { error: { message: 'model overloaded, try again' } });
    const provider = new GroqProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/model overloaded/);
  });

  it('throws on a response with no message content', async () => {
    mockGroqResponse(200, { choices: [{ message: {} }] });
    const provider = new GroqProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/no message content/);
  });

  it('throws on malformed JSON in the content', async () => {
    mockGroqResponse(200, { choices: [{ message: { content: 'not json at all {{{' } }] });
    const provider = new GroqProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow();
  });

  it('rejects a schema-invalid result (e.g. missing a required field)', async () => {
    const { situation_summary, ...incomplete } = VALID_RESULT;
    mockGroqResponse(200, { choices: [{ message: { content: JSON.stringify(incomplete) } }] });
    const provider = new GroqProvider(config);
    await expect(provider.analyze(context)).rejects.toThrow(/situation_summary/);
  });

  it('never includes the API key in a thrown error message, for any failure path', async () => {
    mockGroqResponse(401, { error: { message: `bad key ${config.apiKey}` } });
    const provider = new GroqProvider(config);
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
    const provider = new GroqProvider(config);
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
    const provider = new GroqProvider({ ...config, requestTimeoutMs: 50 });
    await expect(provider.analyze(context)).rejects.toThrow();
  });
});
