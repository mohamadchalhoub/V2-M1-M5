/**
 * research/confirmed-retest-v2/data-source — READ-ONLY loader for stored broker
 * candles. Converts the stored broker-server wall-clock `open_time` to true
 * UTC, converts decimals to integer price units in SQL (exactness checked,
 * never rounded silently), validates every row and hashes exactly what was
 * loaded. No writes, no MT5, no network.
 */
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { SeriesBar, SeriesMap } from './gaps';
import { SPEC } from './spec';
import { WallClockConversionError, wallClockToUtc } from './time';
import type { Timeframe } from './types';

export const DURATION_MS: Record<Timeframe, number> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  M30: 1_800_000,
  H1: 3_600_000,
  H4: 14_400_000,
  D1: 86_400_000,
};

export interface SeriesValidation {
  timeframe: Timeframe;
  rows: number;
  firstServer: string | null;
  lastServer: string | null;
  firstUtc: string | null;
  lastUtc: string | null;
  nonCentPrices: number;
  ohlcViolations: number;
  nonIncreasingTimestamps: number;
  gridMisaligned: number;
  weekendServerBars: number;
  timezoneConversionErrors: number;
  examples: string[];
}

interface RawRow {
  st: bigint;
  o: bigint;
  h: bigint;
  l: bigint;
  c: bigint;
  frac: boolean;
}

const PAGE = 200_000;

function gridAligned(tf: Timeframe, serverT: number): boolean {
  const d = new Date(serverT);
  if (d.getUTCSeconds() !== 0 || d.getUTCMilliseconds() !== 0) return false;
  switch (tf) {
    case 'M1':
      return true;
    case 'M5':
      return d.getUTCMinutes() % 5 === 0;
    case 'M15':
      return d.getUTCMinutes() % 15 === 0;
    case 'M30':
      return d.getUTCMinutes() % 30 === 0;
    case 'H1':
      return d.getUTCMinutes() === 0;
    case 'H4':
      return d.getUTCMinutes() === 0 && d.getUTCHours() % 4 === 0;
    case 'D1':
      return d.getUTCMinutes() === 0 && d.getUTCHours() === 0;
  }
}

export async function loadSeries(
  prisma: PrismaClient,
  symbol: string,
  timeframe: Timeframe,
  endUtcT: number,
  hash: ReturnType<typeof createHash>,
): Promise<{ bars: SeriesBar[]; validation: SeriesValidation }> {
  const bars: SeriesBar[] = [];
  const v: SeriesValidation = {
    timeframe,
    rows: 0,
    firstServer: null,
    lastServer: null,
    firstUtc: null,
    lastUtc: null,
    nonCentPrices: 0,
    ohlcViolations: 0,
    nonIncreasingTimestamps: 0,
    gridMisaligned: 0,
    weekendServerBars: 0,
    timezoneConversionErrors: 0,
    examples: [],
  };
  const dur = DURATION_MS[timeframe];
  let cursorMs = -1;
  for (;;) {
    const rows = await prisma.$queryRawUnsafe<RawRow[]>(
      `SELECT (EXTRACT(EPOCH FROM open_time) * 1000)::bigint AS st,
              ROUND(open * 100)::bigint AS o, ROUND(high * 100)::bigint AS h,
              ROUND(low * 100)::bigint AS l, ROUND(close * 100)::bigint AS c,
              (open * 100 <> ROUND(open * 100) OR high * 100 <> ROUND(high * 100) OR low * 100 <> ROUND(low * 100) OR close * 100 <> ROUND(close * 100)) AS frac
         FROM historical_candles
        WHERE symbol = $1 AND timeframe = $2::"CandleTimeframe" AND open_time > to_timestamp($3::double precision / 1000) AT TIME ZONE 'UTC'
        ORDER BY open_time ASC
        LIMIT ${PAGE}`,
      symbol,
      timeframe,
      cursorMs,
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      const serverT = Number(r.st);
      cursorMs = serverT;
      let t: number;
      try {
        t = wallClockToUtc(SPEC.data.brokerServerTimezone, serverT);
      } catch (err) {
        if (!(err instanceof WallClockConversionError)) throw err;
        v.timezoneConversionErrors += 1;
        if (v.examples.length < 10) v.examples.push(`tz: ${err.message}`);
        continue;
      }
      if (t + dur > endUtcT) continue;
      const bar: SeriesBar = { t, serverT, dur, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) };
      v.rows += 1;
      if (r.frac) {
        v.nonCentPrices += 1;
        if (v.examples.length < 10) v.examples.push(`non-cent price at ${new Date(serverT).toISOString()} (server)`);
      }
      if (bar.h < Math.max(bar.o, bar.c) || bar.l > Math.min(bar.o, bar.c) || bar.h < bar.l) {
        v.ohlcViolations += 1;
        if (v.examples.length < 10) v.examples.push(`OHLC violation at ${new Date(serverT).toISOString()} (server)`);
      }
      const prev = bars[bars.length - 1];
      if (prev && bar.t <= prev.t) v.nonIncreasingTimestamps += 1;
      if (!gridAligned(timeframe, serverT)) v.gridMisaligned += 1;
      const dow = new Date(serverT).getUTCDay();
      if (dow === 0 || dow === 6) v.weekendServerBars += 1;
      bars.push(bar);
      hash.update(`${timeframe}|${serverT}|${bar.o}|${bar.h}|${bar.l}|${bar.c}\n`);
    }
    if (rows.length < PAGE) break;
  }
  if (bars.length) {
    v.firstServer = new Date(bars[0].serverT).toISOString().replace('Z', ' (server)');
    v.lastServer = new Date(bars[bars.length - 1].serverT).toISOString().replace('Z', ' (server)');
    v.firstUtc = new Date(bars[0].t).toISOString();
    v.lastUtc = new Date(bars[bars.length - 1].t).toISOString();
  }
  return { bars, validation: v };
}

