/**
 * From a closed broker position to a released slot and, on a loss, an armed
 * post-loss lock -- against a real database.
 *
 * Until this existed the broker snapshot always reported NO closures, and
 * reconciliation frees a filled slot only from a closure. Found with the first
 * real trade on the VPS open (M1 SELL 0.03, ticket 58566028247): the moment it
 * hit its stop or target, M1 would have stayed occupied forever and a loss
 * would never have locked M1 SELL. These tests model that trade.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildBrokerSnapshot, buildClosures } from '../../src/xauusd-m1m5/broker-snapshot';
import { M1M5OccupancyService } from '../../src/xauusd-m1m5/occupancy.service';
import { M1M5ReconciliationService } from '../../src/xauusd-m1m5/reconciliation.service';
import { V2_MAGIC_M1, V2_SYMBOL } from '../../src/xauusd-m1m5/safety-constants';
import { SPEC_HASH, XAUUSD_M1M5_STRATEGY_VERSION } from '../../src/xauusd-m1m5/spec';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
const occupancy = new M1M5OccupancyService(prisma);
const reconciliation = new M1M5ReconciliationService(prisma, occupancy);

const TICKET = '58566028247';
const NOW = Date.now();
let accountId: string;

/** The VPS trade: M1 SELL 0.03, filled, holding the M1 slot. */
async function seedFilledSell() {
  const decision = await prisma.xauusdM1M5Decision.create({
    data: {
      strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
      specHash: SPEC_HASH,
      accountId,
      timeframe: 'M1',
      direction: 'SELL',
      observedAt: new Date(NOW - 600_000),
      eventId: 'evt-first-trade',
      rsiValue: 92,
      previousRsi: 90,
      threshold: 91,
      basisPrice: 4318.2,
      observationMode: 'TICK',
      entryPrice: 4318.2,
      stopLoss: 4323.2,
      takeProfit: 4313.2,
      volumeLots: 0.03,
      magicNumber: V2_MAGIC_M1,
      orderStatus: 'FILLED',
      ticket: BigInt(TICKET),
      approved: true,
      reasoning: 'test',
      evidence: {},
    },
  });
  await prisma.xauusdM1M5SlotLock.create({
    data: { accountId, timeframe: 'M1', decisionId: decision.id, state: 'FILLED' },
  });
}

/** A fresh account snapshot, so absence of the position means it is closed. */
async function freshSnapshot() {
  await prisma.accountSnapshot.create({
    data: {
      accountId,
      balance: 3000,
      equity: 3000,
      margin: 0,
      freeMargin: 3000,
      profit: 0,
      capturedAt: new Date(NOW - 1000),
    },
  });
}

interface DealOverrides {
  profit?: number;
  commission?: number;
  reason?: number;
  fee?: number;
  volume?: number;
}

