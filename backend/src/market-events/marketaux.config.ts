import { ConfigService } from '@nestjs/config';

export interface MarketauxConfig {
  enabled: boolean;
  apiToken: string;
  pollIntervalSeconds: number;
  /** ISO currency codes (e.g. "EUR") this deployment's accounts actually trade — never the full global feed. */
  currencies: string[];
  /** Articles per request — the free plan caps this at 3 regardless of what's requested. */
  limit: number;
}

export const MARKETAUX_CONFIG = Symbol('MARKETAUX_CONFIG');

// Marketaux's free plan is 100 requests/day (per PROJECT context, confirmed
// by the user, not scraped from their docs at build time). An hourly tick
// is 24 requests/day — comfortable headroom under the cap even accounting
// for the queue's own small retry budget (market-events.module.ts's
// MARKET_NEWS_QUEUE) and manual re-runs during development. Deliberately
// far more conservative than FRED's daily tick is aggressive for FRED,
// because FRED has no documented low daily ceiling and Marketaux does.
const DEFAULT_POLL_INTERVAL_SECONDS = 3600;
const DEFAULT_LIMIT = 3;
// The account's own currencies aren't known at config-load time (they live
// per-TradingAccount in Postgres, read only after the app has booted) — a
// fixed, broadly-useful default covering the major/commodity-bloc pairs a
// discretionary retail forex/CFD trader is most likely to hold, overridable
// via MARKETAUX_CURRENCIES once real accounts are known.
const DEFAULT_CURRENCIES = ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

/**
 * Off by default, same posture as MarketEventsConfig/AiConfig — an existing
 * deployment is entirely unaffected until MARKETAUX_ENABLED=true, at which
 * point MARKETAUX_API_TOKEN becomes required at startup (same fail-fast
 * posture as every other optional integration in this app). Deliberately a
 * SEPARATE config/token from MARKET_EVENTS_CONFIG (FRED) — the two
 * providers are independent and either can be toggled without touching the
 * other (PHASE 2 of the market-intelligence build: "do NOT tightly couple
 * FRED and Marketaux").
 */
export function loadMarketauxConfig(config: ConfigService): MarketauxConfig {
  const enabled = (config.get<string>('MARKETAUX_ENABLED') ?? 'false').trim().toLowerCase() === 'true';
  if (!enabled) {
    return {
      enabled: false,
      apiToken: '',
      pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
      currencies: DEFAULT_CURRENCIES,
      limit: DEFAULT_LIMIT,
    };
  }

  const apiToken = config.get<string>('MARKETAUX_API_TOKEN')?.trim();
  if (!apiToken) {
    throw new Error(
      'MARKETAUX_ENABLED=true but missing required configuration: MARKETAUX_API_TOKEN. ' +
        'See backend/.env.example, or set MARKETAUX_ENABLED=false to run without news ingestion.',
    );
  }

  const currenciesRaw = config.get<string>('MARKETAUX_CURRENCIES')?.trim();
  const currencies = currenciesRaw
    ? currenciesRaw
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean)
    : DEFAULT_CURRENCIES;

  return {
    enabled: true,
    apiToken,
    pollIntervalSeconds: readPositiveInt(config, 'MARKETAUX_POLL_INTERVAL_SECONDS', DEFAULT_POLL_INTERVAL_SECONDS),
    currencies,
    limit: readPositiveInt(config, 'MARKETAUX_LIMIT', DEFAULT_LIMIT),
  };
}

function readPositiveInt(config: ConfigService, key: string, fallback: number): number {
  const raw = config.get<string>(key);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
