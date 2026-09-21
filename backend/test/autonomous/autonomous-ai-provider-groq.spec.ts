import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutonomousGroqProvider } from '../../src/autonomous/autonomous-ai-provider-groq';
import { AutonomousAiContext } from '../../src/autonomous/autonomous-ai-decision.types';
import type { AiConfig } from '../../src/ai/ai.config';

const config: AiConfig = {
  enabled: true,
  provider: 'gemini',
  model: 'openai/gpt-oss-120b',
  apiKey: 'gsk-test-secret-12345',
  requestTimeoutMs: 2000,
  fallbacks: [],
};

const context: AutonomousAiContext = {
  now: new Date('2026-01-01T00:00:00Z'),
  currentPrice: { bid: 1.1, ask: 1.1002 },
  h4Levels: {
    referenceWeekStart: new Date('2025-12-22T00:00:00Z'),
    referenceWeekEnd: new Date('2025-12-29T00:00:00Z'),
    resistance: 1.12,
    support: 1.1,
    candleCount: 42,
  },
  d1Levels: {
    referenceWeekStart: new Date('2025-12-22T00:00:00Z'),
    referenceWeekEnd: new Date('2025-12-29T00:00:00Z'),
    resistance: 1.121,
    support: 1.099,
    candleCount: 7,
  },
  supportState: 'READY',
  resistanceState: 'NOT_TOUCHED',
  mechanicalCandidateLevel: 'SUPPORT',
  historicalPattern: {
    symbol: 'EURUSD',
    buy: { sampleSize: 0, winRate: null, averagePnl: null, confidence: 'LOW' },
    sell: { sampleSize: 0, winRate: null, averagePnl: null, confidence: 'LOW' },
  },
  upcomingEvents: [],
  recentNews: [],
  ordersPlacedToday: 0,
};

const VALID_RAW_DECISION = {
  action: 'HOLD',
  confidence: 0.4,
  entry_price: null,
  stop_loss: null,
  take_profit: null,
  position_size: null,
  reasoning: 'no confluence',
};

function mockGroqResponse(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('AutonomousGroqProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a valid message-content response into a RawAutonomousAiDecision', async () => {
    mockGroqResponse(200, { choices: [{ message: { content: JSON.stringify(VALID_RAW_DECISION) } }] });
    const provider = new AutonomousGroqProvider(config);
    await expect(provider.decide(context)).resolves.toEqual(VALID_RAW_DECISION);
  });

  it('sends temperature: 0, response_format: json_object, and the autonomous system prompt', async () => {
    const fetchSpy = mockGroqResponse(200, { choices: [{ message: { content: JSON.stringify(VALID_RAW_DECISION) } }] });
    const provider = new AutonomousGroqProvider(config);
    await provider.decide(context);

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.temperature).toBe(0);
    // Regression: 1024 was too low for a reasoning-model fallback plus this
    // schema's substantive `reasoning` field — caused a 100% truncated/
    // invalid-JSON failure rate live this session (see the code comment).
    expect(body.max_tokens).toBe(4096);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('EURUSD only');
    expect(body.messages[1].content).toContain('"symbol": "EURUSD"');
  });

  it('throws on a non-2xx response', async () => {
    mockGroqResponse(429, { error: { message: 'rate limited' } });
    const provider = new AutonomousGroqProvider(config);
    await expect(provider.decide(context)).rejects.toThrow(/429/);
  });

  it('throws on a 200 response carrying a top-level embedded error', async () => {
    mockGroqResponse(200, { error: { message: 'model overloaded, try again' } });
    const provider = new AutonomousGroqProvider(config);
    await expect(provider.decide(context)).rejects.toThrow(/model overloaded/);
  });

  it('throws on a response with no message content', async () => {
    mockGroqResponse(200, { choices: [{ message: {} }] });
    const provider = new AutonomousGroqProvider(config);
    await expect(provider.decide(context)).rejects.toThrow(/no message content/);
  });

  it('throws on malformed JSON in the content', async () => {
    mockGroqResponse(200, { choices: [{ message: { content: 'not json at all {{{' } }] });
    const provider = new AutonomousGroqProvider(config);
    await expect(provider.decide(context)).rejects.toThrow();
  });

  it('never includes the API key in a thrown error message, for any failure path', async () => {
    mockGroqResponse(401, { error: { message: `bad key ${config.apiKey}` } });
    const provider = new AutonomousGroqProvider(config);
    try {
      await provider.decide(context);
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(config.apiKey);
    }
  });

  it('never includes the API key in a network-error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error(`connection refused — key ${config.apiKey} in context`);
    });
    const provider = new AutonomousGroqProvider(config);
    try {
      await provider.decide(context);
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
    const provider = new AutonomousGroqProvider({ ...config, requestTimeoutMs: 50 });
    await expect(provider.decide(context)).rejects.toThrow();
  });
});