export async function latestCompletedM1CloseUtc(prisma: PrismaClient, symbol: string): Promise<number | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ st: bigint | null }>>(
    `SELECT (EXTRACT(EPOCH FROM MAX(open_time)) * 1000)::bigint AS st FROM historical_candles WHERE symbol = $1 AND timeframe = 'M1'::"CandleTimeframe"`,
    symbol,
  );
  const st = rows[0]?.st;
  return st === null || st === undefined ? null : wallClockToUtc(SPEC.data.brokerServerTimezone, Number(st)) + DURATION_MS.M1;
}

export interface ProvenanceReport {
  database: string;
  symbolMetadata: Record<string, unknown> | null;
  candleRowServerColumn: Array<{ timeframe: string; rows: number; rowsWithServer: number; servers: string | null }>;
  ledger: Array<{ dataType: string; timeframe: string; status: string; intervals: number; rangeStart: string; rangeEnd: string }>;
  storedTicks: number;
  liveTicks: number;
  accountSnapshots: number;
  backfillLogInstrumentVerification: string;
}

export async function loadProvenance(prisma: PrismaClient, symbol: string): Promise<ProvenanceReport> {
  const url = process.env.DATABASE_URL ?? '';
  const database = url.replace(/\/\/[^@]*@/, '//***@');
  const metadata = await prisma.symbolMetadata.findUnique({ where: { symbol } });
  const perTf = await prisma.$queryRawUnsafe<Array<{ timeframe: string; rows: bigint; with_server: bigint; servers: string | null }>>(
    `SELECT timeframe::text AS timeframe, COUNT(*)::bigint AS rows, COUNT(server)::bigint AS with_server, STRING_AGG(DISTINCT server, ',') AS servers
       FROM historical_candles WHERE symbol = $1 GROUP BY timeframe ORDER BY timeframe`,
    symbol,
  );
  const ledger = await prisma.$queryRawUnsafe<Array<{ data_type: string; timeframe_key: string; status: string; n: bigint; rs: Date; re: Date }>>(
    `SELECT data_type::text, timeframe_key, status::text, COUNT(*)::bigint AS n, MIN(range_start) AS rs, MAX(range_end) AS re
       FROM backfill_intervals WHERE symbol = $1 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
    symbol,
  );
  const [storedTicks, liveTicks, accountSnapshots] = await Promise.all([
    prisma.historicalTick.count({ where: { symbol } }),
    prisma.liveTick.count({ where: { symbol } }),
    prisma.accountSnapshot.count(),
  ]);
  return {
    database,
    symbolMetadata: metadata ? JSON.parse(JSON.stringify(metadata)) : null,
    candleRowServerColumn: perTf.map((r) => ({ timeframe: r.timeframe, rows: Number(r.rows), rowsWithServer: Number(r.with_server), servers: r.servers })),
    ledger: ledger.map((r) => ({
      dataType: r.data_type,
      timeframe: r.timeframe_key,
      status: r.status,
      intervals: Number(r.n),
      rangeStart: r.rs.toISOString(),
      rangeEnd: r.re.toISOString(),
    })),
    storedTicks,
    liveTicks,
    accountSnapshots,
    backfillLogInstrumentVerification:
      'collector/logs/gold_backfill_run5.log (2026-09-13T10:08:23Z): login 5055783885, server MetaQuotes-Demo, account_trade_mode 0 (DEMO), ' +
      'symbol XAUUSD path Metals\\XAUUSD "Gold vs US Dollar", currency_base XAU, currency_profit USD, no real expiration. ' +
      'Per-row candle provenance columns (server/broker_symbol) are NULL for every stored row, so provenance rests on this log and symbol_metadata.',
  };
}
