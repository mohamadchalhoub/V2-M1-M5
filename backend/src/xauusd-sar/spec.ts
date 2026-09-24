/**
 * `xauusd-sar-v1` — the strategy this file replaces `xauusd-m1-m5-rsi-threshold-v2`
 * (Engine A) with: a single, continuous $0.50 trailing stop-and-reverse on
 * XAUUSD.
 *
 * There is no RSI, no M1/M5 split, no crossing/rearming, no post-loss lock and
 * no 14:00–19:00 / 23:30–01:00 entry pause. Those all belonged to the old
 * strategy this replaces; none of them constrain this one. The old strategy's
 * files remain in the repository, untouched, for historical audit — see
 * `src/xauusd-m1m5/`.
 *
 * Engine B (`telegram-engine/`) is a completely separate engine and is not
 * touched by anything in this directory.
 */
import { createHash } from 'node:crypto';

export const XAUUSD_SAR_STRATEGY_VERSION = 'xauusd-sar-v1';

export type SarDirection = 'BUY' | 'SELL';

export const SPEC = {
  strategyVersion: XAUUSD_SAR_STRATEGY_VERSION,
  symbol: 'XAUUSD',

  /**
   * The reversal distance, in quoted XAUUSD price — NOT P&L, NOT broker
   * points, NOT a percentage. Configurable via
   * `XAUUSD_SAR_REVERSAL_DISTANCE_USD`, default 0.50, validated positive and
   * finite at read time (an unset or invalid value falls back to the
   * default rather than to zero, which would fire on every tick).
   */
  reversalDistanceUsd: 0.5,

  schedule: {
    timeZone: 'Asia/Beirut',
    /** Session start: the earliest instant a new session may initialize. */
    sessionStartSecondsBeirut: 1 * 3600,
    /** Daily close: no new exposure at or after this instant; flatten and stop. */
    dailyCloseSecondsBeirut: 23 * 3600 + 40 * 60,
  },

  observation: {
    /** Same cadence and staleness posture as the quote infra this reuses. */
    targetIntervalMs: 1_000,
    maxStalenessMs: 30_000,
    maxFutureToleranceMs: 2_000,
  },
} as const;

export type XauusdSarSpec = typeof SPEC;

export const SPEC_HASH = createHash('sha256').update(JSON.stringify(SPEC)).digest('hex').slice(0, 16);

/** Seconds since local midnight, in `timeZone`, for a UTC instant. */
export function secondsOfDayInZone(atMs: number, timeZone: string = SPEC.schedule.timeZone): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(atMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return get('hour') * 3600 + get('minute') * 60 + get('second');
}

/** The calendar date (YYYY-MM-DD) in `timeZone` at instant `atMs`. */
export function localDateInZone(atMs: number, timeZone: string = SPEC.schedule.timeZone): string {
  const offsetMs = (() => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(atMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return wallAsUtc - Math.floor(atMs / 1000) * 1000;
  })();
  return new Date(atMs + offsetMs).toISOString().slice(0, 10);
}

/** True at/after 23:40 Beirut and before the next 01:00 Beirut. */
export function isWithinDailyClose(atMs: number): boolean {
  const s = secondsOfDayInZone(atMs);
  return s >= SPEC.schedule.dailyCloseSecondsBeirut || s < SPEC.schedule.sessionStartSecondsBeirut;
}

/** True at/after 01:00 Beirut and before 23:40 Beirut the same day. */
export function isWithinTradingWindow(atMs: number): boolean {
  return !isWithinDailyClose(atMs);
}
