/**
 * §15.3 — atomic per-timeframe occupancy, against a real database.
 *
 * These are integration tests, not unit tests: the guarantee being verified
 * IS the database constraint, so asserting it against a mock would prove
 * nothing. What is simulated here is the broker, never the concurrency.
 *
 * §6.4's ordering requirement gets the same treatment — the point of doing
 * closure, lock activation and slot release in one transaction is that no
 * worker can observe an intermediate state, and only a real transaction can
 * demonstrate that.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { M1M5OccupancyService } from '../../src/xauusd-m1m5/occupancy.service';
import type { ClosureOutcome } from '../../src/xauusd-m1m5/locks';
import { SPEC_HASH, XAUUSD_M1M5_STRATEGY_VERSION, type Direction, type Timeframe } from '../../src/xauusd-m1m5/spec';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
const occupancy = new M1M5OccupancyService(prisma);

let accountId: string;
let seq = 0;

async function makeDecision(timeframe: Timeframe, direction: Direction = 'SELL'): Promise<string> {
  seq += 1;
  const row = await prisma.xauusdM1M5Decision.create({
    data: {
      strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
      specHash: SPEC_HASH,
      accountId,
      timeframe,
      direction,
      observedAt: new Date(),
      eventId: `evt-${timeframe}-${seq}`,
      rsiValue: 92,
      previousRsi: 90,
      threshold: 91,
      basisPrice: 4450,
      observationMode: 'TICK',
      reasoning: 'test',
      evidence: {},
    },
  });
  return row.id;
}

function closure(timeframe: Timeframe, direction: Direction, netRealized: number, over: Partial<ClosureOutcome> = {}): ClosureOutcome {
  seq += 1;
  return {
    closureEventId: `close-${seq}`,
    positionId: `pos-${seq}`,
    timeframe,
    direction,
    netRealized,
    fullyClosed: true,
    closedAt: Date.now(),
    closureReason: 'SL',
    rsiAtClosure: 50,
    ...over,
  };
}

beforeEach(async () => {
  await resetDatabase(prisma);
  const user = await createUser(prisma);
  const account = await createTradingAccount(prisma, user.id);
  accountId = account.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('§4 atomic claim', () => {
  it('claims a free timeframe', async () => {
    const decisionId = await makeDecision('M1');
    const result = await occupancy.claim(accountId, 'M1', decisionId);
    expect(result.claimed).toBe(true);
    expect(await occupancy.current(accountId, 'M1')).toMatchObject({ decisionId, state: 'PENDING' });
  });

  it('refuses a second claim on the same timeframe', async () => {
    const first = await makeDecision('M1');
    const second = await makeDecision('M1');

    expect((await occupancy.claim(accountId, 'M1', first)).claimed).toBe(true);
    const blocked = await occupancy.claim(accountId, 'M1', second);
    expect(blocked.claimed).toBe(false);
    if (!blocked.claimed) expect(blocked.reason).toContain(first);
  });

  it('serialises concurrent claims: exactly one of ten wins', async () => {
    // The real test of the mechanism. Ten workers race for one timeframe; the
    // database, not application logic, is what makes nine of them lose.
    const decisionIds = await Promise.all(Array.from({ length: 10 }, () => makeDecision('M5')));
    const results = await Promise.all(decisionIds.map((id) => occupancy.claim(accountId, 'M5', id)));

    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(results.filter((r) => !r.claimed)).toHaveLength(9);
    expect(await prisma.xauusdM1M5SlotLock.count({ where: { accountId, timeframe: 'M5' } })).toBe(1);
  });

  it('lets M1 and M5 be held simultaneously', async () => {
    expect((await occupancy.claim(accountId, 'M1', await makeDecision('M1'))).claimed).toBe(true);
    expect((await occupancy.claim(accountId, 'M5', await makeDecision('M5'))).claimed).toBe(true);
    expect(await prisma.xauusdM1M5SlotLock.count({ where: { accountId } })).toBe(2);
  });

  it('caps total exposure at two', async () => {
    await occupancy.claim(accountId, 'M1', await makeDecision('M1'));
    await occupancy.claim(accountId, 'M5', await makeDecision('M5'));
    expect((await occupancy.claim(accountId, 'M1', await makeDecision('M1'))).claimed).toBe(false);
    expect((await occupancy.claim(accountId, 'M5', await makeDecision('M5'))).claimed).toBe(false);
    expect(await prisma.xauusdM1M5SlotLock.count({ where: { accountId } })).toBe(2);
  });

  it('keeps occupancy per account', async () => {
    const otherUser = await createUser(prisma);
    const otherAccount = await createTradingAccount(prisma, otherUser.id);

    await occupancy.claim(accountId, 'M1', await makeDecision('M1'));

    const otherDecision = await prisma.xauusdM1M5Decision.create({
      data: {
        strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
        specHash: SPEC_HASH,
        accountId: otherAccount.id,
        timeframe: 'M1',
        direction: 'SELL',
        observedAt: new Date(),
        eventId: 'evt-other',
        rsiValue: 92,
        threshold: 91,
        basisPrice: 4450,
        observationMode: 'TICK',
        reasoning: 'test',
        evidence: {},
      },
    });
    expect((await occupancy.claim(otherAccount.id, 'M1', otherDecision.id)).claimed).toBe(true);
  });
});

describe('§4 an UNKNOWN submission keeps the timeframe occupied', () => {
  it('does not free a slot whose order status is unknown', async () => {
    const decisionId = await makeDecision('M1');
    await occupancy.claim(accountId, 'M1', decisionId);
    await occupancy.advance(accountId, 'M1', 'UNKNOWN');

    // releaseUnsent only touches PENDING/SENT — an UNKNOWN may already be a
    // live position, and freeing it would permit a second one.
    expect(await occupancy.releaseUnsent(accountId, 'M1', decisionId)).toBe(false);
    expect(await occupancy.current(accountId, 'M1')).toMatchObject({ state: 'UNKNOWN' });
    expect((await occupancy.claim(accountId, 'M1', await makeDecision('M1'))).claimed).toBe(false);
  });

  it('frees a slot whose order was definitively never sent', async () => {
    const decisionId = await makeDecision('M5');
    await occupancy.claim(accountId, 'M5', decisionId);
    expect(await occupancy.releaseUnsent(accountId, 'M5', decisionId)).toBe(true);
    expect(await occupancy.current(accountId, 'M5')).toBeNull();
    expect((await occupancy.claim(accountId, 'M5', await makeDecision('M5'))).claimed).toBe(true);
  });
});

describe('§6.4 closure, lock activation and slot release are ordered and atomic', () => {
  async function occupy(timeframe: Timeframe, direction: Direction = 'SELL') {
    const decisionId = await makeDecision(timeframe, direction);
    await occupancy.claim(accountId, timeframe, decisionId);
    await occupancy.advance(accountId, timeframe, 'FILLED');
    return decisionId;
  }

  it('a losing closure activates the lock and frees the slot', async () => {
    await occupy('M1', 'SELL');
    const result = await occupancy.releaseOnClosure(accountId, closure('M1', 'SELL', -12.5));

    expect(result).toMatchObject({ duplicate: false, classification: 'LOSS', lockActivated: true, slotReleased: true });
    expect(await occupancy.isLocked(accountId, 'M1', 'SELL')).toBe(true);
    expect(await occupancy.current(accountId, 'M1')).toBeNull();
  });

  it('a winning closure frees the slot without activating a lock', async () => {
    await occupy('M1', 'BUY');
    const result = await occupancy.releaseOnClosure(accountId, closure('M1', 'BUY', 7.25));

    expect(result).toMatchObject({ classification: 'WIN', lockActivated: false, slotReleased: true });
    expect(await occupancy.isLocked(accountId, 'M1', 'BUY')).toBe(false);
  });

  it('a zero closure frees the slot without activating a lock', async () => {
    await occupy('M5', 'SELL');
    const result = await occupancy.releaseOnClosure(accountId, closure('M5', 'SELL', 0));

    expect(result).toMatchObject({ classification: 'ZERO', lockActivated: false, slotReleased: true });
    expect(await occupancy.isLocked(accountId, 'M5', 'SELL')).toBe(false);
  });

  it('an unresolved closure keeps the slot held and takes no lock decision', async () => {
    await occupy('M5', 'BUY');
    const result = await occupancy.releaseOnClosure(
      accountId,
      closure('M5', 'BUY', -30, { fullyClosed: false }),
    );

    expect(result).toMatchObject({ classification: 'UNRESOLVED', lockActivated: false, slotReleased: false });
    expect(await occupancy.current(accountId, 'M5')).not.toBeNull();
    expect(await occupancy.isLocked(accountId, 'M5', 'BUY')).toBe(false);
    // And no new entry can bypass the loss rule while the outcome is unknown.
    expect((await occupancy.claim(accountId, 'M5', await makeDecision('M5'))).claimed).toBe(false);
  });

  it('a duplicate closure report changes nothing', async () => {
    await occupy('M1', 'SELL');
    const outcome = closure('M1', 'SELL', -5);

    const first = await occupancy.releaseOnClosure(accountId, outcome);
    expect(first.duplicate).toBe(false);

    const repeat = await occupancy.releaseOnClosure(accountId, outcome);
    expect(repeat).toMatchObject({ duplicate: true, lockActivated: false, slotReleased: false });
  });

  it('a duplicate report cannot relock a lifecycle that has already unlocked', async () => {
    await occupy('M1', 'SELL');
    const outcome = closure('M1', 'SELL', -5);
    await occupancy.releaseOnClosure(accountId, outcome);
    expect(await occupancy.isLocked(accountId, 'M1', 'SELL')).toBe(true);

    // Unlock legitimately at RSI 20.
    const released = await occupancy.applyObservationToLocks(accountId, 'M1', 20, new Date(Date.now() + 60_000), true);
    expect(released.released).toEqual(['SELL']);
    expect(await occupancy.isLocked(accountId, 'M1', 'SELL')).toBe(false);

    // The broker re-reports the same closure.
    const replay = await occupancy.releaseOnClosure(accountId, outcome);
    expect(replay.duplicate).toBe(true);
    expect(await occupancy.isLocked(accountId, 'M1', 'SELL')).toBe(false);
  });

  it('a genuinely new loss after an unlock starts a fresh lifecycle', async () => {
    await occupy('M1', 'SELL');
    await occupancy.releaseOnClosure(accountId, closure('M1', 'SELL', -5));
    await occupancy.applyObservationToLocks(accountId, 'M1', 20, new Date(Date.now() + 60_000), true);

    await occupy('M1', 'SELL');
    await occupancy.releaseOnClosure(accountId, closure('M1', 'SELL', -9));

    expect(await occupancy.isLocked(accountId, 'M1', 'SELL')).toBe(true);
    const row = await prisma.xauusdM1M5DirectionalLock.findUnique({
      where: { accountId_timeframe_direction: { accountId, timeframe: 'M1', direction: 'SELL' } },
    });
    // The previous release is cleared, not left presenting as current.
    expect(row?.unlockedAt).toBeNull();
    expect(Number(row?.netRealized)).toBe(-9);
  });

  it('closing M1 never touches M5', async () => {
    await occupy('M1', 'SELL');
    await occupy('M5', 'SELL');

    await occupancy.releaseOnClosure(accountId, closure('M1', 'SELL', -5));

    expect(await occupancy.current(accountId, 'M1')).toBeNull();
    expect(await occupancy.current(accountId, 'M5')).not.toBeNull();
    expect(await occupancy.isLocked(accountId, 'M1', 'SELL')).toBe(true);
    expect(await occupancy.isLocked(accountId, 'M5', 'SELL')).toBe(false);
  });
});

describe('§6 lock persistence and unlock evidence', () => {
  it('records the arm of the OR that released the lock', async () => {
    const decisionId = await makeDecision('M1', 'SELL');
    await occupancy.claim(accountId, 'M1', decisionId);
    await occupancy.releaseOnClosure(accountId, closure('M1', 'SELL', -3));

    await occupancy.applyObservationToLocks(accountId, 'M1', 99, new Date(Date.now() + 60_000), true);

    const row = await prisma.xauusdM1M5DirectionalLock.findUnique({
      where: { accountId_timeframe_direction: { accountId, timeframe: 'M1', direction: 'SELL' } },
    });
    expect(row?.active).toBe(false);
    expect(row?.unlockCondition).toBe('RSI_AT_OR_ABOVE');
    expect(Number(row?.unlockThreshold)).toBe(98.5);
    expect(Number(row?.unlockRsi)).toBe(99);
    // The cause survives the release.
    expect(Number(row?.netRealized)).toBe(-3);
  });

  it('reports which directions were active as the observation arrived', async () => {
    const decisionId = await makeDecision('M1', 'SELL');
    await occupancy.claim(accountId, 'M1', decisionId);
    await occupancy.releaseOnClosure(accountId, closure('M1', 'SELL', -3));

    // RSI 99 both satisfies the unlock AND would be a SELL crossing. The
    // service reports SELL as active-at-arrival, which is what stops the
    // decision gate submitting on this observation (§6.3).
    const result = await occupancy.applyObservationToLocks(accountId, 'M1', 99, new Date(Date.now() + 60_000), true);
    expect(result.activeAtArrival).toEqual(['SELL']);
    expect(result.released).toEqual(['SELL']);
  });

  it('refuses to unlock from an ineligible observation', async () => {
    const decisionId = await makeDecision('M1', 'SELL');
    await occupancy.claim(accountId, 'M1', decisionId);
    await occupancy.releaseOnClosure(accountId, closure('M1', 'SELL', -3));

    const result = await occupancy.applyObservationToLocks(accountId, 'M1', 10, new Date(Date.now() + 60_000), false);
    expect(result.released).toEqual([]);
    expect(await occupancy.isLocked(accountId, 'M1', 'SELL')).toBe(true);
  });

  it('refuses to unlock from an observation preceding the losing closure', async () => {
    const decisionId = await makeDecision('M1', 'SELL');
    await occupancy.claim(accountId, 'M1', decisionId);
    const closedAt = Date.now();
    await occupancy.releaseOnClosure(accountId, closure('M1', 'SELL', -3, { closedAt }));

    const early = await occupancy.applyObservationToLocks(accountId, 'M1', 10, new Date(closedAt - 1000), true);
    expect(early.released).toEqual([]);
    expect(await occupancy.isLocked(accountId, 'M1', 'SELL')).toBe(true);
  });

  it('survives a reconnect: locks are read back from the database', async () => {
    const decisionId = await makeDecision('M5', 'BUY');
    await occupancy.claim(accountId, 'M5', decisionId);
    await occupancy.releaseOnClosure(accountId, closure('M5', 'BUY', -2));

    // A brand-new service instance, as after a restart.
    const afterRestart = new M1M5OccupancyService(prisma);
    expect(await afterRestart.isLocked(accountId, 'M5', 'BUY')).toBe(true);
    expect(await afterRestart.isLocked(accountId, 'M5', 'SELL')).toBe(false);
    expect(await afterRestart.isLocked(accountId, 'M1', 'BUY')).toBe(false);
  });
});

describe('§12 dashboard snapshot', () => {
  it('reports both timeframes, occupied or free', async () => {
    const empty = await occupancy.snapshot(accountId);
    expect(empty).toEqual({ M1: null, M5: null });

    await occupancy.claim(accountId, 'M1', await makeDecision('M1'));
    const partial = await occupancy.snapshot(accountId);
    expect(partial.M1).not.toBeNull();
    expect(partial.M5).toBeNull();
  });
});
