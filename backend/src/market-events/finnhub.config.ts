import { ConfigService } from '@nestjs/config';

export interface FinnhubConfig {
  enabled: boolean;
  apiKey: string;
  pollIntervalSeconds: number;
  /** Articles kept per ingestion tick — Finnhub's forex-category feed can return dozens; only the most recent N are worth storing/showing. */
  limit: number;
  /** Finnhub's forex feed carries no per-article currency tagging at all — every ingested article is tagged with this whole list (same honest-simplification posture as its MEDIUM impact/UNCERTAIN sentiment defaults), overridable via FINNHUB_CURRENCIES. */
  currencies: string[];
}

export const FINNHUB_CONFIG = Symbol('FINNHUB_CONFIG');

// Finnhub's free tier is 60 API calls/minute — far looser than Marketaux's
// 100/day, so a much shorter interval is safe. 30 minutes keeps forex news
// reasonably fresh without being spammy (this is a news feed, not a price
// feed) — well under 60/minute even accounting for manual re-runs.
const DEFAULT_POLL_INTERVAL_SECONDS = 1800;
const DEFAULT_LIMIT = 5;
const DEFAULT_CURRENCIES = ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

/**
 * Off by default, same posture as every other optional integration in this
 * app (MarketauxConfig/MarketEventsConfig/AiConfig) — an existing
 * deployment is entirely unaffected until FINNHUB_ENABLED=true, at which
 * point FINNHUB_API_KEY becomes required at startup (same fail-fast
 * posture). A fourth, independent news/calendar provider alongside
 * FRED/Marketaux/the curated central-bank calendar — never tightly
 * coupled to any of them.
 */
export function loadFinnhubConfig(config: ConfigService): FinnhubConfig {
  const enabled = (config.get<string>('FINNHUB_ENABLED') ?? 'false').trim().toLowerCase() === 'true';
  if (!enabled) {
    return { enabled: false, apiKey: '', pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS, limit: DEFAULT_LIMIT, currencies: DEFAULT_CURRENCIES };
  }

  const apiKey = config.get<string>('FINNHUB_API_KEY')?.trim();
  if (!apiKey) {
    throw new Error(
      'FINNHUB_ENABLED=true but missing required configuration: FINNHUB_API_KEY. ' +
        'See backend/.env.example, or set FINNHUB_ENABLED=false to run without Finnhub news ingestion.',
    );
  }

  const currenciesRaw = config.get<string>('FINNHUB_CURRENCIES')?.trim();
  const currencies = currenciesRaw
    ? currenciesRaw.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_CURRENCIES;

  return {
    enabled: true,
    apiKey,
    pollIntervalSeconds: readPositiveInt(config, 'FINNHUB_POLL_INTERVAL_SECONDS', DEFAULT_POLL_INTERVAL_SECONDS),
    limit: readPositiveInt(config, 'FINNHUB_NEWS_LIMIT', DEFAULT_LIMIT),
    currencies,
  };
}

function readPositiveInt(config: ConfigService, key: string, fallback: number): number {
  const raw = config.get<string>(key);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
