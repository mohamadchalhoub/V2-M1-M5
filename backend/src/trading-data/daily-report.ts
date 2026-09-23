/**
 * The combined daily report: every position closed during one Beirut calendar
 * day, counted as a win or a loss, per engine and timeframe.
 *
 * Pure: the day boundaries, the tally and the text. The service decides when
 * to run it and delivers it.
 */
import type { EngineAttribution } from './engine-attribution';

export const REPORT_TIMEZONE = 'Asia/Beirut';

/** Offset of `timeZone` from UTC at instant `atMs`, in ms (wall clock minus UTC). */
function zoneOffsetMs(atMs: number, timeZone: string): number {
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
}

/** The calendar date (YYYY-MM-DD) in `timeZone` at instant `atMs`. */
export function localDate(atMs: number, timeZone: string = REPORT_TIMEZONE): string {
  return new Date(atMs + zoneOffsetMs(atMs, timeZone)).toISOString().slice(0, 10);
}

/** The date before `date` (YYYY-MM-DD). */
export function previousDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** UTC instant of local midnight at the start of `date` in `timeZone`. DST-safe. */
export function localMidnightUtc(date: string, timeZone: string = REPORT_TIMEZONE): number {
  const [y, m, d] = date.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d);
  let guess = naive - zoneOffsetMs(naive, timeZone);
  guess = naive - zoneOffsetMs(guess, timeZone);
  return guess;
}

/** [start, end) of `date` in `timeZone`, as UTC ms. */
export function dayBounds(date: string, timeZone: string = REPORT_TIMEZONE): { startMs: number; endMs: number } {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { startMs: localMidnightUtc(date, timeZone), endMs: localMidnightUtc(next, timeZone) };
}

export interface ClosedPosition {
  readonly attribution: EngineAttribution;
  /** Profit + commission + swap across every deal of the position. */
  readonly net: number;
}

export interface Tally {
  wins: number;
  losses: number;
  zero: number;
  net: number;
}

export interface DailyReport {
  readonly date: string;
  readonly accountLabel: string;
  readonly currency: string;
  readonly engineAM1: Tally;
  readonly engineAM5: Tally;
  readonly engineB: Tally;
  readonly other: Tally;
  readonly total: Tally;
}

const empty = (): Tally => ({ wins: 0, losses: 0, zero: 0, net: 0 });

function add(t: Tally, net: number): void {
  if (net > 0) t.wins += 1;
  else if (net < 0) t.losses += 1;
  else t.zero += 1;
  t.net += net;
}

export function buildDailyReport(
  date: string,
  accountLabel: string,
  currency: string,
  positions: readonly ClosedPosition[],
): DailyReport {
  const r = {
    date,
    accountLabel,
    currency,
    engineAM1: empty(),
    engineAM5: empty(),
    engineB: empty(),
    other: empty(),
    total: empty(),
  };
  for (const p of positions) {
    const { engine, timeframe } = p.attribution;
    const bucket =
      engine === 'Engine A' && timeframe === 'M1'
        ? r.engineAM1
        : engine === 'Engine A' && timeframe === 'M5'
          ? r.engineAM5
          : engine === 'Engine B'
            ? r.engineB
            : r.other;
    add(bucket, p.net);
    add(r.total, p.net);
  }
  return r;
}

export function renderDailyReport(r: DailyReport): string {
  const money = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)} ${r.currency}`;
  const line = (label: string, t: Tally) =>
    `${label}: ${t.wins} win${t.wins === 1 ? '' : 's'}, ${t.losses} loss${t.losses === 1 ? '' : 'es'}` +
    (t.zero > 0 ? `, ${t.zero} break-even` : '') +
    ` — net ${money(t.net)}`;
  const otherCount = r.other.wins + r.other.losses + r.other.zero;
  return [
    `📊 DAILY REPORT — ${r.date} (Beirut time)`,
    `Account: ${r.accountLabel}`,
    '',
    line('Engine A — M1', r.engineAM1),
    line('Engine A — M5', r.engineAM5),
    line('Engine B — Telegram', r.engineB),
    otherCount > 0 ? line('Other (manual / legacy)', r.other) : null,
    '',
    line('TOTAL', r.total),
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}
