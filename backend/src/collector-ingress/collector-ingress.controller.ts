import { BadRequestException, Body, Controller, Get, Logger, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { BackfillDataType, BackfillIntervalStatus, CandleTimeframe } from '@prisma/client';
import { CollectorTokenGuard } from '../auth/collector-token.guard';
import { AccountsService } from '../accounts/accounts.service';
import { RuleEngineService } from '../alerts/rule-engine.service';
import { HistoricalCandleService } from '../market-data/historical-candle.service';
import { HistoricalTickService } from '../market-data/historical-tick.service';
import { BackfillIntervalService } from '../market-data/backfill-interval.service';
import { TradingDataService } from '../trading-data/trading-data.service';
import { CandlesPushDto } from '../market-data/dto/candles-push.dto';
import { TicksPushDto } from '../market-data/dto/ticks-push.dto';
import { BackfillIntervalPushDto } from '../market-data/dto/backfill-interval-push.dto';
import { SymbolMetadataService } from '../trend-breakout/symbol-metadata.service';
import { PrismaService } from '../prisma/prisma.service';
import { SnapshotDto } from './dto/snapshot.dto';
import { SymbolMetadataPushDto } from './dto/symbol-metadata-push.dto';
import { TradesPushDto } from './dto/trades.dto';
import { GoldClosureReconciliationService } from '../gold-execution/gold-closure-reconciliation.service';
import { GoldProtectionMonitorService } from '../gold-execution/gold-protection-monitor.service';

const VALID_TIMEFRAMES = ['M1', 'M5', 'M15', 'H1', 'M30', 'H4', 'D1', 'W1', 'MN1'] as const;
type Timeframe = (typeof VALID_TIMEFRAMES)[number];

function parseTimeframe(raw: string | undefined): Timeframe {
  if (!raw || !(VALID_TIMEFRAMES as readonly string[]).includes(raw)) {
    throw new BadRequestException(`timeframe must be one of ${VALID_TIMEFRAMES.join(', ')}`);
  }
  return raw as Timeframe;
}

const VALID_BACKFILL_DATA_TYPES = ['CANDLE', 'TICK'] as const;
const VALID_BACKFILL_STATUSES = [
  'PENDING',
  'COMPLETED',
  'EMPTY_UNCONFIRMED',
  'EMPTY_CONFIRMED',
  'FAILED',
  'INCOMPLETE',
  'SUSPECTED_TRUNCATED',
] as const;

// MT5 deal tickets are always numeric, so BigInt comparison is the correct
// way to find the highest one — but this field is a free-form string in
// the schema (XTB import rows, or any future source, may not be purely
// numeric), and lastDealTicket is diagnostic metadata, not something
// correctness depends on. A malformed/non-numeric ticket must degrade
// gracefully here, not 500 the whole ingestion request.
function higherTicket(a: string, b: string): string {
  try {
    return BigInt(a) > BigInt(b) ? a : b;
  } catch {
    return a > b ? a : b; // lexicographic fallback — never throws
  }
}

@Controller('collector')
@UseGuards(CollectorTokenGuard)
export class CollectorIngressController {
  private readonly logger = new Logger(CollectorIngressController.name);

  constructor(
    private readonly accounts: AccountsService,
    private readonly tradingData: TradingDataService,
    private readonly ruleEngine: RuleEngineService,
    private readonly historicalCandles: HistoricalCandleService,
    private readonly historicalTicks: HistoricalTickService,
    private readonly backfillIntervals: BackfillIntervalService,
    private readonly symbolMetadata: SymbolMetadataService,
    private readonly prisma: PrismaService,
    private readonly goldClosures: GoldClosureReconciliationService,
    private readonly goldProtection: GoldProtectionMonitorService,
  ) {}

  @Post('snapshot')
  async postSnapshot(@Body() dto: SnapshotDto) {
    const account = await this.accounts.getOrThrow(dto.accountId);

    await this.tradingData.upsertSnapshot(dto.accountId, dto);
    await this.tradingData.replaceOpenPositions(dto.accountId, account.platform, dto.positions);
    // Gold-only, read-only reconciliation off the same feed — never touches
    // legacy EURUSD positions (filtered by symbol inside the service).
    await this.goldProtection.checkPositions(dto.accountId, dto.positions).catch((err) =>
      this.logger.error(`gold protection check failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    const quotes = [...(dto.liveTick ? [dto.liveTick] : []), ...(dto.liveTicks ?? [])];
    for (const quote of new Map(quotes.map((q) => [q.symbol, q] as const)).values()) {
      await this.tradingData.upsertLiveTick(quote);
    }
    await this.tradingData.upsertHeartbeat(
      dto.accountId,
      dto.terminal.connected,
      dto.terminal.lastError ?? null,
      dto.collectorVersion ?? null,
    );

    this.logger.log(
      `snapshot accepted account=${dto.accountId} positions=${dto.positions.length} mt5_connected=${dto.terminal.connected}`,
    );
    await this.evaluateRulesSafely(dto.accountId);
    return { ok: true };
  }

  @Post('trades')
  async postTrades(@Body() dto: TradesPushDto) {
    const account = await this.accounts.getOrThrow(dto.accountId);

    const result = await this.tradingData.upsertDeals(dto.accountId, account.platform, dto.deals);
    // Gold-only closure/partial-close reconciliation off the same feed —
    // never touches legacy EURUSD trades (filtered by symbol inside the service).
    await this.goldClosures.reconcile(dto.accountId, account.platform, dto.deals).catch((err) =>
      this.logger.error(`gold closure reconciliation failed: ${err instanceof Error ? err.message : String(err)}`),
    );

    const maxTicket = dto.deals.reduce<string | null>((max, d) => {
      if (max === null) return d.externalTradeId;
      return higherTicket(d.externalTradeId, max);
    }, null);
    const existingCursor = await this.tradingData.getSyncCursor(dto.accountId);
    const lastDealTicket =
      maxTicket !== null
        ? existingCursor?.lastDealTicket
          ? higherTicket(maxTicket, existingCursor.lastDealTicket)
          : maxTicket
        : existingCursor?.lastDealTicket ?? null;

    await this.tradingData.updateSyncCursor(dto.accountId, new Date(), lastDealTicket);

    this.logger.log(
      `trades accepted account=${dto.accountId} received=${dto.deals.length} created=${result.created} updated=${result.updated}`,
    );
    await this.evaluateRulesSafely(dto.accountId);
    return { ok: true, ...result };
  }

  // Rule evaluation runs synchronously as part of ingestion (RULE_ENGINE_SPEC.md
  // §12.12 decision 4a) but must never be able to fail an otherwise-successful
  // ingestion request — a bug in a trader's rule configuration must not stop
  // their trading data from being recorded (the same "one component's failure
  // must never take down another" posture Phase 0 §21 applies to health
  // checks).
  private async evaluateRulesSafely(accountId: string): Promise<void> {
    try {
      await this.ruleEngine.evaluateAccount(accountId, new Date());
    } catch (err) {
      this.logger.error(
        `rule evaluation failed for account=${accountId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  @Get('cursor/:accountId')
  async getCursor(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    const cursor = await this.tradingData.getSyncCursor(accountId);
    return {
      lastSyncedAt: cursor?.lastSyncedAt ?? null,
      lastDealTicket: cursor?.lastDealTicket ?? null,
    };
  }

  @Get('heartbeat/:accountId')
  async getHeartbeat(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    return this.tradingData.getHeartbeat(accountId);
  }

  // Historical chart reconstruction phase — candles carry no accountId at
  // all (schema.prisma's HistoricalCandle: symbol/timeframe data, shared
  // across every account). CollectorTokenGuard's own contract already
  // covers this: a request naming no target accountId is accepted from any
  // valid, unrevoked collector-scope token (auth/collector-token.guard.ts's
  // `requestedAccountId` returns undefined here, so the account-match check
  // never applies) — no guard change needed for these two routes.
  @Post('candles')
  async postCandles(@Body() dto: CandlesPushDto) {
    const result = await this.historicalCandles.upsertCandles(dto.symbol, dto.timeframe, dto.candles);
    this.logger.log(`candles accepted symbol=${dto.symbol} timeframe=${dto.timeframe} count=${dto.candles.length}`);
    return { ok: true, ...result };
  }

  @Get('candles/latest')
  async getLatestCandleTime(@Query('symbol') symbol: string, @Query('timeframe') timeframeRaw: string) {
    if (!symbol) throw new BadRequestException('symbol is required');
    const timeframe = parseTimeframe(timeframeRaw);
    const latestOpenTime = await this.historicalCandles.getLatestOpenTime(symbol, timeframe);
    return { latestOpenTime };
  }

  // trend-breakout strategy (v3) — broker symbol metadata (volume min/max/
  // step, price increment, contract size, profit currency), same "no
  // accountId" posture as candles above: one symbol's metadata is shared
  // across every account/collector that trades it. Every volume/price-
  // rounding validation in the new strategy fails closed until a row
  // exists here — see SymbolMetadataService's own doc comment.
  @Post('symbol-metadata')
  async postSymbolMetadata(@Body() dto: SymbolMetadataPushDto) {
    await this.symbolMetadata.upsert(dto);
    this.logger.log(`symbol metadata accepted symbol=${dto.symbol} volumeMin=${dto.volumeMin} volumeMax=${dto.volumeMax} volumeStep=${dto.volumeStep} point=${dto.point}`);
    return { ok: true };
  }

  // Gold historical-collection phase — ticks carry no accountId, same "no
  // accountId" posture as candles/symbol-metadata above.
  @Post('ticks')
  async postTicks(@Body() dto: TicksPushDto) {
    const result = await this.historicalTicks.upsertTicks(
      dto.symbol,
      dto.brokerSymbol ?? null,
      dto.server ?? null,
      dto.feedId ?? null,
      dto.ticks,
    );
    this.logger.log(`ticks accepted symbol=${dto.symbol} received=${dto.ticks.length} inserted=${result.inserted}`);
    return { ok: true, ...result };
  }

  @Get('ticks/coverage')
  async getTicksCoverage(@Query('symbol') symbol: string) {
    if (!symbol) throw new BadRequestException('symbol is required');
    return this.historicalTicks.getCoverage(symbol);
  }

  // Gold historical-collection phase — the coverage/checkpoint ledger push.
  // No accountId, same posture as every other market-data route here.
  @Post('backfill-intervals')
  async postBackfillInterval(@Body() dto: BackfillIntervalPushDto) {
    const row = await this.backfillIntervals.upsertInterval({
      source: dto.source,
      symbol: dto.symbol,
      brokerSymbol: dto.brokerSymbol,
      server: dto.server,
      dataType: dto.dataType as BackfillDataType,
      timeframe: dto.timeframe as CandleTimeframe | undefined,
      rangeStart: new Date(dto.rangeStart),
      rangeEnd: new Date(dto.rangeEnd),
      status: dto.status as BackfillIntervalStatus,
      recordCount: dto.recordCount,
      evidence: dto.evidence,
    });
    this.logger.log(
      `backfill interval accepted symbol=${dto.symbol} dataType=${dto.dataType} status=${dto.status} range=${dto.rangeStart}..${dto.rangeEnd}`,
    );
    // BackfillInterval.id is a BigInt (Fastify's JSON serializer can't
    // handle those natively, same issue already documented in
    // trading-data.controller.ts) — stringify it, the only field affected.
    return { ...row, id: row.id.toString() };
  }

  @Get('backfill-intervals')
  async getBackfillIntervals(
    @Query('symbol') symbol: string,
    @Query('dataType') dataTypeRaw: string,
    @Query('timeframe') timeframeRaw: string | undefined,
    @Query('status') statusRaw: string | undefined,
  ) {
    if (!symbol) throw new BadRequestException('symbol is required');
    if (!dataTypeRaw || !(VALID_BACKFILL_DATA_TYPES as readonly string[]).includes(dataTypeRaw)) {
      throw new BadRequestException(`dataType must be one of ${VALID_BACKFILL_DATA_TYPES.join(', ')}`);
    }
    const timeframe = timeframeRaw ? parseTimeframe(timeframeRaw) : undefined;
    let statuses: BackfillIntervalStatus[] | undefined;
    if (statusRaw) {
      const parts = statusRaw.split(',').map((s) => s.trim());
      for (const part of parts) {
        if (!(VALID_BACKFILL_STATUSES as readonly string[]).includes(part)) {
          throw new BadRequestException(`status must be a comma-separated list of ${VALID_BACKFILL_STATUSES.join(', ')}`);
        }
      }
      statuses = parts as BackfillIntervalStatus[];
    }

    const rows = await this.backfillIntervals.queryIntervals({
      symbol,
      dataType: dataTypeRaw as BackfillDataType,
      timeframe: timeframe as CandleTimeframe | undefined,
      statuses,
    });
    // Same BigInt-id stringification as postBackfillInterval above.
    return rows.map((row) => ({ ...row, id: row.id.toString() }));
  }

  // Reliability/ops visibility — never throws over the WAL-size probe: on
  // most managed/permission-restricted Postgres setups pg_ls_waldir() isn't
  // available, and that must never fail this otherwise-cheap health check.
  @Get('storage-health')
  async getStorageHealth() {
    const [dbSizeRow] = await this.prisma.$queryRaw<{ db_size: bigint }[]>`SELECT pg_database_size(current_database()) as db_size`;
    let walSizeBytes: number | null = null;
    try {
      const [walRow] = await this.prisma.$queryRaw<{ sum: unknown | null }[]>`SELECT sum(size) as sum FROM pg_ls_waldir()`;
      walSizeBytes = walRow?.sum != null ? Number(walRow.sum) : null;
    } catch (err) {
      this.logger.warn(`storage-health: WAL size unavailable: ${err instanceof Error ? err.message : String(err)}`);
      walSizeBytes = null;
    }
    return {
      databaseSizeBytes: Number(dbSizeRow.db_size),
      walSizeBytes,
      checkedAt: new Date().toISOString(),
    };
  }
}
