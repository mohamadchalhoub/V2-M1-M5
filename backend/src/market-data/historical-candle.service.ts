import { Injectable, Logger } from '@nestjs/common';
import { CandleTimeframe, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IncomingCandleDto } from './dto/candles-push.dto';

// A batch can be thousands of candles (a multi-year backfill). One
// prisma.upsert() per row (N sequential round trips) was slow enough to
// blow past the collector's own 10s request timeout on a real backfill run
// (found live, this session, importing a real trade history) — a single
// bulk INSERT ... ON CONFLICT is the actually-scalable shape for this,
// same technique any bulk-loading pipeline needs regardless of table.

export interface CandleData {
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

/**
 * Historical chart reconstruction phase — the one place that writes/reads
 * `historical_candles`. Idempotent by the schema's own
 * `@@unique([symbol, timeframe, openTime])` constraint: the collector
 * re-fetches a small overlapping window every tick (to heal whatever bar
 * was still forming on the previous tick), so upserting is required, not
 * just tolerated.
 */
@Injectable()
export class HistoricalCandleService {
  private readonly logger = new Logger(HistoricalCandleService.name);

  constructor(private readonly prisma: PrismaService) {}

  async upsertCandles(symbol: string, timeframe: CandleTimeframe, candles: IncomingCandleDto[]): Promise<{ upserted: number }> {
    if (candles.length === 0) return { upserted: 0 };

    // A batch can legitimately repeat the same (symbol, timeframe, openTime)
    // more than once (the collector's own small re-fetch overlap) — a
    // single multi-row `ON CONFLICT DO UPDATE` statement can't target the
    // same conflict key twice, so dedupe first, keeping the LAST occurrence
    // (the most recently-read value for that bar wins, same "heal" intent
    // the per-row upsert always had).
    const byKey = new Map<string, IncomingCandleDto>();
    for (const candle of candles) {
      byKey.set(candle.openTime, candle);
    }
    const deduped = [...byKey.values()];

    const rows = Prisma.join(
      deduped.map(
        (c) =>
          Prisma.sql`(${symbol}, ${timeframe}::"CandleTimeframe", ${new Date(c.openTime)}, ${c.open}, ${c.high}, ${c.low}, ${c.close}, ${c.volume ?? null}, 'MT5')`,
      ),
    );

    await this.prisma.$executeRaw`
      INSERT INTO "historical_candles" (symbol, timeframe, open_time, open, high, low, close, volume, source)
      VALUES ${rows}
      ON CONFLICT (symbol, timeframe, open_time) DO UPDATE SET
        open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        close = EXCLUDED.close,
        volume = EXCLUDED.volume
    `;

    this.logger.log(`candles upserted: symbol=${symbol} timeframe=${timeframe} count=${deduped.length}`);
    return { upserted: deduped.length };
  }

  async getLatestOpenTime(symbol: string, timeframe: CandleTimeframe): Promise<Date | null> {
    const latest = await this.prisma.historicalCandle.findFirst({
      where: { symbol, timeframe },
      orderBy: { openTime: 'desc' },
      select: { openTime: true },
    });
    return latest?.openTime ?? null;
  }

  /** Inclusive of both ends — the chart-context window and feature-extraction callers both expect this. */
  async getCandlesInRange(symbol: string, timeframe: CandleTimeframe, from: Date, to: Date): Promise<CandleData[]> {
    const rows = await this.prisma.historicalCandle.findMany({
      where: { symbol, timeframe, openTime: { gte: from, lte: to } },
      orderBy: { openTime: 'asc' },
    });
    return rows.map(toCandleData);
  }

  /**
   * Reliability pass — a genuine live bid/ask, pushed by the collector on
   * its 10s snapshot cadence (see LiveTick's own schema comment), used to
   * tighten "current price" from an M5 candle close's inherent ~10-minute
   * staleness down to seconds. `maxAgeMs` guards against exactly the
   * failure mode this exists to avoid: if the collector stops pushing
   * (down, disconnected), an old cached tick must age out and let the
   * caller fall back to the candle-derived price, never be served as if it
   * were still live.
   */
  async getLiveTick(symbol: string, now: Date, maxAgeMs = 60_000): Promise<{ bid: number; ask: number; tickAt: Date } | null> {
    const row = await this.prisma.liveTick.findUnique({ where: { symbol } });
    if (!row) return null;
    if (now.getTime() - row.tickAt.getTime() > maxAgeMs) return null;
    return { bid: row.bid.toNumber(), ask: row.ask.toNumber(), tickAt: row.tickAt };
  }
}

function toCandleData(row: {
  openTime: Date;
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  volume: Prisma.Decimal | null;
}): CandleData {
  return {
    openTime: row.openTime,
    open: row.open.toNumber(),
    high: row.high.toNumber(),
    low: row.low.toNumber(),
    close: row.close.toNumber(),
    volume: row.volume?.toNumber() ?? null,
  };
}
