/**
 * Gold historical-collection project — the coverage/integrity EVIDENCE
 * script (not a claim on top of it: the user's own instruction was "do not
 * claim 'all prices collected' merely because candles were downloaded...
 * show a final coverage table"). Read-only Prisma, same posture as the
 * already-reviewed `backtest-trend-breakout.ts` — no writes, no MT5, no
 * network calls.
 *
 * What "COMPLETED" does and does not prove: a BackfillInterval row marked
 * COMPLETED proves only that MT5's response to that specific chunk request
 * was successfully ingested — never that MT5's response was itself
 * complete/untruncated. This script therefore reports
 * EMPTY_UNCONFIRMED/SUSPECTED_TRUNCATED counts as their OWN line, never
 * folded into "completed," and separately runs its own gap scan over the
 * actually-stored rows (which can catch a truncation/gap the ledger itself
 * didn't detect at ingest time).
 *
 * Gap-scan heuristics, stated plainly (not a full trading-holiday
 * calendar — see the module docstring in backfill_gold_history.py for the
 * same disclosed-heuristic posture): a candle-to-candle gap larger than
 * that timeframe's own bar duration is flagged UNLESS it falls entirely
 * within an ordinary weekend (Fri ~21:00 UTC to Sun ~21:00 UTC is treated
 * loosely as "the weekend" — a gap that starts and ends within a widened
 * Thu 21:00 UTC .. Mon 03:00 UTC window is not flagged; anything wider is,
 * even if it partially overlaps a weekend). W1/MN1 use REAL calendar
 * week/month arithmetic for their "expected next open time" — NOT the
 * live-loop's CANDLE_DURATION_BY_TIMEFRAME 31-day MN1 approximation, which
 * exists for a different purpose (see historical-candle service / gold
 * collection plan for why that constant must not be reused for gap
 * detection). Tick gaps use a separate, coarser threshold (no fixed
 * cadence assumption) since ticks arrive irregularly by nature.
 *
 * Run: npm run report-xauusd-coverage [-- SYMBOL]  (defaults to XAUUSD)
 */
import 'dotenv/config';
import { PrismaClient, CandleTimeframe, BackfillIntervalStatus } from '@prisma/client';

const ALL_TIMEFRAMES: CandleTimeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN1'];

// Nominal bar duration in ms — used ONLY for the gap-scan's "how big a gap
// is suspicious" threshold on M1..D1. W1/MN1 use real calendar arithmetic
// instead (computeExpectedNext below), never this map, for exactly the
// reason explained in the module docstring above.
const FIXED_DURATION_MS: Partial<Record<CandleTimeframe, number>> = {
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  M30: 30 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
};

const REQUESTED_START_BEIRUT = '2024-03-01T00:00:00 Asia/Beirut';
// Same conversion this project's Python side does with zoneinfo — done
// once here with a fixed, pre-computed UTC instant so this script has no
// runtime timezone-library dependency of its own: 2024-03-01 00:00:00
// Beirut is EET (UTC+2) in 2024 (Lebanon's DST that year starts later in
// March) => 2024-02-29T22:00:00Z. Verified against the same IANA tzdata
// the collector's own zoneinfo-based conversion uses.
const REQUESTED_START_UTC = new Date('2024-02-29T22:00:00.000Z');

interface Gap {
  fromIso: string;
  toIso: string;
  spanHours: number;
}

function fmtDate(d: Date | null): string {
  return d ? d.toISOString() : 'n/a';
}

function isWeekendGap(from: Date, to: Date): boolean {
  // Widened window: Thu 21:00 UTC .. Mon 03:00 UTC — loose on purpose
  // (disclosed heuristic, not a market-calendar model); a gap fully
  // contained in this window across a single weekend is not flagged.
  const day = (d: Date) => d.getUTCDay(); // 0=Sun..6=Sat
  const hour = (d: Date) => d.getUTCHours();
  const afterThu21 = (d: Date) => (day(d) === 4 && hour(d) >= 21) || day(d) === 5 || day(d) === 6 || (day(d) === 0);
  const beforeMon03 = (d: Date) => day(d) === 1 && hour(d) < 3;
  return afterThu21(from) && (beforeMon03(to) || day(to) === 0 || (day(to) === 1 && hour(to) < 3));
}

function nextExpectedCandleOpen(timeframe: CandleTimeframe, openTime: Date): Date {
  if (timeframe === 'W1') {
    const next = new Date(openTime);
    next.setUTCDate(next.getUTCDate() + 7);
    return next;
  }
  if (timeframe === 'MN1') {
    // Real calendar month arithmetic — Date's setUTCMonth correctly rolls
    // December -> January of the next year.
    const next = new Date(Date.UTC(openTime.getUTCFullYear(), openTime.getUTCMonth() + 1, openTime.getUTCDate()));
    return next;
  }
  const ms = FIXED_DURATION_MS[timeframe];
  if (ms === undefined) throw new Error(`no fixed duration for ${timeframe}`);
  return new Date(openTime.getTime() + ms);
}

