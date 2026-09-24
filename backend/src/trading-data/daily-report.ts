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
  readonly side?: 'BUY' | 'SELL' | null;
  readonly volume?: number | null;
  readonly openPrice?: number | null;
  readonly closePrice?: number | null;
  readonly closedAtMs?: number | null;
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
  /** xauusd-sar-v1 — the strategy replacement, no timeframe split. */
  readonly engineASar: Tally;
  readonly engineB: Tally;
  readonly other: Tally;
  readonly total: Tally;
  /** Every closed position, in closing order, for the per-order lines. */
  readonly positions: readonly ClosedPosition[];
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
    engineASar: empty(),
    engineB: empty(),
    other: empty(),
    total: empty(),
    positions: [...positions].sort((a, b) => (a.closedAtMs ?? 0) - (b.closedAtMs ?? 0)),
  };
  for (const p of positions) {
    const { engine, timeframe } = p.attribution;
    const bucket =
      engine === 'Engine A' && timeframe === 'M1'
        ? r.engineAM1
        : engine === 'Engine A' && timeframe === 'M5'
          ? r.engineAM5
          : engine === 'Engine A'
            ? r.engineASar // Engine A, no timeframe: xauusd-sar-v1.
            : engine === 'Engine B'
              ? r.engineB
              : r.other;
    add(bucket, p.net);
    add(r.total, p.net);
  }
  return r;
}

function beirutTime(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: REPORT_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

/**
 * One Telegram-safe text per part. A single message is capped at 4096
 * characters by Telegram; a busy day's per-order list can exceed that, so the
 * report is split on line boundaries rather than truncated.
 */
export function renderDailyReport(r: DailyReport, maxChars = 3800): string[] {
  const money = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)} ${r.currency}`;
  const price = (v: number | null | undefined) => (v === null || v === undefined ? '?' : String(v));

  const orderLine = (p: ClosedPosition, i: number) => {
    const result = p.net > 0 ? '✅ WIN' : p.net < 0 ? '❌ LOSS' : '➖ EVEN';
    const frame = p.attribution.timeframe ? `${p.attribution.timeframe} · ` : '';
    const closed = p.closedAtMs ? ` · closed ${beirutTime(p.closedAtMs)}` : '';
    return (
      `${i + 1}. ${frame}${p.side ?? '?'} ${p.volume ?? '?'} lot · ${price(p.openPrice)} → ${price(p.closePrice)}` +
      `${closed} · ${result} ${money(p.net)}`
    );
  };

  const sum = (list: readonly ClosedPosition[]) => list.reduce((s, p) => s + p.net, 0);

  const section = (title: string, name: string, list: readonly ClosedPosition[]) => [
    title,
    ...(list.length ? list.map(orderLine) : ['No closed orders.']),
    ...(list.length ? [`➡️ ${name} net: ${money(sum(list))}`] : []),
    '',
  ];

  const engineA = r.positions.filter((p) => p.attribution.engine === 'Engine A');
  const engineB = r.positions.filter((p) => p.attribution.engine === 'Engine B');
  const other = r.positions.filter((p) => p.attribution.engine !== 'Engine A' && p.attribution.engine !== 'Engine B');

  const winsNet = r.positions.filter((p) => p.net > 0).reduce((s, p) => s + p.net, 0);
  const lossesNet = r.positions.filter((p) => p.net < 0).reduce((s, p) => s + p.net, 0);

  const lines = [
    `📊 DAILY REPORT — ${r.date} (Beirut time)`,
    `Account: ${r.accountLabel}`,
    '',
    ...section('🅰️ ENGINE A (Stop & Reverse; M1/M5 lines are historical RSI trades)', 'Engine A', engineA),
    ...section('🅱️ ENGINE B (Telegram)', 'Engine B', engineB),
    ...(other.length ? section('Other (manual / legacy)', 'Other', other) : []),
    'TOTAL',
    `Engine A net: ${money(sum(engineA))}`,
    `Engine B net: ${money(sum(engineB))}`,
    ...(other.length ? [`Other net: ${money(sum(other))}`] : []),
    `Winning orders: ${r.total.wins} · ${money(winsNet)}`,
    `Losing orders: ${r.total.losses} · ${money(lossesNet)}`,
    ...(r.total.zero > 0 ? [`Break-even orders: ${r.total.zero}`] : []),
    `Net: ${money(r.total.net)}`,
  ];

  const parts: string[] = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxChars && current) {
      parts.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) parts.push(current);
  return parts.length > 1 ? parts.map((p, i) => `${p}\n\n(part ${i + 1}/${parts.length})`) : parts;
}
