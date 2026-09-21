import { Inject, Injectable } from '@nestjs/common';
import { redactToken } from '../common/redact';
import { buildUserMessage, extractJsonObject, SYSTEM_PROMPT } from './ai-prompt';
import { AiAnalysisResult, AiProvider, AlertContext } from './ai-provider.interface';
import { AI_CONFIG, AiConfig } from './ai.config';
import { validateAiAnalysisResult } from './validate-ai-result';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// SYSTEM_PROMPT/buildUserMessage/extractJsonObject live in ai-prompt.ts,
// shared with openrouter-provider.ts — every provider must ask the model for
// the exact same thing. The prompt itself is defense-in-depth only, not the
// safety boundary: validate-ai-result.ts (schema) and safety-filter.ts
// (keyword scan) are, and both run on every response regardless of provider.

@Injectable()
export class AnthropicProvider implements AiProvider {
  constructor(@Inject(AI_CONFIG) private readonly config: AiConfig) {}

  async analyze(context: AlertContext): Promise<AiAnalysisResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildUserMessage(context) }],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Anthropic request failed: ${redactToken(message, this.config.apiKey)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Anthropic returned ${response.status}: ${redactToken(body, this.config.apiKey).slice(0, 300)}`,
      );
    }

    const payload = (await response.json()) as { content?: { type: string; text?: string }[] };
    const text = payload.content?.find((block) => block.type === 'text')?.text;
    if (!text) {
      throw new Error('Anthropic response had no text content block');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonObject(text));
    } catch {
      throw new Error('Anthropic response was not valid JSON');
    }

    return validateAiAnalysisResult(parsed);
  }
}
