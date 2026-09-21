// Trading-day boundary math (ANALYTICS_SPEC.md §1). Storage is always UTC;
// "trading day" is an explicit per-account timezone + reset hour, never
// inferred (Phase 0 Revision 1 §04). No timezone package is required —
// Intl.DateTimeFormat already knows every IANA zone's offset, including DST.

export interface TradingDayBoundary {
  start: Date;
  end: Date;
}

/** Local-minus-UTC offset, in minutes, in effect for `instant` in `tz`. */
export function getUtcOffsetMinutes(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(instant).map((p) => [p.type, p.value]));
  const asUtcIfLocalWereUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtcIfLocalWereUtc - instant.getTime()) / 60_000;
}

/**
 * Converts a local wall-clock date/time in `tz` to the UTC instant it
 * represents. Two-pass: the offset can differ near a DST transition, so the
 * first pass's offset is used to get close, then re-resolved against that
 * result — sufficient because offset changes are at most a couple of hours.
 */
function localWallClockToUtc(
  year: number,
  month0: number,
  day: number,
  hour: number,
  tz: string,
): Date {
  const naiveUtcMs = Date.UTC(year, month0, day, hour, 0, 0);
  const offset1 = getUtcOffsetMinutes(new Date(naiveUtcMs), tz);
  const candidate1 = new Date(naiveUtcMs - offset1 * 60_000);
  const offset2 = getUtcOffsetMinutes(candidate1, tz);
  return new Date(naiveUtcMs - offset2 * 60_000);
}

/** The local calendar date (per `tz`) that `instant` falls on, plus the local hour. */
function localDateParts(instant: Date, tz: string): { year: number; month0: number; day: number; hour: number } {
  const offset = getUtcOffsetMinutes(instant, tz);
  const shifted = new Date(instant.getTime() + offset * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month0: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
  };
}

/**
 * The trading day that contains `instant`: local date `D` at `resetHour` to
 * local date `D+1` at `resetHour`. If the local hour is before `resetHour`,
 * `instant` belongs to the trading day that *started the previous calendar
 * date*.
 */
export function tradingDayBoundaryContaining(
  instant: Date,
  tz: string,
  resetHour: number,
): TradingDayBoundary {
  const { year, month0, day, hour } = localDateParts(instant, tz);
  const startsOnPreviousLocalDate = hour < resetHour;
  const boundaryDate = new Date(Date.UTC(year, month0, day));
  if (startsOnPreviousLocalDate) {
    boundaryDate.setUTCDate(boundaryDate.getUTCDate() - 1);
  }

  const start = localWallClockToUtc(
    boundaryDate.getUTCFullYear(),
    boundaryDate.getUTCMonth(),
    boundaryDate.getUTCDate(),
    resetHour,
    tz,
  );
  const end = nextTradingDayBoundaryStart(start, tz, resetHour);
  return { start, end };
}

/** The start of the trading day immediately after the one starting at `boundaryStart`. */
export function nextTradingDayBoundaryStart(boundaryStart: Date, tz: string, resetHour: number): Date {
  const { year, month0, day } = localDateParts(boundaryStart, tz);
  const nextDate = new Date(Date.UTC(year, month0, day));
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return localWallClockToUtc(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth(),
    nextDate.getUTCDate(),
    resetHour,
    tz,
  );
}

/** The start of the trading day immediately before the one starting at `boundaryStart`. */
export function previousTradingDayBoundaryStart(boundaryStart: Date, tz: string, resetHour: number): Date {
  const { year, month0, day } = localDateParts(boundaryStart, tz);
  const prevDate = new Date(Date.UTC(year, month0, day));
  prevDate.setUTCDate(prevDate.getUTCDate() - 1);
  return localWallClockToUtc(
    prevDate.getUTCFullYear(),
    prevDate.getUTCMonth(),
    prevDate.getUTCDate(),
    resetHour,
    tz,
  );
}

/**
 * All trading-day boundary starts in `[windowStart, windowEnd)`, ascending,
 * inclusive of `windowStart` if it lands exactly on a boundary. Used to
 * build the baseline window's day buckets without pulling raw rows.
 */
export function tradingDayBoundariesInRange(
  windowStart: Date,
  windowEnd: Date,
  tz: string,
  resetHour: number,
): Date[] {
  const boundaries: Date[] = [];
  let cursor = tradingDayBoundaryContaining(windowStart, tz, resetHour).start;
  while (cursor.getTime() < windowEnd.getTime()) {
    if (cursor.getTime() >= windowStart.getTime()) {
      boundaries.push(cursor);
    }
    cursor = nextTradingDayBoundaryStart(cursor, tz, resetHour);
  }
  return boundaries;
}
