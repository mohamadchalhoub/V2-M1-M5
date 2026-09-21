// Account isolation, exercised directly against AnalyticsService (no HTTP
// layer exists for this module — see ANALYTICS_SPEC.md §0). Two accounts are
// seeded with deliberately overlapping-looking data (same symbol, same
// externalTradeId/positionId values, same timestamps) so that any query
// missing an accountId filter would leak data between them.
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';
import { analyticsServiceFor } from './helpers';

describe('analytics account isolation', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it("account A's trades, positions, and snapshots never appear in account B's metrics", async () => {
    const user = await createUser(prisma);
    const acctA = await createTradingAccount(prisma, user.id);
    const acctB = await createTradingAccount(prisma, user.id);

    const now = new Date('2026-08-01T12:00:00Z');

    // Deliberately identical natural-key-looking values on both accounts —
    // the trades table's real uniqueness is (accountId, platform,
    // externalTradeId), so reusing "T1"/"POS1" on both accounts is exactly
    // the collision a missing accountId filter would fail to notice.
    for (const [accountId, profit] of [
      [acctA.id, 500],
      [acctB.id, -500],
    ] as const) {
      await prisma.accountSnapshot.create({
        data: { accountId, balance: 1000 + profit, equity: 1000 + profit, margin: 0, freeMargin: 1000, profit: 0, capturedAt: now },
      });
      await prisma.trade.create({
        data: {
          accountId, platform: 'MT5', externalTradeId: 'T1', positionId: 'POS1',
          symbol: 'EURUSD', side: 'BUY', dealEntry: 'IN', volume: 0.10, price: 1.1,
          commission: 0, swap: 0, profit: 0, executedAt: new Date('2026-08-01T08:00:00Z'),
        },
      });
      await prisma.trade.create({
        data: {
          accountId, platform: 'MT5', externalTradeId: 'T2', positionId: 'POS1',
          symbol: 'EURUSD', side: 'BUY', dealEntry: 'OUT', volume: 0.10, price: 1.1,
          commission: 0, swap: 0, profit, executedAt: new Date('2026-08-01T08:05:00Z'),
        },
      });
      await prisma.position.create({
        data: {
          accountId, platform: 'MT5', externalPositionId: 'P-OPEN', symbol: 'GBPUSD',
          side: 'BUY', volume: 0.75, openPrice: 1.25, profit: 0, swap: 0, status: 'OPEN',
          openedAt: now,
        },
      });
    }

    const service = analyticsServiceFor(prisma);
    const [metricsA, metricsB] = await Promise.all([
      service.getCurrentMetrics(acctA.id, now),
      service.getCurrentMetrics(acctB.id, now),
    ]);

    expect(metricsA.activity.totalRealizedPl).toBe(500);
    expect(metricsB.activity.totalRealizedPl).toBe(-500);
    expect(metricsA.account.currentBalance).toBe(1500);
    expect(metricsB.account.currentBalance).toBe(500);
    expect(metricsA.position.currentOpenPositions).toBe(1);
    expect(metricsB.position.currentOpenPositions).toBe(1);

    const [baselinesA, baselinesB] = await Promise.all([
      service.getHistoricalBaselines(acctA.id, { now: new Date('2026-08-02T12:00:00Z') }),
      service.getHistoricalBaselines(acctB.id, { now: new Date('2026-08-02T12:00:00Z') }),
    ]);
    expect(baselinesA.averageWinningTrade).toBe(500);
    expect(baselinesA.averageLosingTrade).toBeNull();
    expect(baselinesB.averageWinningTrade).toBeNull();
    expect(baselinesB.averageLosingTrade).toBe(-500);
  });

  it('a nonexistent accountId rejects rather than silently returning empty/zero metrics', async () => {
    const service = analyticsServiceFor(prisma);
    await expect(service.getCurrentMetrics('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  });
});
