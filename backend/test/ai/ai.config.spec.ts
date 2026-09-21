import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { loadAiConfig } from '../../src/ai/ai.config';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('loadAiConfig — Req. 9-style startup validation, but OFF by default', () => {
  it('AI_ENABLED unset → disabled, no other vars required, no error', () => {
    const result = loadAiConfig(configWith({}));
    expect(result.enabled).toBe(false);
  });

  it('AI_ENABLED=false explicitly → disabled, no other vars required', () => {
    const result = loadAiConfig(configWith({ AI_ENABLED: 'false' }));
    expect(result.enabled).toBe(false);
  });

  it('AI_ENABLED=true with everything else missing → throws listing every missing var', () => {
    expect(() => loadAiConfig(configWith({ AI_ENABLED: 'true' }))).toThrow(
      /AI_PROVIDER.*AI_MODEL.*ANTHROPIC_API_KEY/s,
    );
  });

  it('AI_ENABLED=true with only the API key missing → throws naming just that', () => {
    const values = { AI_ENABLED: 'true', AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-sonnet-5' };
    expect(() => loadAiConfig(configWith(values))).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('AI_ENABLED=true with everything present → enabled, values passed through', () => {
    const result = loadAiConfig(
      configWith({
        AI_ENABLED: 'true',
        AI_PROVIDER: 'anthropic',
        AI_MODEL: 'claude-sonnet-5',
        ANTHROPIC_API_KEY: 'sk-test',
      }),
    );
    expect(result).toEqual({
      enabled: true,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKey: 'sk-test',
      requestTimeoutMs: 60000,
      fallbacks: [],
    });
  });

  it('AI_PROVIDER=openrouter reads OPENROUTER_API_KEY, not ANTHROPIC_API_KEY', () => {
    const result = loadAiConfig(
      configWith({
        AI_ENABLED: 'true',
        AI_PROVIDER: 'openrouter',
        AI_MODEL: 'nvidia/nemotron-3-super-120b-a12b:free',
        OPENROUTER_API_KEY: 'sk-or-test',
        ANTHROPIC_API_KEY: 'should-be-ignored',
      }),
    );
    expect(result).toEqual({
      enabled: true,
      provider: 'openrouter',
      model: 'nvidia/nemotron-3-super-120b-a12b:free',
      apiKey: 'sk-or-test',
      requestTimeoutMs: 60000,
      fallbacks: [],
    });
  });

  it('AI_PROVIDER=openrouter with OPENROUTER_API_KEY missing → throws naming that var specifically, even if ANTHROPIC_API_KEY is set', () => {
    const values = {
      AI_ENABLED: 'true',
      AI_PROVIDER: 'openrouter',
      AI_MODEL: 'nvidia/nemotron-3-super-120b-a12b:free',
      ANTHROPIC_API_KEY: 'present-but-irrelevant-here',
    };
    expect(() => loadAiConfig(configWith(values))).toThrow(/OPENROUTER_API_KEY/);
  });

  it('an unknown AI_PROVIDER value throws immediately, naming the supported providers', () => {
    const values = { AI_ENABLED: 'true', AI_PROVIDER: 'not-a-real-provider', AI_MODEL: 'm' };
    expect(() => loadAiConfig(configWith(values))).toThrow(/anthropic, openrouter, gemini, mock/);
  });

  it('AI_PROVIDER=gemini reads GOOGLE_AI_API_KEY, not ANTHROPIC_API_KEY or OPENROUTER_API_KEY', () => {
    const result = loadAiConfig(
      configWith({
        AI_ENABLED: 'true',
        AI_PROVIDER: 'gemini',
        AI_MODEL: 'gemini-3.6-flash',
        GOOGLE_AI_API_KEY: 'gemini-key',
        ANTHROPIC_API_KEY: 'should-be-ignored',
      }),
    );
    expect(result.provider).toBe('gemini');
    expect(result.apiKey).toBe('gemini-key');
    expect(result.fallbacks).toEqual([]);
  });

  it('AI_PROVIDER=gemini with GOOGLE_AI_API_KEY missing → throws naming that var specifically', () => {
    const values = { AI_ENABLED: 'true', AI_PROVIDER: 'gemini', AI_MODEL: 'gemini-3.6-flash' };
    expect(() => loadAiConfig(configWith(values))).toThrow(/GOOGLE_AI_API_KEY/);
  });

  it('AI_PROVIDER=gemini with OPENROUTER_API_KEY also set → populates fallbacks with OpenRouter', () => {
    const result = loadAiConfig(
      configWith({
        AI_ENABLED: 'true',
        AI_PROVIDER: 'gemini',
        AI_MODEL: 'gemini-3.6-flash',
        GOOGLE_AI_API_KEY: 'gemini-key',
        OPENROUTER_API_KEY: 'or-key',
      }),
    );
    expect(result.fallbacks).toEqual([
      { provider: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free', apiKey: 'or-key' },
    ]);
  });

  it('AI_PROVIDER=gemini fallback uses AI_FALLBACK_MODEL when set, instead of the default', () => {
    const result = loadAiConfig(
      configWith({
        AI_ENABLED: 'true',
        AI_PROVIDER: 'gemini',
        AI_MODEL: 'gemini-3.6-flash',
        GOOGLE_AI_API_KEY: 'gemini-key',
        OPENROUTER_API_KEY: 'or-key',
        AI_FALLBACK_MODEL: 'some/other-model:free',
      }),
    );
    expect(result.fallbacks[0].model).toBe('some/other-model:free');
  });

  it('AI_PROVIDER=gemini with no OPENROUTER_API_KEY or GROQ_API_KEY → empty fallbacks, not an error', () => {
    const result = loadAiConfig(
      configWith({
        AI_ENABLED: 'true',
        AI_PROVIDER: 'gemini',
        AI_MODEL: 'gemini-3.6-flash',
        GOOGLE_AI_API_KEY: 'gemini-key',
      }),
    );
    expect(result.fallbacks).toEqual([]);
  });

  it('AI_PROVIDER=gemini with GROQ_API_KEY also set → populates fallbacks with Groq', () => {
    const result = loadAiConfig(
      configWith({
        AI_ENABLED: 'true',
        AI_PROVIDER: 'gemini',
        AI_MODEL: 'gemini-3.6-flash',
        GOOGLE_AI_API_KEY: 'gemini-key',
        GROQ_API_KEY: 'groq-key',
      }),
    );
    expect(result.fallbacks).toEqual([{ provider: 'groq', model: 'openai/gpt-oss-120b', apiKey: 'groq-key' }]);
  });

  it('AI_PROVIDER=gemini with both OPENROUTER_API_KEY and GROQ_API_KEY set → fallbacks in try-order, OpenRouter then Groq', () => {
    const result = loadAiConfig(
      configWith({
        AI_ENABLED: 'true',
        AI_PROVIDER: 'gemini',
        AI_MODEL: 'gemini-3.6-flash',
        GOOGLE_AI_API_KEY: 'gemini-key',
        OPENROUTER_API_KEY: 'or-key',
        GROQ_API_KEY: 'groq-key',
      }),
    );
    expect(result.fallbacks.map((f) => f.provider)).toEqual(['openrouter', 'groq']);
  });

  it('AI_PROVIDER=gemini Groq fallback uses GROQ_MODEL when set, instead of the default', () => {
    const result = loadAiConfig(
      configWith({
        AI_ENABLED: 'true',
        AI_PROVIDER: 'gemini',
        AI_MODEL: 'gemini-3.6-flash',
        GOOGLE_AI_API_KEY: 'gemini-key',
        GROQ_API_KEY: 'groq-key',
        GROQ_MODEL: 'some/other-groq-model',
      }),
    );
    expect(result.fallbacks[0].model).toBe('some/other-groq-model');
  });

  it('AI_PROVIDER=openrouter (not gemini) never populates fallbacks, even with GOOGLE_AI_API_KEY/GROQ_API_KEY set', () => {
    const result = loadAiConfig(
      configWith({
        AI_ENABLED: 'true',
        AI_PROVIDER: 'openrouter',
        AI_MODEL: 'nvidia/nemotron-3-super-120b-a12b:free',
        OPENROUTER_API_KEY: 'or-key',
        GOOGLE_AI_API_KEY: 'unused-here',
        GROQ_API_KEY: 'also-unused-here',
      }),
    );
    expect(result.fallbacks).toEqual([]);
  });

  it('AI_PROVIDER=mock requires no API key at all, only AI_MODEL', () => {
    const result = loadAiConfig(configWith({ AI_ENABLED: 'true', AI_PROVIDER: 'mock', AI_MODEL: 'mock' }));
    expect(result).toEqual({
      enabled: true,
      provider: 'mock',
      model: 'mock',
      apiKey: '',
      requestTimeoutMs: 60000,
      fallbacks: [],
    });
  });

  it('AI_PROVIDER=mock with AI_MODEL missing still throws — the credential requirement is what mock skips, not every requirement', () => {
    expect(() => loadAiConfig(configWith({ AI_ENABLED: 'true', AI_PROVIDER: 'mock' }))).toThrow(/AI_MODEL/);
  });

  it('falls back to the default request timeout when unset or invalid', () => {
    const base = { AI_ENABLED: 'true', AI_PROVIDER: 'anthropic', AI_MODEL: 'm', ANTHROPIC_API_KEY: 'k' };
    expect(loadAiConfig(configWith(base)).requestTimeoutMs).toBe(60000);
    expect(loadAiConfig(configWith({ ...base, AI_REQUEST_TIMEOUT_MS: 'nope' })).requestTimeoutMs).toBe(60000);
    expect(loadAiConfig(configWith({ ...base, AI_REQUEST_TIMEOUT_MS: '5000' })).requestTimeoutMs).toBe(5000);
  });
});
