import { ConfigService } from '@nestjs/config';
import { CandleTimeframe } from '@prisma/client';

export const TECHNICAL_ANALYSIS_CONFIG = Symbol('TECHNICAL_ANALYSIS_CONFIG');

export interface TechnicalAnalysisConfig {
  supportResistanceProximityPoints: number;
  ichimokuTimeframes: CandleTimeframe[];
  /** "HH:MM", 24-hour, in dailyAnalysisTimezone. */
  dailyAnalysisTime: string;
  /** IANA timezone — the trader's own, not necessarily the server's (user's explicit instruction). */
  dailyAnalysisTimezone: string;
  fibonacciLookbackDays: number;
  marketDirectionLookbackDays: number;
}

const DEFAULT_PROXIMITY_POINTS = 50;
const DEFAULT_ICHIMOKU_TIMEFRAMES: CandleTimeframe[] = ['M30', 'H1', 'H4', 'D1'];
const DEFAULT_DAILY_ANALYSIS_TIME = '08:00';
const DEFAULT_DAILY_ANALYSIS_TIMEZONE = 'Asia/Beirut';
const DEFAULT_FIBONACCI_LOOKBACK_DAYS = 90;
const DEFAULT_MARKET_DIRECTION_LOOKBACK_DAYS = 90;

const VALID_TIMEFRAMES: readonly CandleTimeframe[] = ['M5', 'M15', 'H1', 'M30', 'H4', 'D1', 'W1', 'MN1'];
const HHMM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * User's 4-rule spec — every value here is something they explicitly asked
 * to be configurable via `.env` (not a per-account/per-`RuleDefinition`
 * parameter — unlike every other rule type in this system, there is only
 * ever one EURUSD market to analyze, so "which timeframes"/"how far back"
 * are system-wide settings, not something that varies per rule instance).
 * Rules 1/2's Prisma parameters stay empty, same precedent as
 * NoStopLossParamsDto. Always loaded (no enabled flag) — these are read
 * only by evaluators for rule types that must already be explicitly
 * enabled per-account via `manage-rules.ts`, so there's no separate
 * on/off switch to duplicate.
 */
export function loadTechnicalAnalysisConfig(config: ConfigService): TechnicalAnalysisConfig {
  const proximityRaw = config.get<string>('SUPPORT_RESISTANCE_PROXIMITY_POINTS');
  const supportResistanceProximityPoints = readPositiveNumber(proximityRaw, DEFAULT_PROXIMITY_POINTS, 'SUPPORT_RESISTANCE_PROXIMITY_POINTS');

  const timeframesRaw = config.get<string>('ICHIMOKU_TIMEFRAMES');
  const ichimokuTimeframes = parseTimeframes(timeframesRaw) ?? DEFAULT_ICHIMOKU_TIMEFRAMES;

  const dailyAnalysisTime = config.get<string>('DAILY_ANALYSIS_TIME')?.trim() || DEFAULT_DAILY_ANALYSIS_TIME;
  if (!HHMM_PATTERN.test(dailyAnalysisTime)) {
    throw new Error(`DAILY_ANALYSIS_TIME must be "HH:MM" 24-hour format, got "${dailyAnalysisTime}"`);
  }

  const dailyAnalysisTimezone = config.get<string>('DAILY_ANALYSIS_TIMEZONE')?.trim() || DEFAULT_DAILY_ANALYSIS_TIMEZONE;
  assertValidTimezone(dailyAnalysisTimezone);

  const fibonacciLookbackDays = readPositiveNumber(config.get<string>('FIBONACCI_LOOKBACK'), DEFAULT_FIBONACCI_LOOKBACK_DAYS, 'FIBONACCI_LOOKBACK');
  const marketDirectionLookbackDays = readPositiveNumber(
    config.get<string>('MARKET_DIRECTION_LOOKBACK'),
    DEFAULT_MARKET_DIRECTION_LOOKBACK_DAYS,
    'MARKET_DIRECTION_LOOKBACK',
  );

  return {
    supportResistanceProximityPoints,
    ichimokuTimeframes,
    dailyAnalysisTime,
    dailyAnalysisTimezone,
    fibonacciLookbackDays,
    marketDirectionLookbackDays,
  };
}

function parseTimeframes(raw: string | undefined): CandleTimeframe[] | null {
  if (!raw || raw.trim() === '') return null;
  const values = raw.split(',').map((t) => t.trim().toUpperCase());
  const invalid = values.filter((v) => !(VALID_TIMEFRAMES as string[]).includes(v));
  if (invalid.length > 0) {
    throw new Error(`ICHIMOKU_TIMEFRAMES contains unsupported value(s) ${JSON.stringify(invalid)}; must be one of ${VALID_TIMEFRAMES.join(', ')}`);
  }
  return values as CandleTimeframe[];
}

function readPositiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return parsed;
}

function assertValidTimezone(tz: string): void {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`DAILY_ANALYSIS_TIMEZONE "${tz}" is not a valid IANA timezone`);
  }
}
