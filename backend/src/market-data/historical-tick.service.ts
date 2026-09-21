import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IncomingTickDto } from './dto/ticks-push.dto';

/**
 * Gold historical-collection phase — the one place that writes/reads
 * `historical_ticks`. Mirrors HistoricalCandleService.upsertCandles's own
 * shape: dedupe the incoming batch in JS first (a Map, last-occurrence-wins),
 * then issue ONE bulk `INSERT ... ON CONFLICT DO NOTHING` — see
 * HistoricalTick's schema comment for why the real identity/dedup key is a
 * Postgres EXPRESSION unique index (`historical_ticks_identity_key`,
 * created in this table's migration) rather than a plain `@@unique`, and
 * why `batchSeq` is deliberately excluded from that identity.
 */
@Injectable()
export class HistoricalTickService {
  private readonly logger = new Logger(HistoricalTickService.name);

  constructor(private readonly prisma: PrismaService) {}

  async upsertTicks(
    symbol: string,
    brokerSymbol: string | null,
    server: string | null,
    feedId: string | null,
    ticks: IncomingTickDto[],
  ): Promise<{ inserted: number }> {
    if (ticks.length === 0) return { inserted: 0 };

    // Intra-batch dedupe, same reasoning as upsertCandles: a batch can
    // legitimately repeat the identical broker tick more than once (an
    // overlapping/repeated `copy_ticks_range` chunk). Keyed on every field
    // that participates in the real identity (the expression unique index),
    // deliberately excluding `batchSeq` — see this table's own schema
    // comment on why batchSeq is NOT part of a tick's identity.
    const byKey = new Map<string, IncomingTickDto>();
    for (const tick of ticks) {
      const key = JSON.stringify([tick.timestamp, tick.bid, tick.ask, tick.last ?? null, tick.volume ?? null, tick.volumeReal ?? null, tick.flags]);
      byKey.set(key, tick);
    }
    const deduped = [...byKey.values()];

    const rows = Prisma.join(
      deduped.map(
        (t) =>
          Prisma.sql`(${symbol}, ${brokerSymbol}, ${server}, ${feedId}, ${new Date(t.timestamp)}, ${t.bid}, ${t.ask}, ${t.last ?? null}, ${t.volume ?? null}, ${t.volumeReal ?? null}, ${t.flags}, ${t.batchSeq}, 'MT5')`,
      ),
    );

    // ON CONFLICT target must textually match the expression unique index
    // created in this table's migration (historical_ticks_identity_key) —
    // verified directly against the real dev DB (see the delivery report),
    // Postgres is strict about expression equality here.
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO "historical_ticks" (symbol, broker_symbol, server, feed_id, "timestamp", bid, ask, last, volume, volume_real, flags, batch_seq, source)
      VALUES ${rows}
      ON CONFLICT (symbol, COALESCE(broker_symbol,''), "timestamp", bid, ask, COALESCE(last,-1), COALESCE(volume,-1), COALESCE(volume_real,-1), flags)
      DO NOTHING
    `;

    this.logger.log(`ticks accepted: symbol=${symbol} received=${ticks.length} deduped=${deduped.length} inserted=${inserted}`);
    return { inserted };
  }

  async getCoverage(symbol: string): Promise<{ symbol: string; count: number; earliest: Date | null; latest: Date | null }> {
    const agg = await this.prisma.historicalTick.aggregate({
      where: { symbol },
      _count: { _all: true },
      _min: { timestamp: true },
      _max: { timestamp: true },
    });
    return {
      symbol,
      count: agg._count._all,
      earliest: agg._min.timestamp,
      latest: agg._max.timestamp,
    };
  }
}
