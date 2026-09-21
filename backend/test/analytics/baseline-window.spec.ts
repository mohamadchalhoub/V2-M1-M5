// Proves the baseline window boundary is a precise half-open interval
// [windowStart, windowEnd) — a deal exactly AT windowStart counts, one
// exactly one millisecond before it does not. Uses a small windowDays
// override (3) so the boundary can be placed at an exact, easy-to-reason-
// about instant instead of 90 days out.
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';
import { analyticsServiceFor } from './helpers';

describe('baseline window boundary', () => {
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

  it('includes a deal exactly at windowStart and excludes one 1ms before it', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    // now = 2026-09-10T12:00:00Z, windowDays=3 (UTC/resetHour0)
    //   -> windowEnd   = 2026-09-10T00:00:00.000Z
    //   -> windowStart = 2026-09-07T00:00:00.000Z
    const now = new Date('2026-09-10T12:00:00Z');

    // Anchors data far enough back that the window isn't clipped by the
    // "young account" logic (ANALYTICS_SPEC.md §3).
    await prisma.accountSnapshot.create({
      data: { accountId: account.id, balance: 1000, equity: 1000, margin: 0, freeMargin: 1000, profit: 0, capturedAt: new Date('2026-09-01T00:00:00Z') },
    });

    // Excluded: 1ms before windowStart.
    await prisma.trade.create({
      data: { accountId: account.id, platform: 'MT5', externalTradeId: 'BEFORE-IN', positionId: 'PBEFORE', symbol: 'EURUSD', side: 'BUY', dealEntry: 'IN', volume: 0.1, price: 1.1, commission: 0, swap: 0, profit: 0, executedAt: new Date('2026-09-06T23:59:00.000Z') },
    });
    await prisma.trade.create({
      data: { accountId: account.id, platform: 'MT5', externalTradeId: 'BEFORE-OUT', positionId: 'PBEFORE', symbol: 'EURUSD', side: 'BUY', dealEntry: 'OUT', volume: 0.1, price: 1.1, commission: 0, swap: 0, profit: -999, executedAt: new Date('2026-09-06T23:59:59.999Z') },
    });
    await prisma.position.create({
      data: { accountId: account.id, platform: 'MT5', externalPositionId: 'PBEFORE', symbol: 'EURUSD', side: 'BUY', volume: 0.1, openPrice: 1.1, profit: 0, swap: 0, status: 'CLOSED', openedAt: new Date('2026-09-06T23:59:00.000Z') },
    });

    // Included: exactly at windowStart.
    await prisma.trade.create({
      data: { accountId: account.id, platform: 'MT5', externalTradeId: 'AT-IN', positionId: 'PAT', symbol: 'EURUSD', side: 'BUY', dealEntry: 'IN', volume: 0.1, price: 1.1, commission: 0, swap: 0, profit: 0, executedAt: new Date('2026-09-06T23:59:00.000Z') },
    });
    await prisma.trade.create({
      data: { accountId: account.id, platform: 'MT5', externalTradeId: 'AT-OUT', positionId: 'PAT', symbol: 'EURUSD', side: 'BUY', dealEntry: 'OUT', volume: 0.1, price: 1.1, commission: 0, swap: 0, profit: 50, executedAt: new Date('2026-09-07T00:00:00.000Z') },
    });
    await prisma.position.create({
      data: { accountId: account.id, platform: 'MT5', externalPositionId: 'PAT', symbol: 'EURUSD', side: 'BUY', volume: 0.1, openPrice: 1.1, profit: 0, swap: 0, status: 'CLOSED', openedAt: new Date('2026-09-06T23:59:00.000Z') },
    });

    const service = analyticsServiceFor(prisma);
    const baselines = await service.getHistoricalBaselines(account.id, { now, windowDays: 3 });

    expect(baselines.windowStart.toISOString()).toBe('2026-09-07T00:00:00.000Z');
    expect(baselines.windowEnd.toISOString()).toBe('2026-09-10T00:00:00.000Z');
    // Only the +50 win counted -> averageWinningTrade=50, no losses at all
    // (if the -999 deal had leaked in, averageLosingTrade would be -999).
    expect(baselines.averageWinningTrade).toBe(50);
    expect(baselines.averageLosingTrade).toBeNull();
    // 1 trade / 3 complete days
    expect(baselines.averageTradesPerDay).toBe(0.33);
  });

  it('a configurable window override changes the result without touching env/config', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const now = new Date('2026-09-10T12:00:00Z');

    await prisma.accountSnapshot.create({
      data: { accountId: account.id, balance: 1000, equity: 1000, margin: 0, freeMargin: 1000, profit: 0, capturedAt: new Date('2026-08-01T00:00:00Z') },
    });
    // A trade 5 days before "now" — inside a 7-day window, outside a 3-day window.
    await prisma.trade.create({
      data: { accountId: account.id, platform: 'MT5', externalTradeId: 'X-IN', positionId: 'PX', symbol: 'EURUSD', side: 'BUY', dealEntry: 'IN', volume: 0.1, price: 1.1, commission: 0, swap: 0, profit: 0, executedAt: new Date('2026-09-05T08:00:00Z') },
    });
    await prisma.trade.create({
      data: { accountId: account.id, platform: 'MT5', externalTradeId: 'X-OUT', positionId: 'PX', symbol: 'EURUSD', side: 'BUY', dealEntry: 'OUT', volume: 0.1, price: 1.1, commission: 0, swap: 0, profit: 30, executedAt: new Date('2026-09-05T08:10:00Z') },
    });

    const service = analyticsServiceFor(prisma);
    const narrow = await service.getHistoricalBaselines(account.id, { now, windowDays: 3 });
    const wide = await service.getHistoricalBaselines(account.id, { now, windowDays: 7 });

    expect(narrow.averageWinningTrade).toBeNull();
    expect(wide.averageWinningTrade).toBe(30);
  });
});
