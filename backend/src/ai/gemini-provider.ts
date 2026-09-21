import { Inject, Injectable } from '@nestjs/common';
import { redactToken } from '../common/redact';
import { buildUserMessage, extractJsonObject, SYSTEM_PROMPT } from './ai-prompt';
import { AiAnalysisResult, AiProvider, AlertContext } from './ai-provider.interface';
import { AI_CONFIG, AiConfig } from './ai.config';
import { validateAiAnalysisResult } from './validate-ai-result';

const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiGenerateContentResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
}

/**
 * Reliability pass — Google's Gemini API, added as a third AiProvider
 * (alongside Anthropic/OpenRouter) because OpenRouter's free tier has been
 * unreliable in this deployment (this session's own audit: 1 success out
 * of 4 real attempts, split between "credit balance too low" and "response
 * was not valid JSON"). Uses the raw REST API via fetch, same posture as
 * every other provider in this family (anthropic-provider.ts,
 * openrouter-provider.ts) — no SDK dependency, easy to mock in tests
 * (`vi.spyOn(globalThis, 'fetch')`), and the exact request/response shape
 * below was verified live against the real API during implementation, not
 * guessed from documentation.
 *
 * Gemini's REST API takes the API key as a URL query parameter (`?key=`),
 * not a header — unlike every other provider here. This means `url` itself
 * embeds the secret and must NEVER appear in a thrown error message; only
 * `response.status`/body text do, and those are still redacted
 * defensively in case a body ever echoed the key back.
 */
@Injectable()
export class GeminiProvider implements AiProvider {
  constructor(@Inject(AI_CONFIG) private readonly config: AiConfig) {}

  async analyze(context: AlertContext): Promise<AiAnalysisResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    const url = `${GEMINI_API_BASE_URL}/${this.config.model}:generateContent?key=${this.config.apiKey}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: buildUserMessage(context) }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Gemini request failed: ${redactToken(message, this.config.apiKey)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Gemini returned ${response.status}: ${redactToken(body, this.config.apiKey).slice(0, 300)}`);
    }

    const payload = (await response.json()) as GeminiGenerateContentResponse;

    // A blocked prompt (safety filters on Google's side) returns 200 with
    // no candidates at all, rather than a non-2xx status — checked
    // explicitly so this doesn't fall through to the generic "no content"
    // error below and lose the real reason.
    if (payload.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked the request: ${payload.promptFeedback.blockReason}`);
    }

    const candidate = payload.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error(`Gemini response had no content (finishReason: ${candidate?.finishReason ?? 'unknown'})`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonObject(text));
    } catch {
      throw new Error('Gemini response was not valid JSON');
    }

    return validateAiAnalysisResult(parsed);
  }
}