function scanCandleGaps(timeframe: CandleTimeframe, openTimes: Date[]): Gap[] {
  const gaps: Gap[] = [];
  for (let i = 0; i < openTimes.length - 1; i++) {
    const expectedNext = nextExpectedCandleOpen(timeframe, openTimes[i]);
    const actualNext = openTimes[i + 1];
    if (actualNext.getTime() <= expectedNext.getTime()) continue; // on schedule or early (never happens, but <=  is the safe direction)
    if (timeframe !== 'W1' && timeframe !== 'MN1' && isWeekendGap(openTimes[i], actualNext)) continue;
    const spanHours = (actualNext.getTime() - openTimes[i].getTime()) / 3_600_000;
    gaps.push({ fromIso: openTimes[i].toISOString(), toIso: actualNext.toISOString(), spanHours: Math.round(spanHours * 10) / 10 });
  }
  return gaps;
}

// Ticks: no fixed cadence — flag only genuinely large silences (>2h on a
// weekday, >48h regardless) rather than applying any per-candle duration.
function scanTickGaps(timestamps: Date[]): Gap[] {
  const gaps: Gap[] = [];
  for (let i = 0; i < timestamps.length - 1; i++) {
    const spanMs = timestamps[i + 1].getTime() - timestamps[i].getTime();
    const spanHours = spanMs / 3_600_000;
    if (spanHours < 2) continue;
    if (spanHours < 48 && isWeekendGap(timestamps[i], timestamps[i + 1])) continue;
    gaps.push({ fromIso: timestamps[i].toISOString(), toIso: timestamps[i + 1].toISOString(), spanHours: Math.round(spanHours * 10) / 10 });
  }
  return gaps;
}

