import { ConfigService } from '@nestjs/config';

export interface AiConfig {
  enabled: boolean;
  provider: string;
  model: string;
  apiKey: string;
  requestTimeoutMs: number;
  /**
   * Reliability pass — populated only when `provider === 'gemini'`, one
   * entry per configured fallback credential, in the order they should be
   * tried: OpenRouter first (if OPENROUTER_API_KEY is set), then Groq (if
   * GROQ_API_KEY is set) — either, both, or neither may be present.
   * `AiModule`'s factory uses this to wrap GeminiProvider in a
   * FallbackAiProvider chaining whichever of these are configured. Always
   * an array (empty, not undefined) so callers never have to distinguish
   * "no fallback field" from "fallback field present but empty."
   */
  fallbacks: { provider: 'openrouter' | 'groq'; model: string; apiKey: string }[];
}

export const AI_CONFIG = Symbol('AI_CONFIG');

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_FALLBACK_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
// Live-verified this session (not the commonly-cited "llama-3.3-70b-
// versatile" — Groq has since removed that from its catalog; this account's
// real /v1/models listing was checked directly). gpt-oss-120b is OpenAI's
// own open-weight model, hosted by Groq — confirmed working with
// response_format: json_object and the exact prompt shape this app sends.
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';

// Each provider keeps its own named env var (ANTHROPIC_API_KEY,
// OPENROUTER_API_KEY, GOOGLE_AI_API_KEY) rather than one generic
// AI_API_KEY — consistent with how every other secret in this app is
// named for exactly what it is, and it means multiple keys can sit in the
// same .env at once (e.g. while switching providers, or for gemini's own
// OpenRouter fallback below) without one silently shadowing the other.
// 'mock' — MockAiProvider, no network call, no credential (mock-provider.ts)
// — for local dev/testing the real pipeline without a real API key.
const KNOWN_PROVIDERS = ['anthropic', 'openrouter', 'gemini', 'mock'] as const;

/** null means "no credential needed" (mock only) — every real provider still requires one. */
function apiKeyEnvVarFor(provider: string | undefined): string | null {
  if (provider === 'mock') return null;
  if (provider === 'openrouter') return 'OPENROUTER_API_KEY';
  if (provider === 'gemini') return 'GOOGLE_AI_API_KEY';
  return 'ANTHROPIC_API_KEY';
}

/**
 * AI defaults OFF (AI_INTEGRATION_SPEC.md §9 posture, carried forward from
 * every prior phase's "do not implement AI yet" caution): unlike Telegram
 * (Req. 9, Phase 5 — mandatory, fails startup if missing), AI narration is
 * an optional enrichment a trader opts into. `AI_ENABLED=false` (or unset)
 * short-circuits before any of the other AI_/ANTHROPIC_ vars are even
 * read — the app boots normally with zero AI configuration. Only once
 * `AI_ENABLED=true` do the provider/model/key become required at startup,
 * same fail-fast posture as Telegram.
 */
export function loadAiConfig(config: ConfigService): AiConfig {
  const enabled = (config.get<string>('AI_ENABLED') ?? 'false').trim().toLowerCase() === 'true';
  if (!enabled) {
    return { enabled: false, provider: '', model: '', apiKey: '', requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS, fallbacks: [] };
  }

  const provider = config.get<string>('AI_PROVIDER')?.trim();
  const model = config.get<string>('AI_MODEL')?.trim();

  if (provider && !(KNOWN_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`AI_PROVIDER must be one of ${KNOWN_PROVIDERS.join(', ')}, got "${provider}"`);
  }

  const apiKeyEnvVar = apiKeyEnvVarFor(provider);
  const apiKey = apiKeyEnvVar ? config.get<string>(apiKeyEnvVar)?.trim() : '';

  const requiredFields: [string, string | undefined][] = [
    ['AI_PROVIDER', provider],
    ['AI_MODEL', model],
  ];
  if (apiKeyEnvVar) {
    requiredFields.push([apiKeyEnvVar, apiKey]);
  }
  const missing = requiredFields.filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `AI_ENABLED=true but missing required configuration: ${missing.join(', ')}. ` +
        `See backend/.env.example, or set AI_ENABLED=false to run without AI narration.`,
    );
  }

  const fallbacks: AiConfig['fallbacks'] = [];
  if (provider === 'gemini') {
    const openRouterApiKey = config.get<string>('OPENROUTER_API_KEY')?.trim();
    if (openRouterApiKey) {
      const fallbackModel = config.get<string>('AI_FALLBACK_MODEL')?.trim() || DEFAULT_FALLBACK_MODEL;
      fallbacks.push({ provider: 'openrouter', model: fallbackModel, apiKey: openRouterApiKey });
    }
    const groqApiKey = config.get<string>('GROQ_API_KEY')?.trim();
    if (groqApiKey) {
      const groqModel = config.get<string>('GROQ_MODEL')?.trim() || DEFAULT_GROQ_MODEL;
      fallbacks.push({ provider: 'groq', model: groqModel, apiKey: groqApiKey });
    }
  }

  return {
    enabled: true,
    provider: provider as string,
    model: model as string,
    apiKey: apiKey as string,
    requestTimeoutMs: readPositiveInt(config, 'AI_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS),
    fallbacks,
  };
}

function readPositiveInt(config: ConfigService, key: string, fallback: number): number {
  const raw = config.get<string>(key);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
