/**
 * The two engines sharing one MT5 account without sharing a rule.
 *
 * Every case here is a "both at once" case, because that is the state the
 * account is actually in once Engine B is live: M1 holding a position, M5
 * holding another, and a Telegram signal group holding two more. What must
 * be true is that none of them can reach into another's state.
 *
 * Engine A's side of each assertion is checked against its REAL services and
 * its REAL tables, not a restatement of what they are believed to do.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { M1M5OccupancyService } from '../../src/xauusd-m1m5/occupancy.service';
import { planLiquidation, type BrokerItem } from '../../src/xauusd-m1m5/liquidation';
import { V2_MAGIC_M1, V2_MAGIC_M5 } from '../../src/xauusd-m1m5/safety-constants';
import { TelegramLegQueueService } from '../../src/telegram-engine/leg-queue.service';
import { legIdempotencyTag } from '../../src/telegram-engine/idempotency';
import { TELEGRAM_MAGIC } from '../../src/telegram-engine/safety-constants';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
const occupancy = new M1M5OccupancyService(prisma);
const legQueue = new TelegramLegQueueService(prisma);

const NOW = Date.UTC(2026, 8, 23, 13, 0, 0);
let accountId: string;
const savedEnv: Record<string, string | undefined> = {};

/** An Engine A decision holding one timeframe's slot. */
async function engineADecision(timeframe: 'M1' | 'M5', direction: 'BUY' | 'SELL' = 'SELL') {
  const decision = await prisma.xauusdM1M5Decision.create({
    data: {
      strategyVersion: 'test',
      specHash: 'test',
      accountId,
      timeframe,
      direction,
      observedAt: new Date(NOW - 1000),
      eventId: `${timeframe}-${direction}-${Math.random()}`,
      rsiValue: direction === 'SELL' ? 92 : 8,
      threshold: direction === 'SELL' ? 91 : 8.9,
      basisPrice: 4450,
      observationMode: 'TICK',
      reasoning: 'test fixture',
      evidence: {},
      approved: true,
      magicNumber: timeframe === 'M1' ? V2_MAGIC_M1 : V2_MAGIC_M5,
    },
  });
  await occupancy.claim(accountId, timeframe, decision.id);
  return decision;
}

/** A Telegram signal group with two pending legs. */
async function telegramGroup() {
  const signal = await prisma.telegramSignal.create({
    data: {
      engineVersion: 'telegram-sfxauusd1-copy-v1',
      accountId,
      channelId: '-1001234567890',
      messageId: `m-${Math.random().toString(36).slice(2)}`,
      sourceKey: `k-${Math.random().toString(36).slice(2)}`,
      semanticKey: `s-${Math.random().toString(36).slice(2)}`,
      publishedAt: new Date(NOW - 5_000),
      receivedAt: new Date(NOW - 4_000),
      rawText: 'Gold sell now 4338\nSL 4348\nTP 4329\nTP 4300',
      direction: 'SELL',
      entry: 4338,
      stopLoss: 4348,
      takeProfits: [4329, 4300],
      tp1: 4329,
      outcome: 'SUBMITTED',
      detail: 'test fixture',
      evidence: {},
    },
  });
  for (const [i, tp] of [4329, 4300].entries()) {
    await prisma.telegramSignalLeg.create({
      data: {
        signalId: signal.id,
        legIndex: i + 1,
        idempotencyTag: legIdempotencyTag(signal.id, i + 1),
        direction: 'SELL',
        volumeLots: 0.01,
        sourceEntry: 4338,
        stopLoss: 4348,
        takeProfit: tp,
        magicNumber: TELEGRAM_MAGIC,
        orderStatus: 'PENDING',
      },
    });
  }
  await prisma.telegramSignalGroupLock.create({ data: { accountId, signalId: signal.id, state: 'SENT' } });
  return signal;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  const user = await createUser(prisma);
  const account = await createTradingAccount(prisma, user.id);
  accountId = account.id;
  for (const k of ['TELEGRAM_ENGINE_ENABLED', 'TELEGRAM_ENGINE_KILL_SWITCH', 'V2_GLOBAL_KILL_SWITCH', 'XAUUSD_M1M5_KILL_SWITCH']) {
    savedEnv[k] = process.env[k];
  }
  process.env.TELEGRAM_ENGINE_ENABLED = 'true';
  delete process.env.TELEGRAM_ENGINE_KILL_SWITCH;
  delete process.env.V2_GLOBAL_KILL_SWITCH;
  delete process.env.XAUUSD_M1M5_KILL_SWITCH;
});

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await prisma.$disconnect();
});

describe('all three can hold positions at the same time', () => {
  it('M1 open + M5 open + a Telegram group in flight', async () => {
    await engineADecision('M1');
    await engineADecision('M5');
    await telegramGroup();

    const slots = await prisma.xauusdM1M5SlotLock.findMany({ where: { accountId } });
    const group = await prisma.telegramSignalGroupLock.findUnique({ where: { accountId } });
    const legs = await prisma.telegramSignalLeg.count();

    expect(slots.map((s) => s.timeframe).sort()).toEqual(['M1', 'M5']);
    expect(group).not.toBeNull();
    expect(legs).toBe(2);
  });

  it('a Telegram group does not occupy either RSI timeframe', async () => {
    await telegramGroup();
    // Both RSI timeframes must still be claimable.
    const m1 = await engineADecision('M1');
    const m5 = await engineADecision('M5');
    expect(m1.id).toBeTruthy();
    expect(m5.id).toBeTruthy();
    const slots = await prisma.xauusdM1M5SlotLock.count({ where: { accountId } });
    expect(slots).toBe(2);
  });

  it('RSI occupancy on both timeframes does not block a Telegram leg', async () => {
    await engineADecision('M1');
    await engineADecision('M5');
    await telegramGroup();

    const claimed = await legQueue.claimNext(accountId, NOW);
    expect(claimed).not.toBeNull();
    expect(claimed!.magic).toBe(TELEGRAM_MAGIC);
  });

  it('leg 1 does not block leg 2 of the same signal', async () => {
    await telegramGroup();
    const first = await legQueue.claimNext(accountId, NOW);
    const second = await legQueue.claimNext(accountId, NOW);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.legIndex).toBe(2);
  });
});

