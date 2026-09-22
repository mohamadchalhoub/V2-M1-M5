/**
 * Post-loss locks are ENFORCED on entries, from the database, against a real
 * database.
 *
 * They were not. The observation loop decided against an in-memory LockSet
 * created empty at startup and never loaded; the execution service did not
 * check at all; and locks are activated in the database by reconciliation. So
 * after the first real trade lost at its stop and locked M1 SELL, further M1
 * SELL signals reached the risk gate, stopped only because their size exceeded
 * the per-trade cap. At a smaller volume they would have traded.
 *
 * The chain that matters is tested end to end: a losing closure writes the
 * lock, the lock store loads it, and the execution service refuses the entry.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { M1M5ExecutionService, type BrokerPort, type ExecutionContext, type SubmitResponse } from '../../src/xauusd-m1m5/execution.service';
import { loadLockSet, persistUnlock } from '../../src/xauusd-m1m5/lock-store';
import { isLocked, lockoutReasonFor } from '../../src/xauusd-m1m5/locks';
import { M1M5OccupancyService } from '../../src/xauusd-m1m5/occupancy.service';
import type { CrossingSignal } from '../../src/xauusd-m1m5/crossing';
import type { Mt5PermissionSnapshot } from '../../src/xauusd-m1m5/mt5-readiness';
import { SPEC_HASH, type Direction, type Timeframe } from '../../src/xauusd-m1m5/spec';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
const occupancy = new M1M5OccupancyService(prisma);

// Wednesday 10:00 Beirut: inside the trading window.
const NOW = Date.UTC(2026, 8, 23, 7, 0, 0);
const LOGIN = '5050000001';

let accountId: string;
let seq = 0;
const savedEnv: Record<string, string | undefined> = {};

class CountingBroker implements BrokerPort {
  public calls = 0;
  async submit(): Promise<SubmitResponse> {
    this.calls += 1;
    return { status: 'QUEUED' };
  }
}

function signal(timeframe: Timeframe, direction: Direction): CrossingSignal {
  seq += 1;
  return {
    signalId: `${timeframe}:${direction}:${NOW}:${seq}`,
    timeframe,
    direction,
    rsi: direction === 'SELL' ? 92 : 8,
    previousRsi: direction === 'SELL' ? 90 : 9,
    threshold: direction === 'SELL' ? 91 : 8.9,
    price: 4450,
    observedAt: NOW - 1000,
  };
}

const READY: Mt5PermissionSnapshot = {
  capturedAtMs: NOW - 1000,
  loginId: LOGIN,
  tradeMode: 'DEMO',
  terminalConnected: true,
  terminalTradeAllowed: true,
  terminalTradeApiDisabled: false,
  accountTradeAllowed: true,
  accountTradeExpert: true,
  marginMode: 'RETAIL_HEDGING',
};

function ctx(s: CrossingSignal): ExecutionContext {
  return {
    accountId,
    signal: s,
    nowMs: NOW,
    freshQuote: { bid: 4450, ask: 4450.2, tickAtMs: NOW - 500 },
    constraints: { pointSize: 0.01, stopLevelPoints: 0, freezeLevelPoints: 0, tickSize: 0.01 },
    account: { equity: 10_000, freeMargin: 9_000, dayLoss: 0, drawdown: 0 },
    committed: [],
    marginRequired: 500,
    stopRisk: 40,
    mt5Snapshot: READY,
    expectedLoginId: LOGIN,
    scheduleAllowsEntries: true,
    scheduleDetail: 'Clock permits new entries.',
    configuredVolume: 0.5,
  };
}

/** A broker-confirmed LOSS on M1 SELL, applied through the real closure path. */
async function loseOnM1Sell(closedAt = NOW - 60_000) {
  await occupancy.releaseOnClosure(accountId, {
    closureEventId: `58566028247:${closedAt}`,
    positionId: '58566028247',
    timeframe: 'M1',
    direction: 'SELL',
    netRealized: -15.6,
    fullyClosed: true,
    closedAt,
    closureReason: 'Stop loss hit',
    rsiAtClosure: null,
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  const user = await createUser(prisma);
  accountId = (await createTradingAccount(prisma, user.id)).id;
  for (const k of ['XAUUSD_M1M5_EXECUTION_MODE', 'XAUUSD_M1M5_KILL_SWITCH', 'XAUUSD_M1M5_STOP_NEW_ENTRIES']) {
    savedEnv[k] = process.env[k];
  }
  process.env.XAUUSD_M1M5_EXECUTION_MODE = 'DEMO';
  delete process.env.XAUUSD_M1M5_KILL_SWITCH;
  delete process.env.XAUUSD_M1M5_STOP_NEW_ENTRIES;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the lock store reads the database', () => {
  it('sees a lock that reconciliation activated', async () => {
    await loseOnM1Sell();

    const set = await loadLockSet(prisma, accountId, SPEC_HASH);

    expect(isLocked(set, 'M1', 'SELL')).toBe(true);
    // Scoped to exactly one timeframe and direction.
    expect(isLocked(set, 'M1', 'BUY')).toBe(false);
    expect(isLocked(set, 'M5', 'SELL')).toBe(false);
    expect(isLocked(set, 'M5', 'BUY')).toBe(false);
  });

  it('starts all-unlocked when the database holds no lock', async () => {
    const set = await loadLockSet(prisma, accountId, SPEC_HASH);
    for (const tf of ['M1', 'M5'] as const) {
      for (const dir of ['SELL', 'BUY'] as const) expect(isLocked(set, tf, dir)).toBe(false);
    }
  });
});

describe('entries into a locked direction are refused', () => {
  it('refuses M1 SELL after an M1 SELL loss -- the VPS case -- and sends nothing', async () => {
    await loseOnM1Sell();
    const broker = new CountingBroker();

    const result = await new M1M5ExecutionService(prisma, occupancy, broker).execute(ctx(signal('M1', 'SELL')));

    expect(result.outcome).toBe('SKIPPED_LOCKED');
    expect(broker.calls).toBe(0);
    // Recorded for the audit trail, under the lock's own reason.
    const row = await prisma.xauusdM1M5Decision.findUnique({ where: { id: result.decisionId! } });
    expect(row?.approved).toBe(false);
    expect(row?.skipReason).toBe(lockoutReasonFor('SELL'));
    // Nothing was claimed, so M1 is free for an unlocked direction.
    expect(await occupancy.current(accountId, 'M1')).toBeNull();
  });

  it('still allows M1 BUY and both M5 directions: the lock is scoped', async () => {
    await loseOnM1Sell();
    const broker = new CountingBroker();
    const service = new M1M5ExecutionService(prisma, occupancy, broker);

    expect((await service.execute(ctx(signal('M1', 'BUY')))).outcome).toBe('QUEUED');
    expect((await service.execute(ctx(signal('M5', 'SELL')))).outcome).toBe('QUEUED');
    expect(broker.calls).toBe(2);
  });

  it('refuses regardless of volume: the lock is not the risk cap', async () => {
    // What would have happened on the VPS at 0.02 lot: well inside every risk
    // cap, and still refused.
    await loseOnM1Sell();
    const broker = new CountingBroker();
    const small: ExecutionContext = { ...ctx(signal('M1', 'SELL')), stopRisk: 1, configuredVolume: 0.01 };

    const result = await new M1M5ExecutionService(prisma, occupancy, broker).execute(small);

    expect(result.outcome).toBe('SKIPPED_LOCKED');
    expect(broker.calls).toBe(0);
  });
});

describe('unlocks are written back to the database', () => {
  const unlock = (at: number) => ({ condition: 'RSI_AT_OR_BELOW' as const, threshold: 25, rsi: 24.1, at });

  it('releases the lock on a qualifying observation after the loss', async () => {
    await loseOnM1Sell(NOW - 60_000);

    const released = await persistUnlock(prisma, accountId, 'M1', 'SELL', unlock(NOW));

    expect(released).toBe(true);
    expect(await occupancy.isLocked(accountId, 'M1', 'SELL')).toBe(false);
    // And an entry is allowed again once released.
    const result = await new M1M5ExecutionService(prisma, occupancy, new CountingBroker()).execute(ctx(signal('M1', 'SELL')));
    expect(result.outcome).toBe('QUEUED');
  });

  it('never releases on an observation that PRECEDED the loss (§6.5)', async () => {
    await loseOnM1Sell(NOW - 60_000);
    const activatedAt = (await prisma.xauusdM1M5DirectionalLock.findFirst({ where: { accountId } }))!.activatedAt!;

    const released = await persistUnlock(prisma, accountId, 'M1', 'SELL', unlock(activatedAt.getTime() - 1));

    expect(released).toBe(false);
    expect(await occupancy.isLocked(accountId, 'M1', 'SELL')).toBe(true);
  });

  it('reports nothing released when the lock was not active', async () => {
    expect(await persistUnlock(prisma, accountId, 'M1', 'SELL', unlock(NOW))).toBe(false);
  });
});
