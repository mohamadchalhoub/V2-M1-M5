import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { loadMarketEventsConfig } from '../../src/market-events/market-events.config';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('loadMarketEventsConfig — off by default, same posture as AiConfig', () => {
  it('MARKET_EVENTS_ENABLED unset → disabled, no other vars required', () => {
    expect(loadMarketEventsConfig(configWith({})).enabled).toBe(false);
  });

  it('MARKET_EVENTS_ENABLED=true with FRED_API_KEY missing → throws naming it', () => {
    expect(() => loadMarketEventsConfig(configWith({ MARKET_EVENTS_ENABLED: 'true' }))).toThrow(/FRED_API_KEY/);
  });

  it('MARKET_EVENTS_ENABLED=true with everything present → enabled, values passed through', () => {
    const result = loadMarketEventsConfig(
      configWith({ MARKET_EVENTS_ENABLED: 'true', FRED_API_KEY: 'k' }),
    );
    expect(result).toEqual({ enabled: true, fredApiKey: 'k', fetchIntervalSeconds: 86400, lookaheadDays: 14 });
  });

  it('falls back to defaults when interval/lookahead are unset or invalid', () => {
    const base = { MARKET_EVENTS_ENABLED: 'true', FRED_API_KEY: 'k' };
    expect(loadMarketEventsConfig(configWith(base)).fetchIntervalSeconds).toBe(86400);
    expect(
      loadMarketEventsConfig(configWith({ ...base, MARKET_EVENTS_FETCH_INTERVAL_SECONDS: 'nope' })).fetchIntervalSeconds,
    ).toBe(86400);
    expect(
      loadMarketEventsConfig(configWith({ ...base, MARKET_EVENTS_FETCH_INTERVAL_SECONDS: '3600' })).fetchIntervalSeconds,
    ).toBe(3600);
    expect(loadMarketEventsConfig(configWith({ ...base, MARKET_EVENTS_LOOKAHEAD_DAYS: '7' })).lookaheadDays).toBe(7);
  });
});