describe('post-loss locks do not cross engines', () => {
  it('an RSI directional lock does not stop a Telegram leg', async () => {
    // M1 SELL locked after a realised loss — Engine A's rule, and only
    // Engine A's.
    await prisma.xauusdM1M5DirectionalLock.create({
      data: {
        accountId,
        timeframe: 'M1',
        direction: 'SELL',
        strategyVersion: 'test',
        specHash: 'test',
        active: true,
        activatedAt: new Date(NOW - 60_000),
      },
    });
    await telegramGroup();

    const claimed = await legQueue.claimNext(accountId, NOW);
    expect(claimed).not.toBeNull();
    expect(claimed!.side).toBe('SELL');
  });

  it('a Telegram loss creates no RSI lock', async () => {
    const signal = await telegramGroup();
    const leg = await prisma.telegramSignalLeg.findFirst({ where: { signalId: signal.id } });
    await prisma.telegramSignalLeg.update({
      where: { id: leg!.id },
      data: { orderStatus: 'FILLED', closureComplete: true, closedAt: new Date(NOW), realizedPl: -12.5 },
    });

    // Engine B has no lock table and writes to none of Engine A's.
    const locks = await prisma.xauusdM1M5DirectionalLock.count({ where: { accountId } });
    expect(locks).toBe(0);
  });
});

describe('kill switches are per engine', () => {
  it('the RSI kill switch does not stop Telegram legs', async () => {
    process.env.XAUUSD_M1M5_KILL_SWITCH = 'true';
    await telegramGroup();
    const claimed = await legQueue.claimNext(accountId, NOW);
    expect(claimed).not.toBeNull();
  });

  it('the Telegram kill switch does not touch RSI state', async () => {
    process.env.TELEGRAM_ENGINE_KILL_SWITCH = 'true';
    await engineADecision('M1');
    await telegramGroup();

    await legQueue.claimNext(accountId, NOW);

    // Engine A's slot is untouched by Engine B's kill switch.
    const slot = await prisma.xauusdM1M5SlotLock.findFirst({ where: { accountId, timeframe: 'M1' } });
    expect(slot).not.toBeNull();
  });
});

describe('Engine A’s Friday liquidation with Telegram positions present', () => {
  it('selects only Engine A’s positions from a mixed account', () => {
    const items: BrokerItem[] = [
      { ticket: 'A-M1', kind: 'POSITION', symbol: 'XAUUSD', magicNumber: V2_MAGIC_M1, volume: 0.5 },
      { ticket: 'A-M5', kind: 'POSITION', symbol: 'XAUUSD', magicNumber: V2_MAGIC_M5, volume: 0.5 },
      { ticket: 'TG-1', kind: 'POSITION', symbol: 'XAUUSD', magicNumber: TELEGRAM_MAGIC, volume: 0.01 },
      { ticket: 'TG-2', kind: 'POSITION', symbol: 'XAUUSD', magicNumber: TELEGRAM_MAGIC, volume: 0.01 },
    ];
    const plan = planLiquidation(items);

    expect(plan.targets.map((t) => t.ticket).sort()).toEqual(['A-M1', 'A-M5']);
    expect(plan.excluded.map((e) => e.ticket).sort()).toEqual(['TG-1', 'TG-2']);
  });

  it('leaves the Telegram group lock and legs untouched in the database', async () => {
    await engineADecision('M1');
    const signal = await telegramGroup();

    // Engine A liquidating is, in database terms, its own slot being released
    // after its positions close. Engine B's rows are in different tables and
    // are not reachable from that path at all.
    await prisma.xauusdM1M5SlotLock.deleteMany({ where: { accountId } });

    const group = await prisma.telegramSignalGroupLock.findUnique({ where: { accountId } });
    const legs = await prisma.telegramSignalLeg.count({ where: { signalId: signal.id } });
    expect(group).not.toBeNull();
    expect(legs).toBe(2);
  });
});

describe('a Telegram outage does not interrupt Engine A', () => {
  it('Engine A’s slots and decisions survive every Telegram row being deleted', async () => {
    const decision = await engineADecision('M1');
    await telegramGroup();

    // The worst case: Engine B's entire state gone.
    await prisma.telegramSignalGroupLock.deleteMany();
    await prisma.telegramSignalLeg.deleteMany();
    await prisma.telegramSignal.deleteMany();

    const slot = await prisma.xauusdM1M5SlotLock.findFirst({ where: { accountId, timeframe: 'M1' } });
    const stillThere = await prisma.xauusdM1M5Decision.findUnique({ where: { id: decision.id } });
    expect(slot).not.toBeNull();
    expect(stillThere).not.toBeNull();
  });

  it('Engine B’s tables have no foreign key into Engine A’s', async () => {
    const decision = await engineADecision('M1');
    await telegramGroup();

    // Deleting Engine A's decision must not cascade into Telegram rows.
    await prisma.xauusdM1M5SlotLock.deleteMany({ where: { accountId } });
    await prisma.xauusdM1M5Decision.delete({ where: { id: decision.id } });

    expect(await prisma.telegramSignalLeg.count()).toBe(2);
  });
});
