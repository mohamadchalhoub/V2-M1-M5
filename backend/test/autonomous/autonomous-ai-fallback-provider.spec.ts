import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutonomousFallbackProvider } from '../../src/autonomous/autonomous-ai-fallback-provider';
import { AutonomousAiContext, AutonomousAiProvider, RawAutonomousAiDecision } from '../../src/autonomous/autonomous-ai-decision.types';

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
  d1Levels: null,
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

const DECISION: RawAutonomousAiDecision = {
  action: 'HOLD',
  confidence: 0.4,
  entry_price: null,
  stop_loss: null,
  take_profit: null,
  position_size: null,
  reasoning: 'no confluence',
};

function fakeProvider(behavior: 'succeed' | 'fail', providerName = 'fake'): AutonomousAiProvider {
  return {
    providerName,
    decide: vi.fn(async () => {
      if (behavior === 'fail') throw new Error('provider unavailable');
      return DECISION;
    }),
  };
}

describe('AutonomousFallbackProvider', () => {
  it("returns the first provider's result without calling the second, when the first succeeds", async () => {
    const first = fakeProvider('succeed');
    const second = fakeProvider('succeed');
    const provider = new AutonomousFallbackProvider([first, second]);

    await expect(provider.decide(context)).resolves.toEqual(DECISION);
    expect(second.decide).not.toHaveBeenCalled();
  });

  it('falls back to the second provider when the first fails (e.g. Gemini quota exhausted, second is Groq/OpenRouter)', async () => {
    const first = fakeProvider('fail');
    const second = fakeProvider('succeed');
    const provider = new AutonomousFallbackProvider([first, second]);

    await expect(provider.decide(context)).resolves.toEqual(DECISION);
    expect(first.decide).toHaveBeenCalledOnce();
    expect(second.decide).toHaveBeenCalledOnce();
  });

  it('throws the last provider\'s error when every provider in the chain fails', async () => {
    const first = fakeProvider('fail');
    const second = fakeProvider('fail');
    const provider = new AutonomousFallbackProvider([first, second]);

    await expect(provider.decide(context)).rejects.toThrow('provider unavailable');
  });

  it('works with a single provider (no fallback configured) — behaves exactly like that provider alone', async () => {
    const only = fakeProvider('succeed');
    const provider = new AutonomousFallbackProvider([only]);
    await expect(provider.decide(context)).resolves.toEqual(DECISION);
  });

  it('rejects construction with an empty provider list', () => {
    expect(() => new AutonomousFallbackProvider([])).toThrow(/at least one provider/);
  });

  // Audit finding: the decision log used to hardcode 'gemini' as the acting
  // provider regardless of which one in the chain actually answered —
  // `providerName` must reflect the TRUE source so the audit trail is
  // accurate when Gemini is down and Groq/OpenRouter answer instead.
  it("exposes providerName reflecting whichever provider actually answered, not always the first", async () => {
    const gemini = fakeProvider('fail', 'gemini');
    const groq = fakeProvider('succeed', 'groq');
    const provider = new AutonomousFallbackProvider([gemini, groq]);

    expect(provider.providerName).toBe('unknown'); // before any call
    await provider.decide(context);
    expect(provider.providerName).toBe('groq');
  });

  describe('retry (reliability pass)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries a transient failure on the first provider (2s/4s/8s backoff) before falling back — a real recovery never reaches the second provider', async () => {
      const first: AutonomousAiProvider = {
        providerName: 'fake',
        decide: vi.fn().mockRejectedValueOnce(new Error('503 Service Unavailable')).mockResolvedValueOnce(DECISION),
      };
      const second = fakeProvider('succeed');
      const provider = new AutonomousFallbackProvider([first, second]);

      const promise = provider.decide(context);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(promise).resolves.toEqual(DECISION);
      expect(first.decide).toHaveBeenCalledTimes(2);
      expect(second.decide).not.toHaveBeenCalled();
    });

    it('exhausts all 4 attempts (1 + 3 retries) on a persistently-quota-exhausted Gemini, then falls back to the second provider', async () => {
      const first: AutonomousAiProvider = { providerName: 'fake', decide: vi.fn().mockRejectedValue(new Error('Gemini returned 429: quota exceeded')) };
      const second = fakeProvider('succeed');
      const provider = new AutonomousFallbackProvider([first, second]);

      const promise = provider.decide(context);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);
      await vi.advanceTimersByTimeAsync(8000);
      await expect(promise).resolves.toEqual(DECISION);
      expect(first.decide).toHaveBeenCalledTimes(4);
      expect(second.decide).toHaveBeenCalledOnce();
    });

    it('does not retry a non-transient failure — falls back to the second provider immediately, no delay needed', async () => {
      const first = fakeProvider('fail'); // 'provider unavailable' — not transient
      const second = fakeProvider('succeed');
      const provider = new AutonomousFallbackProvider([first, second]);

      await expect(provider.decide(context)).resolves.toEqual(DECISION);
      expect(first.decide).toHaveBeenCalledOnce();
    });
  });

  describe('cooldown (reliability pass — avoids re-paying a failed provider\'s retry budget on every call in a tight loop)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('skips a provider that just failed on the NEXT call, going straight to the fallback without spending its retry budget again', async () => {
      const first: AutonomousAiProvider = { providerName: 'fake', decide: vi.fn().mockRejectedValue(new Error('provider unavailable')) };
      const second = fakeProvider('succeed');
      const provider = new AutonomousFallbackProvider([first, second], 60_000);

      await expect(provider.decide(context)).resolves.toEqual(DECISION);
      expect(first.decide).toHaveBeenCalledOnce();

      // Second call, well within the 60s cooldown — `first` should not be
      // invoked at all this time.
      await expect(provider.decide(context)).resolves.toEqual(DECISION);
      expect(first.decide).toHaveBeenCalledOnce();
      expect(second.decide).toHaveBeenCalledTimes(2);
    });

    it('tries the previously-failed provider again once its cooldown has elapsed', async () => {
      const first: AutonomousAiProvider = { providerName: 'fake', decide: vi.fn().mockRejectedValueOnce(new Error('provider unavailable')).mockResolvedValueOnce(DECISION) };
      const second = fakeProvider('succeed');
      const provider = new AutonomousFallbackProvider([first, second], 60_000);

      await expect(provider.decide(context)).resolves.toEqual(DECISION);
      expect(first.decide).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(60_001);

      await expect(provider.decide(context)).resolves.toEqual(DECISION);
      expect(first.decide).toHaveBeenCalledTimes(2);
      expect(second.decide).toHaveBeenCalledOnce();
    });

    it('still attempts every provider (ignoring cooldown) rather than failing outright when all of them are cooling down', async () => {
      const first: AutonomousAiProvider = { providerName: 'fake', decide: vi.fn().mockRejectedValue(new Error('still down')) };
      const provider = new AutonomousFallbackProvider([first], 60_000);

      await expect(provider.decide(context)).rejects.toThrow('still down');
      expect(first.decide).toHaveBeenCalledOnce();

      // Only provider is in cooldown, but it's also the only option — must
      // still be attempted, not skipped into an empty candidate list.
      await expect(provider.decide(context)).rejects.toThrow('still down');
      expect(first.decide).toHaveBeenCalledTimes(2);
    });
  });
});
