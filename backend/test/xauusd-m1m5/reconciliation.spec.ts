/**
 * §15.2/§15.3 — reconciliation against a simulated broker, with a real
 * database.
 *
 * The cases worth testing are the ones where the broker's answer is partial,
 * ambiguous, or about someone else's position. Those are where a reconciler
 * either frees a slot it should have held, or activates a lock it had no
 * business activating.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  M1M5ReconciliationService,
  type BrokerClosure,
  type BrokerPosition,
  type BrokerSnapshot,
} from '../../src/xauusd-m1m5/reconciliation.service';
import { M1M5OccupancyService } from '../../src/xauusd-m1m5/occupancy.service';
import { V2_MAGIC_M1, V2_MAGIC_M5 } from '../../src/xauusd-m1m5/safety-constants';
import { SPEC_HASH, XAUUSD_M1M5_STRATEGY_VERSION, type Direction, type Timeframe } from '../../src/xauusd-m1m5/spec';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
const occupancy = new M1M5OccupancyService(prisma);
const reconciler = new M1M5ReconciliationService(prisma, occupancy);

const NOW = Date.UTC(2026, 8, 23, 7, 0, 0);
/** Magic numbers belonging to the bot that is still running. */
const OTHER_BOT_MAGIC = 262610190;

let accountId: string;
let seq = 0;

function position(over: Partial<BrokerPosition> = {}): BrokerPosition {
  seq += 1;
  return {
    ticket: `t-${seq}`,
    magicNumber: V2_MAGIC_M1,
    symbol: 'XAUUSD',
    direction: 'SELL',
    volume: 0.5,
    openPrice: 4450,
    stopLoss: 4455,
    takeProfit: 4445,
    ...over,
  };
}

function closure(over: Partial<BrokerClosure> = {}): BrokerClosure {
  seq += 1;
  return {
    ticket: `c-${seq}`,
    magicNumber: V2_MAGIC_M1,
    direction: 'SELL',
    netRealized: -12.5,
    dealsComplete: true,
    closedAtMs: NOW,
    closureReason: 'SL',
    ...over,
  };
}

function snapshot(over: Partial<BrokerSnapshot> = {}): BrokerSnapshot {
  return { complete: true, positions: [], closures: [], capturedAtMs: NOW, ...over };
}

