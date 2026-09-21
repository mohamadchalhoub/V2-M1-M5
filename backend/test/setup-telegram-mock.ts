// Phase 5/6 — no automated test may depend on a real Telegram bot or a real
// AI provider (the account-wide instruction; PHASE5_DELIVERY_SPEC.md §13,
// AI_INTEGRATION_SPEC.md §10). Every test file gets a `fetch` mock that
// resolves as a successful call by default — for either external API — so
// any Alert created incidentally by a test that knows nothing about
// Telegram/AI has its background jobs succeed quickly and quietly rather
// than retrying against the real internet. Tests that specifically exercise
// Telegram's or the AI provider's error paths override this per-test with
// their own `vi.spyOn(globalThis, 'fetch').mockImplementation(...)`.
import { vi } from 'vitest';

function defaultResponseFor(url: string): Response {
  if (url.includes('api.anthropic.com')) {
    const text = JSON.stringify({
      situation_summary: 'Default test double — no real AI call was made.',
      historical_comparison: 'Default test double.',
      similar_past_events: [],
      statistical_context: 'Default test double.',
      market_risk: 'LOW',
      exposure_risk: 'LOW',
      event_risk: 'LOW',
      news_sentiment: 'NEUTRAL',
      confidence: 0.5,
      assessment: 'Default test double.',
      recommended_action: 'MONITOR',
    });
    return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // Telegram (or anything else) — the same default Phase 5 already used.
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  return defaultResponseFor(url);
});
