import { Injectable, Logger } from '@nestjs/common';
import { BackfillDataType, BackfillInterval, BackfillIntervalStatus, CandleTimeframe } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface UpsertBackfillIntervalInput {
  source?: string;
  symbol: string;
  brokerSymbol?: string | null;
  server?: string | null;
  dataType: BackfillDataType;
  timeframe?: CandleTimeframe | null;
  rangeStart: Date;
  rangeEnd: Date;
  status: BackfillIntervalStatus;
  recordCount?: number | null;
  evidence?: string | null;
}

// completedAt is server-decided from `status` alone — never from a
// caller-supplied value — so this set is the single source of truth for
// "what counts as done" (schema.prisma's own status descriptions: COMPLETED
// and EMPTY_CONFIRMED are the only two terminal, successful outcomes).
const COMPLETION_STATUSES: ReadonlySet<BackfillIntervalStatus> = new Set<BackfillIntervalStatus>([
  BackfillIntervalStatus.COMPLETED,
  BackfillIntervalStatus.EMPTY_CONFIRMED,
]);

/**
 * Gold historical-collection phase — the coverage/checkpoint ledger
 * (schema.prisma's BackfillInterval). Unlike HistoricalCandleService/
 * HistoricalTickService, this is a plain `prisma.backfillInterval.upsert()`
 * (not raw SQL): `timeframeKey` is a NOT NULL companion column specifically
 * so this table's uniqueness constraint is an ordinary Prisma-native
 * `@@unique`, with no nullable-column-expression-index problem to work
 * around (see the model's own schema comment).
 */
@Injectable()
export class BackfillIntervalService {
  private readonly logger = new Logger(BackfillIntervalService.name);

  constructor(private readonly prisma: PrismaService) {}

  async upsertInterval(input: UpsertBackfillIntervalInput): Promise<BackfillInterval> {
    const source = input.source ?? 'MT5';
    // The literal "_TICK_" companion value for TICK rows — see this
    // model's own schema comment for exactly why this exact literal exists.
    const timeframeKey = input.timeframe ?? '_TICK_';
    // Server-decided, never caller-supplied — set on every upsert (not just
    // creation) so a re-upsert that moves OFF a completion status (e.g. a
    // re-check that demotes COMPLETED back to INCOMPLETE) correctly clears
    // a stale completedAt rather than leaving one behind.
    const completedAt = COMPLETION_STATUSES.has(input.status) ? new Date() : null;

    const data = {
      source,
      symbol: input.symbol,
      brokerSymbol: input.brokerSymbol ?? null,
      server: input.server ?? null,
      dataType: input.dataType,
      timeframe: input.timeframe ?? null,
      timeframeKey,
      rangeStart: input.rangeStart,
      rangeEnd: input.rangeEnd,
      status: input.status,
      recordCount: input.recordCount ?? null,
      evidence: input.evidence ?? null,
      completedAt,
    };

    const row = await this.prisma.backfillInterval.upsert({
      where: {
        source_symbol_dataType_timeframeKey_rangeStart_rangeEnd: {
          source,
          symbol: input.symbol,
          dataType: input.dataType,
          timeframeKey,
          rangeStart: input.rangeStart,
          rangeEnd: input.rangeEnd,
        },
      },
      create: data,
      update: data,
    });

    this.logger.log(
      `backfill interval upserted: symbol=${input.symbol} dataType=${input.dataType} timeframeKey=${timeframeKey} status=${input.status}`,
    );
    return row;
  }

  async queryIntervals(params: {
    symbol: string;
    dataType: BackfillDataType;
    timeframe?: CandleTimeframe;
    statuses?: BackfillIntervalStatus[];
  }): Promise<BackfillInterval[]> {
    return this.prisma.backfillInterval.findMany({
      where: {
        symbol: params.symbol,
        dataType: params.dataType,
        ...(params.timeframe ? { timeframe: params.timeframe } : {}),
        ...(params.statuses && params.statuses.length > 0 ? { status: { in: params.statuses } } : {}),
      },
      orderBy: { rangeStart: 'asc' },
    });
  }
}