async function seedDeal(entry: 'IN' | 'OUT', dealTicket: string, over: DealOverrides = {}) {
  await prisma.trade.create({
    data: {
      accountId,
      platform: 'MT5',
      externalTradeId: dealTicket,
      positionId: TICKET,
      symbol: V2_SYMBOL,
      side: entry === 'IN' ? 'SELL' : 'BUY',
      dealEntry: entry,
      volume: over.volume ?? 0.03,
      price: entry === 'IN' ? 4317.83 : 4323.03,
      commission: over.commission ?? 0,
      swap: 0,
      profit: over.profit ?? 0,
      executedAt: new Date(entry === 'IN' ? NOW - 600_000 : NOW - 30_000),
      rawPayload: { magic: V2_MAGIC_M1, reason: over.reason ?? 3, fee: over.fee ?? 0 },
    },
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  const user = await createUser(prisma);
  accountId = (await createTradingAccount(prisma, user.id)).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('buildClosures', () => {
  it('reports nothing while the position is still open', async () => {
    await seedFilledSell();
    expect(await buildClosures(prisma, accountId, new Set([TICKET]))).toEqual([]);
  });

  it('builds a complete closure from the deals once the position is gone', async () => {
    await seedFilledSell();
    await seedDeal('IN', 'd1');
    await seedDeal('OUT', 'd2', { profit: -15.6, commission: -0.1, reason: 4 });

    const [closure] = await buildClosures(prisma, accountId, new Set());

    expect(closure).toMatchObject({
      ticket: TICKET,
      magicNumber: V2_MAGIC_M1,
      direction: 'SELL',
      netRealized: -15.7,
      dealsComplete: true,
      closureReason: 'Stop loss hit',
    });
  });

  it('is INCOMPLETE until the closing deal has synced: it waits, it does not guess', async () => {
    await seedFilledSell();
    await seedDeal('IN', 'd1');

    const [closure] = await buildClosures(prisma, accountId, new Set());

    expect(closure?.dealsComplete).toBe(false);
  });

  it('is INCOMPLETE on a partial close', async () => {
    await seedFilledSell();
    await seedDeal('IN', 'd1');
    await seedDeal('OUT', 'd2', { volume: 0.01, profit: 5 });

    const [closure] = await buildClosures(prisma, accountId, new Set());

    expect(closure?.dealsComplete).toBe(false);
  });

  it('includes MT5 deal fees in the realised result', async () => {
    await seedFilledSell();
    await seedDeal('IN', 'd1', { fee: -0.05 });
    await seedDeal('OUT', 'd2', { profit: 14.4, reason: 5, fee: -0.05 });

    const [closure] = await buildClosures(prisma, accountId, new Set());

    expect(closure?.netRealized).toBe(14.3);
    expect(closure?.closureReason).toBe('Take profit hit');
  });

  it('rounds to the cent, so floating-point dust on a break-even trade is not a loss', async () => {
    await seedFilledSell();
    await seedDeal('IN', 'd1', { commission: -0.1 });
    await seedDeal('OUT', 'd2', { profit: 0.30000000000000004, commission: -0.2 });

    const [closure] = await buildClosures(prisma, accountId, new Set());

    expect(closure?.netRealized).toBe(0);
  });

  it('is only built from a FRESH snapshot', async () => {
    // Stale data: a missing position may just be one not reported yet.
    await seedFilledSell();
    await seedDeal('IN', 'd1');
    await seedDeal('OUT', 'd2', { profit: -15 });

    const snapshot = await buildBrokerSnapshot(prisma, accountId, NOW);

    expect(snapshot.complete).toBe(false);
    expect(snapshot.closures).toEqual([]);
  });
});

describe('end to end, through reconciliation', () => {
  it('a STOP-LOSS close frees the M1 slot and locks M1 SELL', async () => {
    await seedFilledSell();
    await freshSnapshot();
    await seedDeal('IN', 'd1');
    await seedDeal('OUT', 'd2', { profit: -15.6, reason: 4 });

    const snapshot = await buildBrokerSnapshot(prisma, accountId, NOW);
    const result = await reconciliation.reconcile(accountId, snapshot);

    expect(result.closuresApplied).toBe(1);
    expect(await occupancy.current(accountId, 'M1')).toBeNull();
    expect(await occupancy.isLocked(accountId, 'M1', 'SELL')).toBe(true);
    // Scoped: a loss on M1 SELL locks nothing else.
    expect(await occupancy.isLocked(accountId, 'M1', 'BUY')).toBe(false);
    expect(await occupancy.isLocked(accountId, 'M5', 'SELL')).toBe(false);
  });

  it('a TAKE-PROFIT close frees the M1 slot and locks nothing', async () => {
    await seedFilledSell();
    await freshSnapshot();
    await seedDeal('IN', 'd1');
    await seedDeal('OUT', 'd2', { profit: 14.4, reason: 5 });

    const result = await reconciliation.reconcile(accountId, await buildBrokerSnapshot(prisma, accountId, NOW));

    expect(result.closuresApplied).toBe(1);
    expect(await occupancy.current(accountId, 'M1')).toBeNull();
    expect(await occupancy.isLocked(accountId, 'M1', 'SELL')).toBe(false);
  });

  it('applies a closure once, however many passes see it', async () => {
    await seedFilledSell();
    await freshSnapshot();
    await seedDeal('IN', 'd1');
    await seedDeal('OUT', 'd2', { profit: -15.6, reason: 4 });

    await reconciliation.reconcile(accountId, await buildBrokerSnapshot(prisma, accountId, NOW));
    const second = await reconciliation.reconcile(accountId, await buildBrokerSnapshot(prisma, accountId, NOW));

    expect(second.closuresApplied).toBe(0);
  });

  it('leaves the recorded FILL time alone when it applies the closure', async () => {
    await seedFilledSell();
    const fillTime = new Date(NOW - 595_000);
    await prisma.xauusdM1M5Decision.updateMany({ where: { accountId }, data: { filledAt: fillTime } });
    await freshSnapshot();
    await seedDeal('IN', 'd1');
    await seedDeal('OUT', 'd2', { profit: -15.6, reason: 4 });

    await reconciliation.reconcile(accountId, await buildBrokerSnapshot(prisma, accountId, NOW));

    const row = await prisma.xauusdM1M5Decision.findFirst({ where: { accountId } });
    expect(row?.filledAt?.getTime()).toBe(fillTime.getTime());
  });

  it('keeps the slot held while the closing deal has not synced', async () => {
    await seedFilledSell();
    await freshSnapshot();
    await seedDeal('IN', 'd1');

    const result = await reconciliation.reconcile(accountId, await buildBrokerSnapshot(prisma, accountId, NOW));

    expect(result.closuresApplied).toBe(0);
    expect((await occupancy.current(accountId, 'M1'))?.state).toBe('FILLED');
  });
});
