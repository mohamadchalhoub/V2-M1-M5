import { ConfigService } from '@nestjs/config';

export interface CentralBankCalendarConfig {
  enabled: boolean;
  fetchIntervalSeconds: number;
}

export const CENTRAL_BANK_CALENDAR_CONFIG = Symbol('CENTRAL_BANK_CALENDAR_CONFIG');

// The curated list changes only a few times a year (when each bank
// publishes its next annual calendar) — a daily tick, same cadence as
// FRED's own, is more than enough.
const DEFAULT_FETCH_INTERVAL_SECONDS = 86_400;

/**
 * Off by default, same posture as every other provider in this module
 * (MarketEventsConfig/MarketauxConfig) — an existing deployment is
 * unaffected until CENTRAL_BANK_CALENDAR_ENABLED=true. Unlike those two,
 * there is no required credential here (no external API, no key) — this
 * config exists only to gate whether the (harmless, static) ingestion job
 * runs at all, consistent with the rest of this module's "explicit opt-in"
 * convention rather than because it needs one.
 */
export function loadCentralBankCalendarConfig(config: ConfigService): CentralBankCalendarConfig {
  const enabled = (config.get<string>('CENTRAL_BANK_CALENDAR_ENABLED') ?? 'false').trim().toLowerCase() === 'true';
  return {
    enabled,
    fetchIntervalSeconds: readPositiveInt(config, 'CENTRAL_BANK_CALENDAR_FETCH_INTERVAL_SECONDS', DEFAULT_FETCH_INTERVAL_SECONDS),
  };
}

function readPositiveInt(config: ConfigService, key: string, fallback: number): number {
  const raw = config.get<string>(key);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
