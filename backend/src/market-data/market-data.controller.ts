import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { BackfillInterval, CandleTimeframe } from '@prisma/client';
import { DashboardTokenGuard } from '../auth/dashboard-token.guard';
import { PrismaService } from '../prisma/prisma.service';
import { HistoricalCandleService } from './historical-candle.service';
import { HistoricalTickService } from './historical-tick.service';
import { BackfillIntervalService } from './backfill-interval.service';

const SUPPORTED_SYMBOLS = ['EURUSD', 'XAUUSD'] as const;
type SupportedSymbol = (typeof SUPPORTED_SYMBOLS)[number];

// The full CandleTimeframe enum (schema.prisma) — every timeframe this
// dashboard read endpoint accepts.
const ALL_TIMEFRAMES: readonly CandleTimeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN1'];

// Mirrors collector/app/config.py's own CANDLE_DURATION_BY_TIMEFRAME — "how
// long does one bar of this timeframe span," the single fact both the
// collector's still-forming filter and this dashboard read endpoint each
// independently need. Kept as its own TS copy (no code-sharing mechanism
// exists between the Python collector and this Node backend); if the two
// ever disagree, the collector's own map is authoritative for what MT5
// actually delivers. MN1 uses 31 days (the longest possible calendar
// month) rather than a calendar-aware duration for the exact same reason
// cited there: erring long only ever delays a just-closed 28/29/30-day
// monthly bar from being treated as "closed" by a few extra days (harmless,
// self-correcting on the next poll), while erring short risks showing a
// bar to the dashboard that hasn't actually finished forming yet.
const CANDLE_DURATION_MS: Record<CandleTimeframe, number> = {
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  M30: 30 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
  W1: 7 * 24 * 60 * 60_000,
  MN1: 31 * 24 * 60 * 60_000,
};

// A simple per-timeframe response-size guard, not a capacity-planning
// number: reject a [from, to] span that would return significantly more
// than this many candles at the requested timeframe's own duration, so an
// accidentally (or maliciously) unbounded range can never produce an
// unreasonably large response.
const MAX_CANDLES_PER_REQUEST = 20_000;

function countByStatus(intervals: Pick<BackfillInterval, 'status'>[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const interval of intervals) {
    counts[interval.status] = (counts[interval.status] ?? 0) + 1;
  }
  return counts;
}

/**
 * Dashboard read surface for gold/EURUSD historical market data — a
 * genuinely separate controller from `collector-ingress` (that one is the
 * collector's write path, `CollectorTokenGuard`-protected; this one is the
 * dashboard's read path, `DashboardTokenGuard`-protected), same split as
 * `AccountsController` vs. the collector's own account-scoped routes.
 * Neither route below has an `:accountId` in its URL — candles/coverage are
 * symbol-level market data, not account data — so `DashboardTokenGuard` has
 * nothing to compare against and only enforces "a valid, bound dashboard
 * token was presented," same as `AccountsController`'s `GET /accounts`.
 */
@Controller('market-data')
@UseGuards(DashboardTokenGuard)
export class MarketDataController {
  constructor(
    private readonly historicalCandles: HistoricalCandleService,
    private readonly historicalTicks: HistoricalTickService,
    private readonly backfillIntervals: BackfillIntervalService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('candles')
  async getCandles(
    @Query('symbol') symbol: string,
    @Query('timeframe') timeframeRaw: string,
    @Query('from') fromRaw: string,
    @Query('to') toRaw: string,
    @Query('includeForming') includeFormingRaw?: string,
  ) {
    if (!symbol || !(SUPPORTED_SYMBOLS as readonly string[]).includes(symbol)) {
      throw new BadRequestException(`symbol must be one of ${SUPPORTED_SYMBOLS.join(', ')}`);
    }
    if (!timeframeRaw || !ALL_TIMEFRAMES.includes(timeframeRaw as CandleTimeframe)) {
      throw new BadRequestException(`timeframe must be one of ${ALL_TIMEFRAMES.join(', ')}`);
    }
    const timeframe = timeframeRaw as CandleTimeframe;

    if (!fromRaw || !toRaw || Number.isNaN(Date.parse(fromRaw)) || Number.isNaN(Date.parse(toRaw))) {
      throw new BadRequestException('from and to are required ISO8601 timestamps');
    }
    const from = new Date(fromRaw);
    const to = new Date(toRaw);
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('from must be <= to');
    }

    const durationMs = CANDLE_DURATION_MS[timeframe];
    const maxSpanMs = durationMs * MAX_CANDLES_PER_REQUEST;
    if (to.getTime() - from.getTime() > maxSpanMs) {
      throw new BadRequestException(
        `requested range too large for timeframe ${timeframe}: max span is approximately ${MAX_CANDLES_PER_REQUEST} candles`,
      );
    }

    const includeForming = includeFormingRaw === 'true';
    const rows = await this.historicalCandles.getCandlesInRange(symbol, timeframe, from, to);
    const now = Date.now();
    const visible = includeForming ? rows : rows.filter((c) => c.openTime.getTime() + durationMs <= now);

    return {
      symbol,
      timeframe,
      candles: visible.map((c) => ({
        openTime: c.openTime.toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
    };
  }

  @Get('coverage')
  async getCoverage(@Query('symbol') symbol: string) {
    if (!symbol) throw new BadRequestException('symbol is required');

    const candles = await Promise.all(
      ALL_TIMEFRAMES.map(async (timeframe) => {
        const [agg, intervals] = await Promise.all([
          this.prisma.historicalCandle.aggregate({
            where: { symbol, timeframe },
            _count: { _all: true },
            _min: { openTime: true },
            _max: { openTime: true },
          }),
          this.backfillIntervals.queryIntervals({ symbol, dataType: 'CANDLE', timeframe }),
        ]);
        return {
          timeframe,
          count: agg._count._all,
          earliest: agg._min.openTime?.toISOString() ?? null,
          latest: agg._max.openTime?.toISOString() ?? null,
          intervalStatusCounts: countByStatus(intervals),
        };
      }),
    );

    const [tickCoverage, tickIntervals, symbolMetadataRow] = await Promise.all([
      this.historicalTicks.getCoverage(symbol),
      this.backfillIntervals.queryIntervals({ symbol, dataType: 'TICK' }),
      this.prisma.symbolMetadata.findUnique({ where: { symbol } }),
    ]);

    return {
      symbol,
      candles,
      ticks: {
        count: tickCoverage.count,
        earliest: tickCoverage.earliest?.toISOString() ?? null,
        latest: tickCoverage.latest?.toISOString() ?? null,
        intervalStatusCounts: countByStatus(tickIntervals),
      },
      symbolMetadata: {
        present: symbolMetadataRow !== null,
        updatedAt: symbolMetadataRow?.updatedAt.toISOString() ?? null,
      },
    };
  }
}
