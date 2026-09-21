/**
 * research/confirmed-retest-v2/time — timezone conversions with no hand-rolled
 * offsets: every offset comes from the runtime's IANA database via Intl,
 * cached per UTC hour (both zones used here only ever change offset on an
 * hour boundary).
 */
import type { BeirutStamp } from './types';

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

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
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Offset (wall clock − UTC) in ms for `timeZone` at the UTC instant `utcMs`. */
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

export class WallClockConversionError extends Error {}

/**
 * Converts wall-clock digits (encoded as if they were UTC epoch ms, which is
 * exactly how the stored MT5 candle times arrive) in `timeZone` to true UTC.
 * Throws for wall-clock times that do not exist or exist twice (DST
 * transitions) — XAUUSD never trades in those Sunday hours, so any such bar
 * is a data problem, not something to guess about.
 */
export function wallClockToUtc(timeZone: string, wallMs: number): number {
  const guess = wallMs - zoneOffsetMs(timeZone, wallMs);
  const offset = zoneOffsetMs(timeZone, guess);
  const utc = wallMs - offset;
  if (zoneOffsetMs(timeZone, utc) !== offset) {
    throw new WallClockConversionError(`${new Date(wallMs).toISOString()} is not a valid ${timeZone} wall-clock time`);
  }
  const altOffsets = [offset - HOUR_MS, offset + HOUR_MS];
  for (const alt of altOffsets) {
    const altUtc = wallMs - alt;
    if (zoneOffsetMs(timeZone, altUtc) === alt) {
      throw new WallClockConversionError(`${new Date(wallMs).toISOString()} is an ambiguous ${timeZone} wall-clock time`);
    }
  }
  return utc;
}

export function utcToWallClockMs(timeZone: string, utcMs: number): number {
  return utcMs + zoneOffsetMs(timeZone, utcMs);
}

export const BEIRUT_TZ = 'Asia/Beirut';

export function beirutStamp(utcMs: number): BeirutStamp {
  const wall = new Date(utcToWallClockMs(BEIRUT_TZ, utcMs));
  const year = wall.getUTCFullYear();
  const month = wall.getUTCMonth() + 1;
  return {
    date: wall.toISOString().slice(0, 10),
    year,
    half: `${year}-H${month <= 6 ? 1 : 2}`,
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
  };
}

export function beirutSecondsOfDay(utcMs: number): number {
  const wall = utcToWallClockMs(BEIRUT_TZ, utcMs);
  const dayMs = 86_400_000;
  return Math.floor((((wall % dayMs) + dayMs) % dayMs) / 1000);
}

/** Beirut wall-clock date key (YYYY-MM-DD) for the daily-loss day. */
export function beirutDateKey(utcMs: number): string {
  return new Date(utcToWallClockMs(BEIRUT_TZ, utcMs)).toISOString().slice(0, 10);
}

export function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}
