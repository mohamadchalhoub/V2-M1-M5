import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { loadMarketauxConfig } from '../../src/market-events/marketaux.config';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('loadMarketauxConfig — off by default, same posture as MarketEventsConfig/AiConfig', () => {
  it('MARKETAUX_ENABLED unset → disabled, no other vars required', () => {
    expect(loadMarketauxConfig(configWith({})).enabled).toBe(false);
  });

  it('MARKETAUX_ENABLED=true with MARKETAUX_API_TOKEN missing → throws naming it', () => {
    expect(() => loadMarketauxConfig(configWith({ MARKETAUX_ENABLED: 'true' }))).toThrow(/MARKETAUX_API_TOKEN/);
  });

  it('MARKETAUX_ENABLED=true with token present → enabled, conservative defaults applied', () => {
    const result = loadMarketauxConfig(configWith({ MARKETAUX_ENABLED: 'true', MARKETAUX_API_TOKEN: 'tok' }));
    expect(result).toEqual({
      enabled: true,
      apiToken: 'tok',
      pollIntervalSeconds: 3600,
      currencies: ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'],
      limit: 3,
    });
  });

  it('parses a custom MARKETAUX_CURRENCIES list, trimming and upper-casing', () => {
    const result = loadMarketauxConfig(
      configWith({ MARKETAUX_ENABLED: 'true', MARKETAUX_API_TOKEN: 'tok', MARKETAUX_CURRENCIES: ' eur, usd ,gbp' }),
    );
    expect(result.currencies).toEqual(['EUR', 'USD', 'GBP']);
  });

  it('falls back to defaults when poll interval/limit are unset or invalid', () => {
    const base = { MARKETAUX_ENABLED: 'true', MARKETAUX_API_TOKEN: 'tok' };
    expect(loadMarketauxConfig(configWith({ ...base, MARKETAUX_POLL_INTERVAL_SECONDS: 'nope' })).pollIntervalSeconds).toBe(3600);
    expect(loadMarketauxConfig(configWith({ ...base, MARKETAUX_POLL_INTERVAL_SECONDS: '7200' })).pollIntervalSeconds).toBe(7200);
    expect(loadMarketauxConfig(configWith({ ...base, MARKETAUX_LIMIT: '3' })).limit).toBe(3);
  });
});
