import { Injectable, Logger } from '@nestjs/common';
import { Platform, Prisma, Side, DealEntry } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SnapshotDto, IncomingPositionDto, LiveTickDto } from '../collector-ingress/dto/snapshot.dto';
import { IncomingDealDto } from '../collector-ingress/dto/trades.dto';

@Injectable()
export class TradingDataService {
  private readonly logger = new Logger(TradingDataService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Idempotency key: (accountId, capturedAt) — replaying the same tick is
  // a pure overwrite, never a second row (Revision 1 §06).
  async upsertSnapshot(accountId: string, dto: SnapshotDto) {
    return this.prisma.accountSnapshot.upsert({
      where: { accountId_capturedAt: { accountId, capturedAt: new Date(dto.capturedAt) } },
      create: {
        accountId,
        balance: dto.balance,
        equity: dto.equity,
        margin: dto.margin,
        freeMargin: dto.freeMargin,
        marginLevel: dto.marginLevel ?? null,
        profit: dto.profit,
        tradeMode: dto.tradeMode ?? null,
        marginMode: dto.marginMode ?? null,
        capturedAt: new Date(dto.capturedAt),
      },
      update: {
        balance: dto.balance,
        equity: dto.equity,
        margin: dto.margin,
        freeMargin: dto.freeMargin,
        marginLevel: dto.marginLevel ?? null,
        profit: dto.profit,
        tradeMode: dto.tradeMode ?? null,
        marginMode: dto.marginMode ?? null,
      },
    });
  }

  // Idempotency key: symbol (single row, always overwritten) — same
  // "one shared row, upsert every push" posture as upsertHeartbeat.
  async upsertLiveTick(dto: LiveTickDto) {
    return this.prisma.liveTick.upsert({
      where: { symbol: dto.symbol },
      create: { symbol: dto.symbol, bid: dto.bid, ask: dto.ask, tickAt: new Date(dto.tickAt) },
      update: { bid: dto.bid, ask: dto.ask, tickAt: new Date(dto.tickAt) },
    });
  }

  // Full-replace semantics (Revision 1 §05): positions_get() is
  // authoritative for "what's open right now" on every poll. Anything
  // upserted here that ISN'T in the incoming list gets marked CLOSED —
  // atomically, in one transaction, so a crash mid-write can't leave a
  // position stuck in a wrong state.
  async replaceOpenPositions(
    accountId: string,
    platform: Platform,
    positions: IncomingPositionDto[],
  ) {
    const incomingIds = positions.map((p) => p.externalPositionId);

    await this.prisma.$transaction(async (tx) => {
      for (const p of positions) {
        await tx.position.upsert({
          where: {
            accountId_platform_externalPositionId: {
              accountId,
              platform,
              externalPositionId: p.externalPositionId,
            },
          },
          create: {
            accountId,
            platform,
            externalPositionId: p.externalPositionId,
            symbol: p.symbol,
            side: p.side as Side,
            volume: p.volume,
            openPrice: p.openPrice,
            currentPrice: p.currentPrice ?? null,
            stopLoss: p.stopLoss ?? null,
            takeProfit: p.takeProfit ?? null,
            profit: p.profit,
            swap: p.swap,
            status: 'OPEN',
            openedAt: new Date(p.openedAt),
            rawPayload: (p.raw ?? null) as Prisma.InputJsonValue,
          },
          update: {
            currentPrice: p.currentPrice ?? null,
            stopLoss: p.stopLoss ?? null,
            takeProfit: p.takeProfit ?? null,
            profit: p.profit,
            swap: p.swap,
            status: 'OPEN',
            rawPayload: (p.raw ?? null) as Prisma.InputJsonValue,
          },
        });
      }

      const closedResult = await tx.position.updateMany({
        where: {
          accountId,
          platform,
          status: 'OPEN',
          externalPositionId: { notIn: incomingIds.length > 0 ? incomingIds : [''] },
        },
        data: { status: 'CLOSED' },
      });

      if (closedResult.count > 0) {
        this.logger.log(
          `Marked ${closedResult.count} position(s) CLOSED for account ${accountId} (no longer reported open)`,
        );
      }
    });
  }

  // Idempotency key: account_id (single row) — always an upsert (Revision 1 §14).
  async upsertHeartbeat(
    accountId: string,
    mt5Connected: boolean,
    lastError: string | null,
    collectorVersion: string | null,
  ) {
    return this.prisma.collectorHeartbeat.upsert({
      where: { accountId },
      create: {
        accountId,
        lastHeartbeatAt: new Date(),
        mt5Connected,
        lastError,
        collectorVersion,
      },
      update: {
        lastHeartbeatAt: new Date(),
        mt5Connected,
        lastError,
        collectorVersion,
      },
    });
  }

  // Idempotency key: (accountId, platform, externalTradeId) — the MT5 deal
  // ticket. Re-sending an overlapping time window is always a safe no-op.
  async upsertDeals(accountId: string, platform: Platform, deals: IncomingDealDto[]) {
    let created = 0;
    let updated = 0;

    for (const d of deals) {
      const existing = await this.prisma.trade.findUnique({
        where: {
          accountId_platform_externalTradeId: {
            accountId,
            platform,
            externalTradeId: d.externalTradeId,
          },
        },
        select: { id: true },
      });

      await this.prisma.trade.upsert({
        where: {
          accountId_platform_externalTradeId: {
            accountId,
            platform,
            externalTradeId: d.externalTradeId,
          },
        },
        create: {
          accountId,
          platform,
          externalTradeId: d.externalTradeId,
          positionId: d.positionId ?? null,
          orderId: d.orderId ?? null,
          symbol: d.symbol,
          side: d.side as Side,
          dealEntry: d.dealEntry as DealEntry,
          volume: d.volume,
          price: d.price,
          commission: d.commission,
          swap: d.swap,
          profit: d.profit,
          executedAt: new Date(d.executedAt),
          comment: d.comment ?? null,
          rawPayload: (d.raw ?? null) as Prisma.InputJsonValue,
        },
        update: {
          // Deals are immutable once executed; an update here only ever
          // happens if the same ticket is re-sent with identical data.
          profit: d.profit,
          commission: d.commission,
          swap: d.swap,
        },
      });

      if (existing) updated += 1;
      else created += 1;
    }

    return { created, updated };
  }

  async getHeartbeat(accountId: string) {
    return this.prisma.collectorHeartbeat.findUnique({ where: { accountId } });
  }

  async getSyncCursor(accountId: string) {
    return this.prisma.syncCursor.findUnique({ where: { accountId } });
  }

  async updateSyncCursor(accountId: string, lastSyncedAt: Date, lastDealTicket: string | null) {
    return this.prisma.syncCursor.upsert({
      where: { accountId },
      create: { accountId, lastSyncedAt, lastDealTicket },
      update: { lastSyncedAt, lastDealTicket },
    });
  }
}
