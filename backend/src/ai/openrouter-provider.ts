import { Inject, Injectable } from '@nestjs/common';
import { redactToken } from '../common/redact';
import { buildUserMessage, extractJsonObject, SYSTEM_PROMPT } from './ai-prompt';
import { AiAnalysisResult, AiProvider, AlertContext } from './ai-provider.interface';
import { AI_CONFIG, AiConfig } from './ai.config';
import { validateAiAnalysisResult } from './validate-ai-result';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// OpenRouter is an OpenAI-compatible gateway in front of many models
// (including free-tier ones) — added as a second AiProvider so this app
// isn't hard-dependent on Anthropic credits specifically (production
// readiness follow-up). Same prompt (ai-prompt.ts), same schema validation
// and safety filter downstream as AnthropicProvider — only the wire format
// (auth header, request/response shape) differs.
@Injectable()
export class OpenRouterProvider implements AiProvider {
  constructor(@Inject(AI_CONFIG) private readonly config: AiConfig) {}

  async analyze(context: AlertContext): Promise<AiAnalysisResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          // Non-secret, optional identification for OpenRouter's own
          // per-app usage breakdown — not required for the request to work.
          'X-Title': 'Trading Behavior Monitor',
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 1024,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserMessage(context) },
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

    // Production audit finding: OpenRouter's free-tier routing can return
    // HTTP 200 (request.ok) while the upstream model provider it routed to
    // actually failed (e.g. "Upstream error from Nvidia: Service temporarily
    // overloaded") — observed live against this app's own configured
    // free-tier model. OpenRouter surfaces that failure as an `error` object
    // either at the top level or on the failed choice, NOT as a non-2xx
    // status, so the `!response.ok` check above never sees it and execution
    // would otherwise fall through to "no message content", which loses the
    // real reason. Checked for explicitly, before the content-presence check.
    const embeddedError = payload.error ?? payload.choices?.[0]?.error;
    if (embeddedError) {
      const detail = embeddedError.message ?? JSON.stringify(embeddedError);
      throw new Error(`OpenRouter returned 200 with an embedded upstream error: ${redactToken(detail, this.config.apiKey).slice(0, 300)}`);
    }

    // Some OpenRouter models (reasoning models in particular) put their
    // chain-of-thought in a separate `reasoning` field and keep `content`
    // as the clean final answer — only `content` is ever read here.
    const text = payload.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error('OpenRouter response had no message content');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonObject(text));
    } catch {
      throw new Error('OpenRouter response was not valid JSON');
    }

    return validateAiAnalysisResult(parsed);
  }
}
