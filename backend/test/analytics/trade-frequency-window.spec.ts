// Phase 4 addition — ANALYTICS_SPEC.md §2.6. Deterministic, DB-backed (no
// live MT5), same pattern as the rest of test/analytics/.
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';
import { analyticsServiceFor } from './helpers';

describe('AnalyticsService.getTradesInTrailingWindow', () => {
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

  async function seedClosingDeal(accountId: string, ticket: string, executedAt: Date) {
    await prisma.trade.create({
      data: {
        accountId,
        platform: 'MT5',
        externalTradeId: ticket,
        symbol: 'EURUSD',
        side: 'BUY',
        dealEntry: 'OUT',
        volume: 0.1,
        price: 1.1,
        commission: 0,
        swap: 0,
        profit: 1,
        executedAt,
      },
    });
  }

  it('counts only closing deals inside the trailing window', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const now = new Date('2026-10-01T12:00:00Z');

    await seedClosingDeal(account.id, 'T1', new Date('2026-10-01T11:45:00Z')); // 15 min ago — in
    await seedClosingDeal(account.id, 'T2', new Date('2026-10-01T11:50:00Z')); // 10 min ago — in
    await seedClosingDeal(account.id, 'T3', new Date('2026-10-01T11:00:00Z')); // 60 min ago — out of a 30-min window

    const count = await analyticsServiceFor(prisma).getTradesInTrailingWindow(account.id, 30, now);
    expect(count).toBe(2);
  });

  it('excludes IN deals (opening legs carry no realized outcome)', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const now = new Date('2026-10-01T12:00:00Z');

    await prisma.trade.create({
      data: {
        accountId: account.id, platform: 'MT5', externalTradeId: 'IN1', symbol: 'EURUSD',
        side: 'BUY', dealEntry: 'IN', volume: 0.1, price: 1.1, commission: 0, swap: 0, profit: 0,
        executedAt: new Date('2026-10-01T11:55:00Z'),
      },
    });

    const count = await analyticsServiceFor(prisma).getTradesInTrailingWindow(account.id, 30, now);
    expect(count).toBe(0);
  });

  it('returns 0, never throws, for an account with no trades', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);

    const count = await analyticsServiceFor(prisma).getTradesInTrailingWindow(
      account.id,
      60,
      new Date('2026-10-01T12:00:00Z'),
    );
    expect(count).toBe(0);
  });

  it('is a closed [now - windowMinutes, now] interval — a deal exactly at the boundary counts', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const now = new Date('2026-10-01T12:00:00Z');

    await seedClosingDeal(account.id, 'EDGE', new Date('2026-10-01T11:30:00Z')); // exactly 30 min ago

    const count = await analyticsServiceFor(prisma).getTradesInTrailingWindow(account.id, 30, now);
    expect(count).toBe(1);
  });

  it('one account never sees another account’s trades', async () => {
    const user = await createUser(prisma);
    const acctA = await createTradingAccount(prisma, user.id);
    const acctB = await createTradingAccount(prisma, user.id);
    const now = new Date('2026-10-01T12:00:00Z');

    await seedClosingDeal(acctA.id, 'A1', new Date('2026-10-01T11:55:00Z'));

    const service = analyticsServiceFor(prisma);
    expect(await service.getTradesInTrailingWindow(acctA.id, 30, now)).toBe(1);
    expect(await service.getTradesInTrailingWindow(acctB.id, 30, now)).toBe(0);
  });
});
