import { Inject, Injectable } from '@nestjs/common';
import { AI_CONFIG, AiConfig } from '../ai/ai.config';
import { extractJsonObject } from '../ai/ai-prompt';
import { redactToken } from '../common/redact';
import { AUTONOMOUS_SYSTEM_PROMPT, buildAutonomousUserMessage } from './autonomous-ai-prompt';
import { AutonomousAiContext, AutonomousAiProvider, RawAutonomousAiDecision } from './autonomous-ai-decision.types';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Same OpenAI-compatible gateway shape as `ai/openrouter-provider.ts`, but
 * implementing `AutonomousAiProvider` (trade-decision schema) instead of
 * `AiProvider` (alert-narration schema). Used as a fallback behind
 * `AutonomousGeminiProvider` when Gemini's quota/rate limit is hit (see
 * `autonomous.module.ts`).
 */
@Injectable()
export class AutonomousOpenRouterProvider implements AutonomousAiProvider {
  readonly providerName = 'openrouter';

  constructor(@Inject(AI_CONFIG) private readonly config: AiConfig) {}

  async decide(context: AutonomousAiContext): Promise<RawAutonomousAiDecision> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          'X-Title': 'Autonomous Demo Trading',
        },
        body: JSON.stringify({
          model: this.config.model,
          // See autonomous-ai-provider-groq.ts's own comment — same fix,
          // same root cause: 1024 (fine for alert-narration's shorter
          // schema) was too low for a reasoning-model fallback plus this
          // schema's own required substantive `reasoning` field, causing a
          // 100% truncated/invalid-JSON failure rate live this session.
          max_tokens: 4096,
          temperature: 0,
          messages: [
            { role: 'system', content: AUTONOMOUS_SYSTEM_PROMPT },
            { role: 'user', content: buildAutonomousUserMessage(context) },
          ],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`OpenRouter request failed: ${redactToken(message, this.config.apiKey)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `OpenRouter returned ${response.status}: ${redactToken(body, this.config.apiKey).slice(0, 300)}`,
      );
    }

    const payload = (await response.json()) as {
      error?: { message?: string; code?: number };
      choices?: { message?: { content?: string | null }; error?: { message?: string; code?: number }; finish_reason?: string }[];
    };

    const embeddedError = payload.error ?? payload.choices?.[0]?.error;
    if (embeddedError) {
      const detail = embeddedError.message ?? JSON.stringify(embeddedError);
      throw new Error(`OpenRouter returned 200 with an embedded upstream error: ${redactToken(detail, this.config.apiKey).slice(0, 300)}`);
    }

    const text = payload.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error('OpenRouter response had no message content');
    }

    try {
      return JSON.parse(extractJsonObject(text)) as RawAutonomousAiDecision;
    } catch {
      throw new Error('OpenRouter response was not valid JSON');
    }
  }
}