async function main(): Promise<void> {
  const symbol = process.argv[2] ?? 'XAUUSD';
  const prisma = new PrismaClient();
  try {
    console.log(`\n=== Coverage report: ${symbol} ===`);
    console.log(`Requested start: ${REQUESTED_START_BEIRUT} (${REQUESTED_START_UTC.toISOString()} UTC)`);
    console.log(`Report generated: ${new Date().toISOString()} UTC (this is the frozen "actual latest" boundary for THIS report — re-running later produces a new, separately-timestamped result, never silently merged with this one)\n`);

    const rows: string[][] = [];
    const header = ['Data type/timeframe', 'Requested start', 'Actual earliest', 'Actual latest', 'Record count', 'Missing intervals / limitations', 'Broker-native or derived'];

    for (const timeframe of ALL_TIMEFRAMES) {
      const [count, earliest, latest, statusCounts] = await Promise.all([
        prisma.historicalCandle.count({ where: { symbol, timeframe } }),
        prisma.historicalCandle.findFirst({ where: { symbol, timeframe }, orderBy: { openTime: 'asc' }, select: { openTime: true } }),
        prisma.historicalCandle.findFirst({ where: { symbol, timeframe }, orderBy: { openTime: 'desc' }, select: { openTime: true } }),
        prisma.backfillInterval.groupBy({
          by: ['status'],
          where: { symbol, dataType: 'CANDLE', timeframe },
          _count: { _all: true },
        }),
      ]);

      const statusSummary = statusCounts.map((s) => `${s.status}=${s._count._all}`).join(', ') || 'no ledger rows';
      const nonCompleted = statusCounts.filter(
        (s) => s.status !== BackfillIntervalStatus.COMPLETED,
      );
      // No ledger rows at all is NOT the same claim as "all COMPLETED" — an
      // empty set vacuously satisfies "every row is COMPLETED," which would
      // misreport "nothing has ever been attempted" as "fully done."
      const suspicious = statusCounts.length === 0
        ? 'ledger: no backfill attempts recorded yet'
        : nonCompleted.length > 0
          ? `ledger: ${nonCompleted.map((s) => `${s.status}=${s._count._all}`).join(', ')}`
          : 'ledger: all COMPLETED';

      let gapNote = 'no rows to scan';
      if (count >= 2) {
        const openTimes = (
          await prisma.historicalCandle.findMany({ where: { symbol, timeframe }, orderBy: { openTime: 'asc' }, select: { openTime: true } })
        ).map((r) => r.openTime);
        const gaps = scanCandleGaps(timeframe, openTimes);
        gapNote = gaps.length === 0
          ? 'no unexplained gaps found (weekend closures excluded — see script header for the exact heuristic)'
          : `${gaps.length} unexplained gap(s), e.g. ${gaps[0].fromIso} -> ${gaps[0].toIso} (${gaps[0].spanHours}h)`;
      }

      rows.push([
        `CANDLE ${timeframe}`,
        REQUESTED_START_UTC.toISOString(),
        fmtDate(earliest?.openTime ?? null),
        fmtDate(latest?.openTime ?? null),
        String(count),
        `${gapNote}; ${suspicious}`,
        'Broker-native (MT5 copy_rates_range)',
      ]);
      console.log(`CANDLE ${timeframe}: count=${count} statuses={${statusSummary}}`);
    }

    // Ticks
    const [tickCount, tickEarliest, tickLatest, tickStatusCounts] = await Promise.all([
      prisma.historicalTick.count({ where: { symbol } }),
      prisma.historicalTick.findFirst({ where: { symbol }, orderBy: { timestamp: 'asc' }, select: { timestamp: true } }),
      prisma.historicalTick.findFirst({ where: { symbol }, orderBy: { timestamp: 'desc' }, select: { timestamp: true } }),
      prisma.backfillInterval.groupBy({ by: ['status'], where: { symbol, dataType: 'TICK' }, _count: { _all: true } }),
    ]);
    const tickStatusSummary = tickStatusCounts.map((s) => `${s.status}=${s._count._all}`).join(', ') || 'no ledger rows';
    let tickGapNote = 'no rows to scan';
    if (tickCount >= 2) {
      // Bounded sample for the gap scan on a potentially huge tick table —
      // never load millions of rows into Node just to report gaps. A
      // representative cap, disclosed here rather than silently limiting.
      const TICK_GAP_SCAN_SAMPLE_CAP = 2_000_000;
      const sample = await prisma.historicalTick.findMany({
        where: { symbol },
        orderBy: { timestamp: 'asc' },
        select: { timestamp: true },
        take: TICK_GAP_SCAN_SAMPLE_CAP,
      });
      const gaps = scanTickGaps(sample.map((r) => r.timestamp));
      const capped = sample.length >= TICK_GAP_SCAN_SAMPLE_CAP;
      tickGapNote = (gaps.length === 0
        ? 'no unexplained gaps found in the scanned sample'
        : `${gaps.length} unexplained gap(s), e.g. ${gaps[0].fromIso} -> ${gaps[0].toIso} (${gaps[0].spanHours}h)`)
        + (capped ? ` [gap scan capped at the first ${TICK_GAP_SCAN_SAMPLE_CAP.toLocaleString()} ticks — does not cover the full table]` : '');
    }
    const tickNonCompleted = tickStatusCounts.filter((s) => s.status !== BackfillIntervalStatus.COMPLETED);
    const tickSuspicious = tickStatusCounts.length === 0
      ? 'ledger: no backfill attempts recorded yet'
      : tickNonCompleted.length > 0
        ? `ledger: ${tickNonCompleted.map((s) => `${s.status}=${s._count._all}`).join(', ')}`
        : 'ledger: all COMPLETED';
    rows.push([
      'TICK',
      REQUESTED_START_UTC.toISOString(),
      fmtDate(tickEarliest?.timestamp ?? null),
      fmtDate(tickLatest?.timestamp ?? null),
      String(tickCount),
      `${tickGapNote}; ${tickSuspicious}; tick identity is field-based dedup (see HistoricalTick's schema comment) — two genuinely distinct broker events identical in every stored field would be undercounted here, disclosed not hidden`,
      'Broker-native (MT5 copy_ticks_range)',
    ]);
    console.log(`TICK: count=${tickCount} statuses={${tickStatusSummary}}`);

    // Symbol metadata presence
    const metadata = await prisma.symbolMetadata.findUnique({ where: { symbol } });
    console.log(`\nSymbol metadata: ${metadata ? `present, updatedAt=${metadata.updatedAt.toISOString()}, brokerSymbol=${metadata.brokerSymbol ?? 'unknown'}, path=${metadata.path ?? 'unknown'}` : 'ABSENT — no instrument verification has ever been pushed for this symbol'}`);

    console.log('\n--- Final coverage table ---');
    console.log(header.join(' | '));
    console.log(header.map(() => '---').join(' | '));
    for (const row of rows) {
      console.log(row.join(' | '));
    }

    console.log(
      '\nHonest caveats (per this project\'s own house style — do not skip these):\n' +
        '- A COMPLETED ledger status proves only that MT5\'s response to that specific chunk request was\n' +
        '  ingested — never that the response itself was complete/untruncated. SUSPECTED_TRUNCATED and\n' +
        '  EMPTY_UNCONFIRMED counts above are surfaced separately, never folded into "done."\n' +
        '- Gap detection here is a disclosed heuristic (ordinary-weekend exclusion via a widened\n' +
        "  Thu 21:00 UTC..Mon 03:00 UTC window), not a full trading-holiday calendar — a real holiday\n" +
        '  closure will still show up as a flagged "unexplained" gap above.\n' +
        '- Tick identity dedup is field-based (see HistoricalTick\'s schema comment): two genuinely\n' +
        '  distinct broker events identical in every stored field collapse into one row. Not lossless.\n' +
        '- This script never claims "all prices collected" — it reports exactly what is stored, what the\n' +
        "  ingestion ledger says about how it got there, and what its own gap scan finds. Nothing more.",
    );
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
