import { Inject, Injectable } from '@nestjs/common';
import { redactToken } from '../common/redact';
import { buildUserMessage, extractJsonObject, SYSTEM_PROMPT } from './ai-prompt';
import { AiAnalysisResult, AiProvider, AlertContext } from './ai-provider.interface';
import { AI_CONFIG, AiConfig } from './ai.config';
import { validateAiAnalysisResult } from './validate-ai-result';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Reliability pass — a second fallback for the Gemini→OpenRouter chain
// (ai.config.ts's `fallbacks`), added because OpenRouter's free-tier
// routing has itself proven unreliable in this deployment (live-observed:
// "Upstream error from Nvidia: Service temporarily overloaded"). Groq is a
// direct inference provider, not a routing gateway, so it doesn't share
// that specific "200 with an embedded upstream error" failure mode —
// OpenAI-compatible chat completions, raw REST via fetch, same posture as
// every other provider here (anthropic-provider.ts, openrouter-provider.ts,
// gemini-provider.ts) — no SDK dependency (deliberate, codebase-wide;
// `groq-sdk` was considered and rejected for the same reason `finnhub`'s
// own npm package was: it doesn't fit this app's zero-dependency provider
// convention, and raw fetch is easier to mock in tests besides).
@Injectable()
export class GroqProvider implements AiProvider {
  constructor(@Inject(AI_CONFIG) private readonly config: AiConfig) {}

  async analyze(context: AlertContext): Promise<AiAnalysisResult> {
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
          max_tokens: 1024,
          // Groq's own JSON mode — SYSTEM_PROMPT already instructs "ONLY a
          // single JSON object" (ai-prompt.ts), which also satisfies
          // Groq's requirement that the prompt itself mention JSON.
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserMessage(context) },
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonObject(text));
    } catch {
      throw new Error('Groq response was not valid JSON');
    }

    return validateAiAnalysisResult(parsed);
  }
}
