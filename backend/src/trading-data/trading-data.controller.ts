import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AccountsService } from '../accounts/accounts.service';
import { DashboardTokenGuard } from '../auth/dashboard-token.guard';
import { parsePagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { attributeDeal } from './engine-attribution';

// Read-only, for the dashboard (Phase 9). Every route validates the account
// exists first (getOrThrow → 404) rather than silently returning an empty
// list for a typo'd or foreign accountId. Dashboard-authenticated and
// account-bound (production-readiness review — Option B).
@Controller('accounts/:accountId')
@UseGuards(DashboardTokenGuard)
export class TradingDataController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('snapshots/latest')
  async latestSnapshot(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    const snapshot = await this.prisma.accountSnapshot.findFirst({
      where: { accountId },
      orderBy: { capturedAt: 'desc' },
    });
    // AccountSnapshot.id is a BigInt (Fastify's JSON serializer can't
    // handle those natively) — stringify it, the only field affected.
    return snapshot ? { ...snapshot, id: snapshot.id.toString() } : null;
  }

  @Get('positions')
  async openPositions(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    return this.prisma.position.findMany({
      where: { accountId, status: 'OPEN' },
      orderBy: { openedAt: 'desc' },
    });
  }

  @Get('trades')
  async trades(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    await this.accounts.getOrThrow(accountId);
    const { take, skip } = parsePagination(limit, offset);
    const [trades, total] = await Promise.all([
      this.prisma.trade.findMany({
        where: { accountId },
        orderBy: { executedAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.trade.count({ where: { accountId } }),
    ]);

    // Engine and timeframe per row, from the magic of the deal that OPENED
    // each position (a closing deal can carry magic 0).
    const positionIds = [...new Set(trades.map((t) => t.positionId).filter((p): p is string => p !== null))];
    const openings = positionIds.length
      ? await this.prisma.trade.findMany({
          where: { accountId, positionId: { in: positionIds }, dealEntry: 'IN' },
          select: { positionId: true, rawPayload: true },
        })
      : [];
    const openingByPosition = new Map(openings.map((o) => [o.positionId, o.rawPayload]));

    const withAttribution = trades.map(({ rawPayload, ...t }) => {
      const a = attributeDeal(rawPayload, t.positionId ? openingByPosition.get(t.positionId) : null);
      return { ...t, engine: a.engine, timeframe: a.timeframe };
    });
    return { trades: withAttribution, total, limit: take, offset: skip };
  }
}
