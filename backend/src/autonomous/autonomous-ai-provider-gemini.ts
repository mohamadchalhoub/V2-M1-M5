import { Inject, Injectable } from '@nestjs/common';
import { AI_CONFIG, AiConfig } from '../ai/ai.config';
import { extractJsonObject } from '../ai/ai-prompt';
import { redactToken } from '../common/redact';
import { AUTONOMOUS_SYSTEM_PROMPT, buildAutonomousUserMessage } from './autonomous-ai-prompt';
import { AutonomousAiContext, AutonomousAiProvider, RawAutonomousAiDecision } from './autonomous-ai-decision.types';

const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiGenerateContentResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
}

/**
 * Same low-level shape as `ai/gemini-provider.ts` (raw REST `fetch`, no SDK,
 * easy to mock in tests) but a SEPARATE class implementing
 * `AutonomousAiProvider`, not `AiProvider` — the two features' input/output
 * schemas are unrelated (alert narration vs. a trade decision), and forcing
 * one interface to serve both would either weaken the alert-narration
 * schema or bend this one to fit fields it doesn't need. Reuses the
 * genuinely generic pieces (`extractJsonObject`, `redactToken`) rather than
 * duplicating those.
 *
 * `temperature: 0` — the plan's explicit reproducibility requirement
 * (AUTONOMOUS_DEMO_TRADING_PLAN.md §3), unlike the alert-narration
 * provider, which doesn't set it.
 */
@Injectable()
export class AutonomousGeminiProvider implements AutonomousAiProvider {
  readonly providerName = 'gemini';

  constructor(@Inject(AI_CONFIG) private readonly config: AiConfig) {}

  async decide(context: AutonomousAiContext): Promise<RawAutonomousAiDecision> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    const url = `${GEMINI_API_BASE_URL}/${this.config.model}:generateContent?key=${this.config.apiKey}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: AUTONOMOUS_SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: buildAutonomousUserMessage(context) }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0 },
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

    if (payload.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked the request: ${payload.promptFeedback.blockReason}`);
    }

    const candidate = payload.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error(`Gemini response had no content (finishReason: ${candidate?.finishReason ?? 'unknown'})`);
    }

    try {
      return JSON.parse(extractJsonObject(text)) as RawAutonomousAiDecision;
    } catch {
      throw new Error('Gemini response was not valid JSON');
    }
  }
}
