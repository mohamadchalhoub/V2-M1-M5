import { ConfigService } from '@nestjs/config';

export interface MarketEventsConfig {
  enabled: boolean;
  fredApiKey: string;
  fetchIntervalSeconds: number;
  lookaheadDays: number;
}

export const MARKET_EVENTS_CONFIG = Symbol('MARKET_EVENTS_CONFIG');

// FRED's calendar doesn't change intraday — a daily tick is plenty, unlike
// the health checker's 60-second cadence.
const DEFAULT_FETCH_INTERVAL_SECONDS = 86_400;
const DEFAULT_LOOKAHEAD_DAYS = 14;

/**
 * Off by default, same posture as AiConfig — an existing deployment is
 * entirely unaffected until MARKET_EVENTS_ENABLED=true, at which point
 * FRED_API_KEY becomes required at startup (same fail-fast posture as
 * Telegram/AI).
 */
export function loadMarketEventsConfig(config: ConfigService): MarketEventsConfig {
  const enabled = (config.get<string>('MARKET_EVENTS_ENABLED') ?? 'false').trim().toLowerCase() === 'true';
  if (!enabled) {
    return { enabled: false, fredApiKey: '', fetchIntervalSeconds: DEFAULT_FETCH_INTERVAL_SECONDS, lookaheadDays: DEFAULT_LOOKAHEAD_DAYS };
  }

  const fredApiKey = config.get<string>('FRED_API_KEY')?.trim();
  if (!fredApiKey) {
    throw new Error(
      'MARKET_EVENTS_ENABLED=true but missing required configuration: FRED_API_KEY. ' +
        'See backend/.env.example, or set MARKET_EVENTS_ENABLED=false to run without market-event ingestion.',
    );
  }

  return {
    enabled: true,
    fredApiKey,
    fetchIntervalSeconds: readPositiveInt(config, 'MARKET_EVENTS_FETCH_INTERVAL_SECONDS', DEFAULT_FETCH_INTERVAL_SECONDS),
    lookaheadDays: readPositiveInt(config, 'MARKET_EVENTS_LOOKAHEAD_DAYS', DEFAULT_LOOKAHEAD_DAYS),
  };
}

function readPositiveInt(config: ConfigService, key: string, fallback: number): number {
  const raw = config.get<string>(key);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
