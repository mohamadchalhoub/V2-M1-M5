/**
 * §4 — Entry schedule. "Timezone: Asia/Beirut. New entries are permitted
 * only 03:00:00 inclusive through 12:00:00 exclusive, Beirut local time...
 * Use an IANA timezone implementation, including daylight-saving
 * transitions... Do not equate broker server time with Beirut time. Store
 * canonical timestamps in UTC."
 *
 * Everything below takes a UTC `Date` (this codebase's canonical timestamp,
 * matching every other module) and converts it to Beirut wall-clock time via
 * `Intl.DateTimeFormat` with an explicit IANA zone — the JS engine's own
 * ICU tzdata resolves DST transitions correctly (verified live in this
 * session against 2026-03-27, the date Lebanon's own DST rule takes effect
 * that year), never a fixed UTC+2/UTC+3 offset hand-computed here. This is
 * the ONLY place in the trend-breakout strategy that reasons about Beirut
 * time — the collector's own broker-timezone conversion
 * (mt5_client.py's `_mt5_time_to_utc`) is a completely separate concern
 * (broker-server wall-clock vs. true UTC) and must never be confused with
 * this one (true UTC vs. Beirut local) — see that file's own docstring.
 */

export const BEIRUT_TIMEZONE = 'Asia/Beirut';

/** Inclusive lower bound, exclusive upper bound — 03:00:00 through 11:59:59.999, Beirut local. */
export const ENTRY_WINDOW_START_SECONDS = 3 * 3600;
export const ENTRY_WINDOW_END_SECONDS = 12 * 3600;

export interface BeirutWallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
  /** "YYYY-MM-DD" — the Beirut CALENDAR day this instant falls on, used as the daily-loss reset key (§10). */
  dateKey: string;
}

// hourCycle: 'h23' is required, not optional — en-US's DEFAULT hour cycle
// for hour12:false is "h24", which renders midnight as "24:00:00" instead
// of "00:00:00". That would silently break the entry-window boundary
// check at exactly midnight Beirut time (a real, verifiable footgun, not a
// hypothetical one) if left as the Intl default.
const FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: BEIRUT_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function getBeirutWallClock(utcNow: Date): BeirutWallClock {
  const parts = FORMATTER.formatToParts(utcNow);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');
  const dateKey = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { year, month, day, hour, minute, second, dateKey };
}

/**
 * §4 — "Check eligibility immediately before submission, not just when
 * detecting a signal... Do not submit at or after noon." Callers MUST call
 * this again right before actually sending an order, not just when a
 * signal was first detected — the two can legitimately be seconds to tens
 * of seconds apart (§8's 60s expiry window), which is enough to cross the
 * noon boundary in the worst case.
 */
export function isWithinEntryWindow(utcNow: Date): boolean {
  const { hour, minute, second } = getBeirutWallClock(utcNow);
  const secondsOfDay = hour * 3600 + minute * 60 + second;
  return secondsOfDay >= ENTRY_WINDOW_START_SECONDS && secondsOfDay < ENTRY_WINDOW_END_SECONDS;
}

/** The Beirut calendar-day key for daily-loss baseline/reset purposes (§10) — "Use the Beirut calendar day." */
export function getBeirutCalendarDate(utcNow: Date): string {
  return getBeirutWallClock(utcNow).dateKey;
}
