import { AiConfig } from '../ai/ai.config';
import { AutonomousAiProvider } from './autonomous-ai-decision.types';
import { AutonomousFallbackProvider } from './autonomous-ai-fallback-provider';
import { AutonomousGeminiProvider } from './autonomous-ai-provider-gemini';
import { AutonomousGroqProvider } from './autonomous-ai-provider-groq';
import { AutonomousOpenRouterProvider } from './autonomous-ai-provider-openrouter';

/**
 * Single source of truth for building the autonomous AI provider chain —
 * used by `AutonomousModule` (NestJS DI) and by the standalone scripts
 * (`evaluate-autonomous-rule.ts`, `backtest-autonomous-rule.ts`), which
 * construct providers directly without going through Nest. Kept as one
 * function so the two call sites can never drift apart on how the fallback
 * chain is assembled.
 *
 * Mirrors `ai.module.ts`'s own Gemini-plus-fallbacks wiring: Gemini first,
 * then the configured fallbacks (`AiConfig.fallbacks`, already computed by
 * `loadAiConfig`) — added after this session found live that Gemini's
 * free-tier daily quota is exhausted at the Google Cloud PROJECT level, not
 * the API-key level, so a new key alone doesn't recover from it.
 *
 * UNLIKE `ai.module.ts` (which tries OpenRouter before Groq), this chain
 * tries Groq before OpenRouter — found live this session that OpenRouter's
 * free-tier routing took 60-70+ seconds per call against this schema's
 * larger prompt (sometimes still returning invalid JSON after that whole
 * wait), while Groq answered correctly in a few seconds every time it was
 * tried directly. For the alert-narration side that latency difference is a
 * non-issue (one call per triggered alert); here it's the difference
 * between a ~60-candidate backtest finishing in minutes versus well over an
 * hour, so Groq goes first for this feature specifically.
 */
export function buildAutonomousAiProvider(config: AiConfig): AutonomousAiProvider {
  const gemini = new AutonomousGeminiProvider(config);
  if (config.fallbacks.length === 0) return gemini;
  const orderedFallbacks = [...config.fallbacks].sort((a, b) => Number(b.provider === 'groq') - Number(a.provider === 'groq'));
  const fallbackProviders = orderedFallbacks.map((fb) => {
    const fallbackConfig = { ...config, apiKey: fb.apiKey, model: fb.model };
    return fb.provider === 'groq' ? new AutonomousGroqProvider(fallbackConfig) : new AutonomousOpenRouterProvider(fallbackConfig);
  });
  return new AutonomousFallbackProvider([gemini, ...fallbackProviders]);
}
