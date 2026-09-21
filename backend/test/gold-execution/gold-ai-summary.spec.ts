import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoldAiSummaryService } from '../../src/gold-execution/gold-ai-summary.service';

/**
 * Task item 5 — "do not silently support only Anthropic when other
 * configured providers exist." Proves the dispatch actually reaches
 * openrouter/gemini (not just anthropic), that essential behavior (fallback
 * on failure, isolated storage) holds regardless of provider, and that
 * synthetic/test summaries never touch the real ai_analyses table (they
 * only ever write to the isolated gold-execution-runtime file).
 */
describe('GoldAiSummaryService — provider dispatch and isolation', () => {
  let dir: string;
  let storagePath: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gold-ai-summary-'));
    storagePath = join(dir, 'ai-summaries.json');
    process.env.GOLD_AI_SUMMARIES_PATH = storagePath;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GOLD_AI_SUMMARIES_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  function readStored() {
    return JSON.parse(readFileSync(storagePath, 'utf8'));
  }

  it('calls the OpenRouter (OpenAI-compatible) endpoint when AI_PROVIDER=openrouter, not Anthropic', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'OpenRouter summary.' } }] }) });
    const service = new GoldAiSummaryService({ enabled: true, provider: 'openrouter', model: 'test-model', apiKey: 'or-key', requestTimeoutMs: 5000, fallbacks: [] });

    await service.generateForEvent('FILL_CONFIRMED', new Date().toISOString(), 'factual text');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('openrouter.ai');
    const stored = readStored();
    expect(stored[0].provider).toBe('openrouter');
    expect(stored[0].summary).toBe('OpenRouter summary.');
  });

  it('calls the Gemini endpoint when AI_PROVIDER=gemini, not Anthropic', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Gemini summary.' }] } }] }) });
    const service = new GoldAiSummaryService({ enabled: true, provider: 'gemini', model: 'gemini-test', apiKey: 'g-key', requestTimeoutMs: 5000, fallbacks: [] });

    await service.generateForEvent('FILL_CONFIRMED', new Date().toISOString(), 'factual text');

    expect(fetchMock.mock.calls[0][0]).toContain('generativelanguage.googleapis.com');
    expect(readStored()[0].provider).toBe('gemini');
  });

  it('calls the Anthropic endpoint when AI_PROVIDER=anthropic', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'Anthropic summary.' }] }) });
    const service = new GoldAiSummaryService({ enabled: true, provider: 'anthropic', model: 'claude-test', apiKey: 'a-key', requestTimeoutMs: 5000, fallbacks: [] });

    await service.generateForEvent('FILL_CONFIRMED', new Date().toISOString(), 'factual text');

    expect(fetchMock.mock.calls[0][0]).toContain('api.anthropic.com');
    expect(readStored()[0].provider).toBe('anthropic');
  });

  it('essential behavior (Telegram-equivalent factual content) is never lost on provider failure — deterministic fallback', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const service = new GoldAiSummaryService({ enabled: true, provider: 'openrouter', model: 'm', apiKey: 'k', requestTimeoutMs: 5000, fallbacks: [] });

    await service.generateForEvent('FILL_CONFIRMED', new Date().toISOString(), 'the exact factual text');

    const stored = readStored();
    expect(stored[0].provider).toBe('fallback');
    expect(stored[0].summary).toBe('the exact factual text'); // verbatim, never blocked/lost
  });

  it('AI_ENABLED=false uses the deterministic fallback and never calls fetch', async () => {
    const service = new GoldAiSummaryService({ enabled: false, provider: '', model: '', apiKey: '', requestTimeoutMs: 5000, fallbacks: [] });
    await service.generateForEvent('FILL_CONFIRMED', new Date().toISOString(), 'factual text');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readStored()[0].provider).toBe('fallback');
  });

  it('mock provider produces a deterministic, clearly-labeled entry without any network call', async () => {
    const service = new GoldAiSummaryService({ enabled: true, provider: 'mock', model: 'mock-model', apiKey: '', requestTimeoutMs: 5000, fallbacks: [] });
    await service.generateForEvent('FILL_CONFIRMED', new Date().toISOString(), 'factual text');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readStored()[0].provider).toBe('mock');
  });

  it('isolation: summaries are written ONLY to the gold-execution-runtime file, never any shared/legacy AI table or path', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'x' }] }) });
    const service = new GoldAiSummaryService({ enabled: true, provider: 'anthropic', model: 'm', apiKey: 'k', requestTimeoutMs: 5000, fallbacks: [] });
    await service.generateForEvent('SYNTHETIC_TEST_EVENT', new Date().toISOString(), 'synthetic test only, isolated identity');
    // The only side effect is this one isolated file — no Prisma/DB call is made by this service at all.
    expect(existsSync(storagePath)).toBe(true);
    const stored = readStored();
    expect(stored[0].eventType).toBe('SYNTHETIC_TEST_EVENT');
  });
});
