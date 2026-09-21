import { describe, expect, it } from 'vitest';
import { buildAutonomousAiProvider } from '../../src/autonomous/autonomous-ai-provider.factory';
import { AutonomousFallbackProvider } from '../../src/autonomous/autonomous-ai-fallback-provider';
import { AutonomousGeminiProvider } from '../../src/autonomous/autonomous-ai-provider-gemini';
import { AutonomousGroqProvider } from '../../src/autonomous/autonomous-ai-provider-groq';
import { AutonomousOpenRouterProvider } from '../../src/autonomous/autonomous-ai-provider-openrouter';
import type { AiConfig } from '../../src/ai/ai.config';

const baseConfig: AiConfig = {
  enabled: true,
  provider: 'gemini',
  model: 'gemini-3.6-flash',
  apiKey: 'gemini-key',
  requestTimeoutMs: 60000,
  fallbacks: [],
};

describe('buildAutonomousAiProvider', () => {
  it('returns a bare AutonomousGeminiProvider when no fallbacks are configured', () => {
    const provider = buildAutonomousAiProvider(baseConfig);
    expect(provider).toBeInstanceOf(AutonomousGeminiProvider);
  });

  it('wraps Gemini and both fallbacks in AutonomousFallbackProvider, trying Groq BEFORE OpenRouter', () => {
    const config: AiConfig = {
      ...baseConfig,
      fallbacks: [
        { provider: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free', apiKey: 'or-key' },
        { provider: 'groq', model: 'openai/gpt-oss-120b', apiKey: 'groq-key' },
      ],
    };
    const provider = buildAutonomousAiProvider(config);
    expect(provider).toBeInstanceOf(AutonomousFallbackProvider);

    // Live-observed this session: OpenRouter's free-tier routing took 60-70+
    // seconds per call against this schema's prompt, sometimes still
    // invalid after the wait, while Groq answered correctly in a few
    // seconds — so Groq must be tried first here, unlike ai.module.ts's own
    // alert-narration chain (OpenRouter before Groq).
    const providers = (provider as unknown as { providers: unknown[] }).providers;
    expect(providers[0]).toBeInstanceOf(AutonomousGeminiProvider);
    expect(providers[1]).toBeInstanceOf(AutonomousGroqProvider);
    expect(providers[2]).toBeInstanceOf(AutonomousOpenRouterProvider);
  });

  it('still works with only a single fallback configured (Groq only)', () => {
    const config: AiConfig = {
      ...baseConfig,
      fallbacks: [{ provider: 'groq', model: 'openai/gpt-oss-120b', apiKey: 'groq-key' }],
    };
    const provider = buildAutonomousAiProvider(config);
    const providers = (provider as unknown as { providers: unknown[] }).providers;
    expect(providers).toHaveLength(2);
    expect(providers[1]).toBeInstanceOf(AutonomousGroqProvider);
  });

  it('still works with only a single fallback configured (OpenRouter only)', () => {
    const config: AiConfig = {
      ...baseConfig,
      fallbacks: [{ provider: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free', apiKey: 'or-key' }],
    };
    const provider = buildAutonomousAiProvider(config);
    const providers = (provider as unknown as { providers: unknown[] }).providers;
    expect(providers).toHaveLength(2);
    expect(providers[1]).toBeInstanceOf(AutonomousOpenRouterProvider);
  });
});
