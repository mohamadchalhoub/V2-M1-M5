import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { loadFinnhubConfig } from '../../src/market-events/finnhub.config';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('loadFinnhubConfig — off by default, same posture as MarketauxConfig/MarketEventsConfig', () => {
  it('FINNHUB_ENABLED unset → disabled, no other vars required', () => {
    expect(loadFinnhubConfig(configWith({})).enabled).toBe(false);
  });

  it('FINNHUB_ENABLED=true with FINNHUB_API_KEY missing → throws naming it', () => {
    expect(() => loadFinnhubConfig(configWith({ FINNHUB_ENABLED: 'true' }))).toThrow(/FINNHUB_API_KEY/);
  });

  it('FINNHUB_ENABLED=true with key present → enabled, defaults applied', () => {
    const result = loadFinnhubConfig(configWith({ FINNHUB_ENABLED: 'true', FINNHUB_API_KEY: 'key' }));
    expect(result).toEqual({
      enabled: true,
      apiKey: 'key',
      pollIntervalSeconds: 1800,
      limit: 5,
      currencies: ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'],
    });
  });

  it('parses a custom FINNHUB_CURRENCIES list, trimming and upper-casing', () => {
    const result = loadFinnhubConfig(
      configWith({ FINNHUB_ENABLED: 'true', FINNHUB_API_KEY: 'key', FINNHUB_CURRENCIES: ' eur, usd ,gbp' }),
    );
    expect(result.currencies).toEqual(['EUR', 'USD', 'GBP']);
  });

  it('falls back to defaults when poll interval/limit are unset or invalid', () => {
    const base = { FINNHUB_ENABLED: 'true', FINNHUB_API_KEY: 'key' };
    expect(loadFinnhubConfig(configWith({ ...base, FINNHUB_POLL_INTERVAL_SECONDS: 'nope' })).pollIntervalSeconds).toBe(1800);
    expect(loadFinnhubConfig(configWith({ ...base, FINNHUB_POLL_INTERVAL_SECONDS: '900' })).pollIntervalSeconds).toBe(900);
    expect(loadFinnhubConfig(configWith({ ...base, FINNHUB_NEWS_LIMIT: '10' })).limit).toBe(10);
  });
});
