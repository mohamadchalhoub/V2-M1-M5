import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDataIntegrity } from '../../src/health/data-integrity-checks';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';

describe('checkDataIntegrity (pure function against a real Postgres, no mocks)', () => {
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

  it('is OK with all-zero findings on a clean database', async () => {
    const result = await checkDataIntegrity(prisma as any);
    expect(result.status).toBe('OK');
    expect(result.detail).toEqual({
      orphanedTrades: 0,
      negativeTradeVolumes: 0,
      negativePositionVolumes: 0,
      emptyRuleSnapshots: 0,
    });
  });

  it('is DOWN when a trade has a negative volume', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    await prisma.trade.create({
      data: {
        accountId: account.id,
        platform: 'MT5',
        externalTradeId: 'bad-1',
        symbol: 'EURUSD',
        side: 'BUY',
        dealEntry: 'OUT',
        volume: -0.5, // no schema constraint prevents this — that's exactly the gap this check exists to catch
        price: 1.1,
        profit: 0,
        executedAt: new Date(),
      },
    });

    const result = await checkDataIntegrity(prisma as any);
    expect(result.status).toBe('DOWN');
    expect((result.detail as any).negativeTradeVolumes).toBe(1);
  });

  it('is DOWN when a position has a negative volume', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    await prisma.position.create({
      data: {
        accountId: account.id,
        platform: 'MT5',
        externalPositionId: 'bad-pos',
        symbol: 'EURUSD',
        side: 'BUY',
        volume: -1,
        openPrice: 1.1,
        profit: 0,
        swap: 0,
        status: 'OPEN',
        openedAt: new Date(),
      },
    });

    const result = await checkDataIntegrity(prisma as any);
    expect(result.status).toBe('DOWN');
    expect((result.detail as any).negativePositionVolumes).toBe(1);
  });

  it('is DOWN when an alert has an empty rule_snapshot', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const rule = await prisma.ruleDefinition.create({
      data: { accountId: account.id, name: 'Drawdown', ruleType: 'DRAWDOWN', parameters: { max_drawdown_pct: 10 } },
    });
    await prisma.alert.create({
      data: {
        ruleId: rule.id,
        accountId: account.id,
        triggerValues: { drawdownPct: 12 },
        baselineSnapshot: { peakEquity: 1000 },
        ruleSnapshot: {}, // the drift this check is meant to catch
      },
    });

    const result = await checkDataIntegrity(prisma as any);
    expect(result.status).toBe('DOWN');
    expect((result.detail as any).emptyRuleSnapshots).toBe(1);
  });

  it('aggregates multiple simultaneous issues without losing any of them', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    await prisma.trade.create({
      data: {
        accountId: account.id,
        platform: 'MT5',
        externalTradeId: 'bad-2',
        symbol: 'EURUSD',
        side: 'BUY',
        dealEntry: 'OUT',
        volume: -1,
        price: 1.1,
        profit: 0,
        executedAt: new Date(),
      },
    });
    await prisma.position.create({
      data: {
        accountId: account.id,
        platform: 'MT5',
        externalPositionId: 'bad-pos-2',
        symbol: 'EURUSD',
        side: 'BUY',
        volume: -2,
        openPrice: 1.1,
        profit: 0,
        swap: 0,
        status: 'OPEN',
        openedAt: new Date(),
      },
    });

    const result = await checkDataIntegrity(prisma as any);
    expect(result.status).toBe('DOWN');
    expect(result.detail).toMatchObject({ negativeTradeVolumes: 1, negativePositionVolumes: 1 });
  });
});
