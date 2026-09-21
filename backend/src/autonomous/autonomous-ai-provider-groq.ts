import { Inject, Injectable } from '@nestjs/common';
import { AI_CONFIG, AiConfig } from '../ai/ai.config';
import { extractJsonObject } from '../ai/ai-prompt';
import { redactToken } from '../common/redact';
import { AUTONOMOUS_SYSTEM_PROMPT, buildAutonomousUserMessage } from './autonomous-ai-prompt';
import { AutonomousAiContext, AutonomousAiProvider, RawAutonomousAiDecision } from './autonomous-ai-decision.types';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Same OpenAI-compatible shape as `ai/groq-provider.ts`, but implementing
 * `AutonomousAiProvider` (trade-decision schema) instead of `AiProvider`
 * (alert-narration schema) — reuses the autonomous prompt/context builders,
 * not the alert-narration ones. Used as a fallback behind
 * `AutonomousGeminiProvider` when Gemini's quota/rate limit is hit (see
 * `autonomous.module.ts`), same reliability posture as the existing
 * alert-narration fallback chain.
 */
@Injectable()
export class AutonomousGroqProvider implements AutonomousAiProvider {
  readonly providerName = 'groq';

  constructor(@Inject(AI_CONFIG) private readonly config: AiConfig) {}

  async decide(context: AutonomousAiContext): Promise<RawAutonomousAiDecision> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          // Found live this session: 1024 (fine for the shorter
          // alert-narration schema `ai/groq-provider.ts` uses) was too low
          // here — the default Groq fallback model (a reasoning model)
          // spends tokens on hidden reasoning BEFORE its visible JSON
          // answer, and those count against the same budget. It was hitting
          // the cap mid-reasoning, returning an empty or truncated
          // `failed_generation` every single time (100% failure). This
          // schema's own `reasoning` field is also asked to be substantive
          // (must cite the friend's rules and the specific levels), unlike
          // alert narration's shorter fields.
          max_tokens: 4096,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: AUTONOMOUS_SYSTEM_PROMPT },
            { role: 'user', content: buildAutonomousUserMessage(context) },
          ],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Groq request failed: ${redactToken(message, this.config.apiKey)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Groq returned ${response.status}: ${redactToken(body, this.config.apiKey).slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      error?: { message?: string; code?: string };
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
    };

    if (payload.error) {
      throw new Error(`Groq returned 200 with an embedded error: ${redactToken(payload.error.message ?? JSON.stringify(payload.error), this.config.apiKey).slice(0, 300)}`);
    }

    const text = payload.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error(`Groq response had no message content (finish_reason: ${payload.choices?.[0]?.finish_reason ?? 'unknown'})`);
    }

    try {
      return JSON.parse(extractJsonObject(text)) as RawAutonomousAiDecision;
    } catch {
      throw new Error('Groq response was not valid JSON');
    }
  }
}
