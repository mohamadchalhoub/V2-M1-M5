/**
 * Beirut wall-clock helpers for the XAUUSD RSI strategy.
 *
 * Deliberately self-contained rather than importing
 * `research/confirmed-retest-v2/time.ts`: that directory belongs to an
 * archived strategy which this one replaces, and the new active strategy
 * must not depend on archived code staying in place. The technique is the
 * same and equally hand-offset-free — every offset comes from the runtime's
 * own IANA database via `Intl`, never from a hardcoded +2/+3.
 *
 * Asia/Beirut observes DST, and Lebanon has in recent years changed its
 * transition dates at short notice. That is precisely why nothing here
 * computes an offset arithmetically: whatever the host's tzdata says is
 * what the schedule uses.
 */
import { SPEC } from './spec';

export const BEIRUT_TZ = SPEC.schedule.timeZone;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const offsetCache = new Map<string, number>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/**
 * Offset (wall clock − UTC) in ms for `timeZone` at UTC instant `utcMs`.
 * Cached per UTC hour — every zone this app uses changes offset only on an
 * hour boundary, so an hour bucket can never straddle a transition.
 */
export function zoneOffsetMs(timeZone: string, utcMs: number): number {
  const hourBucket = Math.floor(utcMs / HOUR_MS);
  const cacheKey = `${timeZone}|${hourBucket}`;
  const cached = offsetCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const probe = hourBucket * HOUR_MS;
  const parts = formatter(timeZone).formatToParts(new Date(probe));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offset = wall - probe;
  offsetCache.set(cacheKey, offset);
  return offset;
}

export function utcToBeirutWallMs(utcMs: number): number {
  return utcMs + zoneOffsetMs(BEIRUT_TZ, utcMs);
}

/** Seconds since Beirut midnight, 0..86399, for the UTC instant `utcMs`. */
export function beirutSecondsOfDay(utcMs: number): number {
  const wall = utcToBeirutWallMs(utcMs);
  return Math.floor((((wall % DAY_MS) + DAY_MS) % DAY_MS) / 1000);
}

/** 0 = Sunday … 5 = Friday, 6 = Saturday, in Beirut local terms. */
export function beirutDayOfWeek(utcMs: number): number {
  return new Date(utcToBeirutWallMs(utcMs)).getUTCDay();
}

export const FRIDAY = 5;

export function isBeirutFriday(utcMs: number): boolean {
  return beirutDayOfWeek(utcMs) === FRIDAY;
}

/** Beirut wall-clock date key, `YYYY-MM-DD`. */
export function beirutDateKey(utcMs: number): string {
  return new Date(utcToBeirutWallMs(utcMs)).toISOString().slice(0, 10);
}

/** Human-readable Beirut stamp for logs, incidents and the dashboard. */
export function beirutLabel(utcMs: number): string {
  const wall = new Date(utcToBeirutWallMs(utcMs));
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${dayNames[wall.getUTCDay()]} ${wall.toISOString().slice(0, 10)} ` +
    `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())} Beirut`
  );
}

/**
 * The UTC instant at which Beirut's wall clock next reads `secondsOfDay`,
 * strictly after `fromUtcMs`, optionally restricted to a given Beirut
 * weekday.
 *
 * Implemented by scanning forward minute-resolution candidate days and
 * converting each candidate wall time back through the real tz database,
 * rather than adding a fixed offset: on a DST transition day the target
 * wall time may not exist, or may exist twice, and only the database knows.
 * A wall time that does not exist on its day is skipped to the next day —
 * the schedule boundaries this is used for (01:00, 23:00, 23:30) never fall
 * in Beirut's transition hour, so this is a safety net, not a routine path.
 */
export function nextBeirutTimeAt(fromUtcMs: number, secondsOfDay: number, onlyWeekday?: number): number | null {
  for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
    const probe = fromUtcMs + dayOffset * DAY_MS;
    const wallDayStart = Math.floor(utcToBeirutWallMs(probe) / DAY_MS) * DAY_MS;
    const targetWall = wallDayStart + secondsOfDay * 1000;
    const utc = beirutWallToUtc(targetWall);
    if (utc === null) continue;
    if (utc <= fromUtcMs) continue;
    if (onlyWeekday !== undefined && beirutDayOfWeek(utc) !== onlyWeekday) continue;
    return utc;
  }
  return null;
}

/**
 * Converts a Beirut wall-clock instant (encoded as epoch ms as if it were
 * UTC) to the true UTC instant. Returns null when that wall time does not
 * exist (spring-forward gap). An ambiguous wall time (autumn repeat)
 * resolves to the FIRST occurrence, which for a pause/cutoff boundary is
 * the conservative choice: the block starts earlier and ends later in
 * wall-clock terms, never shorter than the user asked for.
 */
export function beirutWallToUtc(wallMs: number): number | null {
  const guess = wallMs - zoneOffsetMs(BEIRUT_TZ, wallMs);
  for (const candidate of [guess - HOUR_MS, guess, guess + HOUR_MS]) {
    if (utcToBeirutWallMs(candidate) === wallMs) return candidate;
  }
  return null;
}
