// End-to-end (Postgres-backed) proof that trading-day boundaries actually
// change analytics output — trading-day.spec.ts unit-tests the boundary
// math in isolation; this file proves computeAccountSessionMetrics actually
// uses it, by feeding the SAME snapshot history through two accounts that
// differ only in trading_day_timezone/trading_day_reset_hour and asserting
// they produce DIFFERENT startingBalance/dailyPl for the same instant.
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';
import { analyticsServiceFor } from './helpers';

describe('daily reset uses the account trading-day timezone, not UTC midnight', () => {
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

  it('the same snapshot history produces a different startingBalance/dailyPl under different tz+resetHour config', async () => {
    const user = await createUser(prisma);
    const utcAccount = await prisma.tradingAccount.create({
      data: {
        userId: user.id, platform: 'MT5', externalAccountId: 'utc-acct', currency: 'USD',
        tradingDayTimezone: 'UTC', tradingDayResetHour: 0,
      },
    });
    const athensAccount = await prisma.tradingAccount.create({
      data: {
        userId: user.id, platform: 'MT5', externalAccountId: 'athens-acct', currency: 'USD',
        // Winter offset: EET = UTC+2, so a 03:00 local reset is 01:00 UTC.
        tradingDayTimezone: 'Europe/Athens', tradingDayResetHour: 3,
      },
    });

    const snapshots = [
      { capturedAt: '2026-01-14T20:00:00Z', balance: 800, equity: 800 }, // before both boundaries
      { capturedAt: '2026-01-15T00:30:00Z', balance: 900, equity: 900 }, // after UTC boundary, before Athens boundary
      { capturedAt: '2026-01-15T01:30:00Z', balance: 1000, equity: 1000 }, // after both boundaries
      { capturedAt: '2026-01-15T10:00:00Z', balance: 1050, equity: 1050 }, // "now"
    ];
    for (const account of [utcAccount, athensAccount]) {
      for (const s of snapshots) {
        await prisma.accountSnapshot.create({
          data: { accountId: account.id, balance: s.balance, equity: s.equity, margin: 0, freeMargin: s.balance, profit: 0, capturedAt: new Date(s.capturedAt) },
        });
      }
    }

    const now = new Date('2026-01-15T10:00:00Z');
    const service = analyticsServiceFor(prisma);
    const [utcMetrics, athensMetrics] = await Promise.all([
      service.getCurrentMetrics(utcAccount.id, now),
      service.getCurrentMetrics(athensAccount.id, now),
    ]);

    // UTC account: trading day starts 2026-01-15T00:00:00Z. Anchor = latest
    // snapshot <= that boundary = the 2026-01-14T20:00Z row (balance 800).
    expect(utcMetrics.account.startingBalance).toBe(800);
    expect(utcMetrics.account.dailyPl).toBe(250); // 1050 - 800

    // Athens account: trading day starts 2026-01-15T01:00:00Z (03:00 EET).
    // Anchor = latest snapshot <= that boundary = the 00:30Z row (balance 900).
    expect(athensMetrics.account.startingBalance).toBe(900);
    expect(athensMetrics.account.dailyPl).toBe(150); // 1050 - 900

    // Same current balance/equity either way — only the day boundary differs.
    expect(utcMetrics.account.currentBalance).toBe(1050);
    expect(athensMetrics.account.currentBalance).toBe(1050);
  });

  it('a trade executed just before the local reset hour counts toward yesterday, not today, in tradesPerDay', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    await prisma.tradingAccount.update({
      where: { id: account.id },
      data: { tradingDayTimezone: 'Europe/Athens', tradingDayResetHour: 3 },
    });

    // 00:59:59 UTC = 02:59:59 EET, one second before the 03:00 EET reset —
    // still "yesterday's" trading day.
    await prisma.trade.create({
      data: {
        accountId: account.id, platform: 'MT5', externalTradeId: 'T1', positionId: 'P1',
        symbol: 'EURUSD', side: 'BUY', dealEntry: 'OUT', volume: 0.1, price: 1.1,
        commission: 0, swap: 0, profit: 5, executedAt: new Date('2026-01-15T00:59:59Z'),
      },
    });

    const now = new Date('2026-01-15T10:00:00Z'); // well after the 01:00Z (03:00 EET) reset
    const service = analyticsServiceFor(prisma);
    const metrics = await service.getCurrentMetrics(account.id, now);

    expect(metrics.frequency.tradesPerDay).toBe(0);
    expect(metrics.activity.totalTrades).toBe(1); // still counted all-time, just not "today"
  });
});
