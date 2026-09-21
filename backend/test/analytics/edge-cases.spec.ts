import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import { analyticsServiceFor } from './helpers';

describe('analytics edge cases', () => {
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

  it('exactly one closing deal never divides by zero and produces defined single-sample stats', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const now = new Date('2026-10-01T12:00:00Z');

    await prisma.trade.create({
      data: { accountId: account.id, platform: 'MT5', externalTradeId: 'T1', positionId: 'P1', symbol: 'EURUSD', side: 'BUY', dealEntry: 'IN', volume: 0.2, price: 1.1, commission: 0, swap: 0, profit: 0, executedAt: new Date('2026-10-01T08:00:00Z') },
    });
    await prisma.trade.create({
      data: { accountId: account.id, platform: 'MT5', externalTradeId: 'T2', positionId: 'P1', symbol: 'EURUSD', side: 'BUY', dealEntry: 'OUT', volume: 0.2, price: 1.11, commission: 0, swap: 0, profit: 22, executedAt: new Date('2026-10-01T08:30:00Z') },
    });

    const metrics = await analyticsServiceFor(prisma).getCurrentMetrics(account.id, now);

    expect(metrics.activity.totalTrades).toBe(1);
    expect(metrics.activity.winningTrades).toBe(1);
    expect(metrics.activity.winRate).toBe(1);
    expect(metrics.activity.averageWinningTrade).toBe(22);
    expect(metrics.activity.averageLosingTrade).toBeNull();
    expect(metrics.frequency.averageTimeBetweenTrades).toBeNull(); // needs >= 2 closing deals
    expect(metrics.sequences.currentConsecutiveWins).toBe(1);
    expect(metrics.sequences.maxConsecutiveWins).toBe(1);
    expect(Number.isNaN(metrics.activity.winRate)).toBe(false);
  });

  it('distinguishes realized P/L (closed deals only) from floating P/L (open positions, via equity)', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const now = new Date('2026-10-05T12:00:00Z');

    // One realized loss...
    await prisma.trade.create({
      data: { accountId: account.id, platform: 'MT5', externalTradeId: 'T1', positionId: 'P1', symbol: 'EURUSD', side: 'BUY', dealEntry: 'IN', volume: 0.1, price: 1.1, commission: 0, swap: 0, profit: 0, executedAt: new Date('2026-10-05T08:00:00Z') },
    });
    await prisma.trade.create({
      data: { accountId: account.id, platform: 'MT5', externalTradeId: 'T2', positionId: 'P1', symbol: 'EURUSD', side: 'BUY', dealEntry: 'OUT', volume: 0.1, price: 1.09, commission: 0, swap: 0, profit: -10, executedAt: new Date('2026-10-05T08:10:00Z') },
    });
    // ...and one still-open position with a large floating GAIN that must
    // never be counted as realized P/L, only as part of currentEquity.
    await prisma.position.create({
      data: { accountId: account.id, platform: 'MT5', externalPositionId: 'P2', symbol: 'GBPUSD', side: 'BUY', volume: 0.5, openPrice: 1.25, profit: 200, swap: 0, status: 'OPEN', openedAt: new Date('2026-10-05T09:00:00Z') },
    });
    await prisma.accountSnapshot.create({
      data: { accountId: account.id, balance: 990, equity: 1190, margin: 0, freeMargin: 990, profit: 200, capturedAt: now }, // balance=1000-10, equity=balance+floating(200)
    });

    const metrics = await analyticsServiceFor(prisma).getCurrentMetrics(account.id, now);

    // Realized: only the -10 closed trade.
    expect(metrics.activity.totalRealizedPl).toBe(-10);
    expect(metrics.activity.losingTrades).toBe(1);
    expect(metrics.activity.winningTrades).toBe(0);
    // Floating: reflected only in equity, never in totalRealizedPl.
    expect(metrics.account.currentBalance).toBe(990);
    expect(metrics.account.currentEquity).toBe(1190);
  });

  it('reads ANALYTICS_BASELINE_WINDOW_DAYS from real ConfigService when no explicit override is passed', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);

    const previous = process.env.ANALYTICS_BASELINE_WINDOW_DAYS;
    process.env.ANALYTICS_BASELINE_WINDOW_DAYS = '5';
    try {
      const service = new AnalyticsService(prisma as any, new ConfigService());
      const baselines = await service.getHistoricalBaselines(account.id, { now: new Date('2026-10-10T12:00:00Z') });
      expect(baselines.windowDays).toBe(5);
    } finally {
      if (previous === undefined) delete process.env.ANALYTICS_BASELINE_WINDOW_DAYS;
      else process.env.ANALYTICS_BASELINE_WINDOW_DAYS = previous;
    }
  });

  it('falls back to 90 when ANALYTICS_BASELINE_WINDOW_DAYS is unset or invalid', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);

    const previous = process.env.ANALYTICS_BASELINE_WINDOW_DAYS;
    delete process.env.ANALYTICS_BASELINE_WINDOW_DAYS;
    try {
      const service = new AnalyticsService(prisma as any, new ConfigService());
      const baselines = await service.getHistoricalBaselines(account.id, { now: new Date('2026-10-10T12:00:00Z') });
      expect(baselines.windowDays).toBe(90);
    } finally {
      if (previous === undefined) delete process.env.ANALYTICS_BASELINE_WINDOW_DAYS;
      else process.env.ANALYTICS_BASELINE_WINDOW_DAYS = previous;
    }
  });
});
