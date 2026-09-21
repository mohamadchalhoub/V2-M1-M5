import { Inject, Injectable, Logger } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AI_CONFIG, AiConfig } from '../ai/ai.config';

export interface GoldAiSummaryRecord {
  id: string;
  eventType: string;
  /** Timestamp of the underlying event this summarizes (fill time, closure executedAt, etc) — NOT generatedAt. */
  sourceDataTimestampIso: string;
  generatedAtIso: string;
  /** 'anthropic' | 'mock' | 'fallback' (deterministic, no provider call at all — disabled/unset/error). */
  provider: string;
  model: string | null;
  summary: string;
}

const MAX_STORED_SUMMARIES = 200;

/**
 * Task item H — an isolated gold consumer of the existing multi-provider AI
 * abstraction (`backend/src/ai/`, otherwise only used by the legacy
 * EURUSD/rule-alert narration pipeline). Deliberately does NOT reuse
 * `AiProvider.analyze(context: AlertContext)` — that interface's shape
 * (situation_summary/market_risk/recommended_action/similar_past_events...)
 * is baked around the Alert/rule-engine concept this task says gold must
 * stay isolated from. Instead this reads the SAME `AI_CONFIG` (provider/
 * model/enabled/apiKey — read-only, never mutated) so the operator's one
 * AI_PROVIDER/AI_MODEL/API key setup is not duplicated, and makes its own
 * minimal, gold-specific call to whichever provider AI_PROVIDER actually
 * names — anthropic, openrouter, or gemini (task item 5: never silently
 * anthropic-only when another provider is configured).
 *
 * Event-gated only (never a polling-cycle call) — callers pass one of a
 * small set of real gold events (fill, closure, missing-protection). Always
 * fire-and-forget from the caller's side (`void summary.generateForEvent(...)`)
 * so a slow/failing AI call can never delay the Telegram alert it accompanies.
 *
 * Deterministic factual fallback whenever AI is disabled, the provider is
 * 'mock'/unset, or the real call fails — never blocks on, or masks the
 * absence of, a working AI provider.
 *
 * Storage: a small JSON file (same file-based posture as
 * `gold-runtime-settings.service.ts`) capped at the most recent
 * `MAX_STORED_SUMMARIES` entries — this is narration, not the trading
 * record of truth (that stays in Postgres via `GoldTelegramNotification`
 * and the Trade/Position tables), so a lightweight store is appropriate.
 */
@Injectable()
export class GoldAiSummaryService {
  private readonly logger = new Logger(GoldAiSummaryService.name);

  constructor(@Inject(AI_CONFIG) private readonly aiConfig: AiConfig) {}

  private getPath(): string {
    return process.env.GOLD_AI_SUMMARIES_PATH?.trim() || join(process.cwd(), 'gold-execution-runtime', 'ai-summaries.json');
  }

  private readAll(): GoldAiSummaryRecord[] {
    const path = this.getPath();
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private append(record: GoldAiSummaryRecord): void {
    const path = this.getPath();
    const existing = this.readAll();
    const next = [...existing, record].slice(-MAX_STORED_SUMMARIES);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2));
  }

  getRecent(limit = 20): GoldAiSummaryRecord[] {
    return this.readAll().slice(-limit).reverse();
  }

  /**
   * `factualContext` is a plain, already-computed factual string (the same
   * kind of content `gold-telegram.service.ts` sends) — this method never
   * invents facts, it only asks the provider to phrase them, or falls back
   * to using them verbatim.
   */
  async generateForEvent(eventType: string, sourceDataTimestampIso: string, factualContext: string): Promise<void> {
    const generatedAtIso = new Date().toISOString();
    const id = `${eventType}-${Date.now()}`;

    if (!this.aiConfig.enabled || this.aiConfig.provider === 'mock' || this.aiConfig.provider === '') {
      this.append({
        id, eventType, sourceDataTimestampIso, generatedAtIso,
        provider: this.aiConfig.enabled ? 'mock' : 'fallback',
        model: this.aiConfig.enabled ? this.aiConfig.model : null,
        summary: factualContext,
      });
      return;
    }

    // Task item 5 — "do not silently support only Anthropic when other
    // configured providers exist." Dispatches to whichever real provider
    // AI_PROVIDER actually names, using the SAME AI_CONFIG the operator
    // already set up (never a second, gold-specific provider config).
    // Deliberately does NOT reuse the concrete provider classes in
    // backend/src/ai/ (AnthropicProvider/OpenRouterProvider/GeminiProvider) —
    // those implement `AiProvider.analyze(context: AlertContext)`, built
    // around the Alert/rule-engine shape this gold consumer must stay
    // isolated from; this makes its own minimal call per provider instead,
    // with a plain factual prompt, never the Alert-shaped SYSTEM_PROMPT.
    try {
      const summary = await this.callProvider(this.aiConfig.provider, factualContext);
      this.append({ id, eventType, sourceDataTimestampIso, generatedAtIso, provider: this.aiConfig.provider, model: this.aiConfig.model, summary });
    } catch (err) {
      this.logger.error(`gold AI summary generation failed for ${eventType} (provider=${this.aiConfig.provider}), using deterministic fallback: ${err instanceof Error ? err.message : err}`);
      this.append({ id, eventType, sourceDataTimestampIso, generatedAtIso, provider: 'fallback', model: null, summary: factualContext });
    }
  }

  private async callProvider(provider: string, factualContext: string): Promise<string> {
    switch (provider) {
      case 'anthropic':
        return this.callAnthropic(factualContext);
      case 'openrouter':
        return this.callOpenAiCompatible('https://openrouter.ai/api/v1/chat/completions', factualContext, { 'X-Title': 'Trading Behavior Monitor (gold)' });
      case 'gemini':
        return this.callGemini(factualContext);
      default:
        // Unknown/unsupported provider name — fail closed to the deterministic path (caller's catch handles this via the thrown error).
        throw new Error(`unsupported AI_PROVIDER "${provider}" for the gold summary consumer`);
    }
  }

  private buildPrompt(factualContext: string): string {
    return (
      `Rewrite the following factual gold (XAUUSD) DEMO trading event as one short, plain, factual sentence. ` +
      `Do not add opinions, predictions, or advice — restate only the given facts:\n\n${factualContext}`
    );
  }

  private async callOpenAiCompatible(url: string, factualContext: string, extraHeaders: Record<string, string> = {}): Promise<string> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.aiConfig.apiKey}`, ...extraHeaders },
      body: JSON.stringify({
        model: this.aiConfig.model,
        max_tokens: 200,
        messages: [{ role: 'user', content: this.buildPrompt(factualContext) }],
      }),
      signal: AbortSignal.timeout(this.aiConfig.requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error(`${url} returned no message content`);
    return text;
  }

  private async callGemini(factualContext: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.aiConfig.model}:generateContent?key=${this.aiConfig.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: this.buildPrompt(factualContext) }] }] }),
      signal: AbortSignal.timeout(this.aiConfig.requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`Gemini API returned ${response.status}`);
    const body = (await response.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new Error('Gemini API returned no text content');
    return text;
  }

  private async callAnthropic(factualContext: string): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.aiConfig.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.aiConfig.model,
        max_tokens: 200,
        messages: [{ role: 'user', content: this.buildPrompt(factualContext) }],
      }),
      signal: AbortSignal.timeout(this.aiConfig.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Anthropic API ${response.status}`);
    }
    const body = (await response.json()) as { content?: { type: string; text?: string }[] };
    const text = body.content?.find((c) => c.type === 'text')?.text?.trim();
    if (!text) throw new Error('Anthropic API returned no text content');
    return text;
  }
}