async function makeDecision(
  timeframe: Timeframe,
  direction: Direction,
  status: 'UNKNOWN' | 'FILLED',
  ticket?: string,
): Promise<string> {
  seq += 1;
  const row = await prisma.xauusdM1M5Decision.create({
    data: {
      strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
      specHash: SPEC_HASH,
      accountId,
      timeframe,
      direction,
      observedAt: new Date(NOW - 5000),
      eventId: `evt-${seq}`,
      rsiValue: 92,
      threshold: 91,
      basisPrice: 4450,
      observationMode: 'TICK',
      reasoning: 'test',
      evidence: {},
      orderStatus: status,
      ticket: ticket ? BigInt(ticket.replace(/\D/g, '') || '1') : null,
      magicNumber: timeframe === 'M1' ? V2_MAGIC_M1 : V2_MAGIC_M5,
    },
  });
  await occupancy.claim(accountId, timeframe, row.id);
  await occupancy.advance(accountId, timeframe, status === 'UNKNOWN' ? 'UNKNOWN' : 'FILLED');
  return row.id;
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

describe('§4/§9.3 ownership is filtered before anything else', () => {
  it('never activates a lock from another bot’s loss', async () => {
    const result = await reconciler.reconcile(
      accountId,
      snapshot({ closures: [closure({ magicNumber: OTHER_BOT_MAGIC, netRealized: -500 })] }),
    );
    expect(result.closuresApplied).toBe(0);
    expect(result.locksActivated).toEqual([]);
    expect(result.skipped.join(' ')).toMatch(/belongs to another application/i);
    expect(await occupancy.isLocked(accountId, 'M1', 'SELL')).toBe(false);
  });

  it('never activates a lock from a manual position with no magic number', async () => {
    const result = await reconciler.reconcile(
      accountId,
      snapshot({ closures: [closure({ magicNumber: null, netRealized: -99 })] }),
    );
    expect(result.locksActivated).toEqual([]);
  });

  it('counts foreign open positions without touching them', async () => {
    const result = await reconciler.reconcile(
      accountId,
      snapshot({
        positions: [
          position({ magicNumber: OTHER_BOT_MAGIC }),
          position({ magicNumber: null }),
          position({ magicNumber: V2_MAGIC_M1 }),
        ],
      }),
    );
    expect(result.foreignPositionsSeen).toBe(2);
    // Foreign positions are never reported as protection issues, even if they
    // have no stops: they are not ours to remediate.
    expect(result.protectionIssues).toEqual([]);
  });
});

describe('§6.4 closures drive the post-loss locks', () => {
  it('a confirmed loss activates the lock and frees the slot', async () => {
    await makeDecision('M1', 'SELL', 'FILLED', 't-100');
    const result = await reconciler.reconcile(
      accountId,
      snapshot({ closures: [closure({ ticket: '100', netRealized: -20 })] }),
    );

    expect(result.closuresApplied).toBe(1);
    expect(result.locksActivated).toEqual(['M1 SELL']);
    expect(await occupancy.isLocked(accountId, 'M1', 'SELL')).toBe(true);
    expect(await occupancy.current(accountId, 'M1')).toBeNull();
  });

  it('a win frees the slot without locking', async () => {
    await makeDecision('M5', 'BUY', 'FILLED', 't-101');
    const result = await reconciler.reconcile(
      accountId,
      snapshot({ closures: [closure({ ticket: '101', magicNumber: V2_MAGIC_M5, direction: 'BUY', netRealized: 8 })] }),
    );
    expect(result.locksActivated).toEqual([]);
    expect(await occupancy.isLocked(accountId, 'M5', 'BUY')).toBe(false);
    expect(await occupancy.current(accountId, 'M5')).toBeNull();
  });

  it('an incomplete deal history is left unresolved, holding the slot', async () => {
    await makeDecision('M1', 'SELL', 'FILLED', 't-102');
    const result = await reconciler.reconcile(
      accountId,
      snapshot({ closures: [closure({ ticket: '102', dealsComplete: false, netRealized: -30 })] }),
    );

    expect(result.closuresApplied).toBe(0);
    expect(result.locksActivated).toEqual([]);
    expect(result.skipped.join(' ')).toMatch(/deals not fully retrieved/i);
    // Slot stays held: no new entry may bypass the loss rule while the result
    // is unknown.
    expect(await occupancy.current(accountId, 'M1')).not.toBeNull();
  });

  it('a duplicate closure report changes nothing', async () => {
    await makeDecision('M1', 'SELL', 'FILLED', 't-103');
    const c = closure({ ticket: '103', netRealized: -5 });

    const first = await reconciler.reconcile(accountId, snapshot({ closures: [c] }));
    expect(first.closuresApplied).toBe(1);

    const second = await reconciler.reconcile(accountId, snapshot({ closures: [c] }));
    expect(second.closuresApplied).toBe(0);
    expect(second.locksActivated).toEqual([]);
  });
});

describe('§10 absence is not closure', () => {
  it('does not apply closures from an incomplete snapshot', async () => {
    await makeDecision('M1', 'SELL', 'FILLED', 't-104');
    const result = await reconciler.reconcile(
      accountId,
      snapshot({ complete: false, closures: [closure({ ticket: '104', netRealized: -10 })] }),
    );
    expect(result.closuresApplied).toBe(0);
    expect(result.skipped.join(' ')).toMatch(/incomplete/i);
    expect(await occupancy.isLocked(accountId, 'M1', 'SELL')).toBe(false);
  });

  it('leaves an uncertain order unresolved when the snapshot is incomplete', async () => {
    await makeDecision('M1', 'SELL', 'UNKNOWN', 't-105');
    const result = await reconciler.reconcile(accountId, snapshot({ complete: false }));

    expect(result.uncertainResolved).toBe(0);
    expect(result.skipped.join(' ')).toMatch(/absence proves nothing/i);
    // Still occupied, because it may be a live position.
    expect(await occupancy.current(accountId, 'M1')).toMatchObject({ state: 'UNKNOWN' });
  });
});

describe('§7 uncertain submissions are resolved from broker state', () => {
  it('promotes an uncertain order that appears in broker positions', async () => {
    const id = await makeDecision('M1', 'SELL', 'UNKNOWN', 't-106');
    const result = await reconciler.reconcile(
      accountId,
      snapshot({ positions: [position({ ticket: '106', magicNumber: V2_MAGIC_M1 })] }),
    );

    expect(result.uncertainResolved).toBe(1);
    const row = await prisma.xauusdM1M5Decision.findUnique({ where: { id } });
    expect(row?.orderStatus).toBe('FILLED');
    expect(await occupancy.current(accountId, 'M1')).toMatchObject({ state: 'FILLED' });
  });

  it('marks an uncertain order absent from a COMPLETE snapshot as never filled', async () => {
    const id = await makeDecision('M5', 'BUY', 'UNKNOWN', 't-107');
    const result = await reconciler.reconcile(accountId, snapshot({ complete: true, positions: [] }));

    expect(result.uncertainResolved).toBe(1);
    const row = await prisma.xauusdM1M5Decision.findUnique({ where: { id } });
    expect(row?.orderStatus).toBe('FAILED');
    expect(row?.failureReason).toMatch(/never filled/i);
    // Now genuinely free.
    expect(await occupancy.current(accountId, 'M5')).toBeNull();
  });
});

describe('§7 missing protection is detected from the broker view', () => {
  it('flags a position with no stop loss', async () => {
    const result = await reconciler.reconcile(
      accountId,
      snapshot({ positions: [position({ ticket: 'p1', stopLoss: null })] }),
    );
    expect(result.protectionIssues).toHaveLength(1);
    expect(result.protectionIssues[0]).toMatchObject({ ticket: 'p1', timeframe: 'M1', missing: 'STOP_LOSS' });
    expect(result.protectionIssues[0].detail).toMatch(/one restoration attempt/i);
  });

  it('treats a zero stop as missing, not as a stop at zero', async () => {
    const result = await reconciler.reconcile(
      accountId,
      snapshot({ positions: [position({ ticket: 'p2', stopLoss: 0, takeProfit: 0 })] }),
    );
    expect(result.protectionIssues[0].missing).toBe('BOTH');
  });

  it('reports nothing for a fully protected position', async () => {
    const result = await reconciler.reconcile(accountId, snapshot({ positions: [position()] }));
    expect(result.protectionIssues).toEqual([]);
  });
});

describe('§10 occupancy is reconstructed from broker reality', () => {
  it('maps owned positions to their timeframes and ignores everything else', async () => {
    const rebuilt = await reconciler.reconstructOccupancy(
      snapshot({
        positions: [
          position({ ticket: 'm1', magicNumber: V2_MAGIC_M1, direction: 'SELL' }),
          position({ ticket: 'm5', magicNumber: V2_MAGIC_M5, direction: 'BUY' }),
          position({ ticket: 'theirs', magicNumber: OTHER_BOT_MAGIC }),
          position({ ticket: 'manual', magicNumber: null }),
        ],
      }),
    );
    expect(rebuilt.M1).toEqual({ ticket: 'm1', direction: 'SELL' });
    expect(rebuilt.M5).toEqual({ ticket: 'm5', direction: 'BUY' });
  });

  it('reports both timeframes free when we own nothing', async () => {
    const rebuilt = await reconciler.reconstructOccupancy(
      snapshot({ positions: [position({ magicNumber: OTHER_BOT_MAGIC })] }),
    );
    expect(rebuilt).toEqual({ M1: null, M5: null });
  });
});
