/**
 * The close queue and the liquidation broker built on it (§9.3).
 *
 * The behaviour that matters most here is duplicate suppression. The
 * liquidation service re-plans from a fresh broker snapshot on every pass
 * between the Friday cutoff and the deadline, so a position that has not
 * closed yet gets planned again seconds later. Queueing a second close for a
 * position that already has one in flight is not harmless on a HEDGING
 * account: a duplicate close can open an opposing position rather than doing
 * nothing.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  M1M5CloseRequestService,
  M1M5QueueingLiquidationBroker,
} from '../../src/xauusd-m1m5/close-request.service';
import type { LiquidationTarget } from '../../src/xauusd-m1m5/liquidation';
import { V2_MAGIC_M1, V2_MAGIC_M5, V2_SYMBOL } from '../../src/xauusd-m1m5/safety-constants';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
const closeRequests = new M1M5CloseRequestService(prisma);

let accountId: string;

function target(ticket: string, over: Partial<LiquidationTarget> = {}): LiquidationTarget {
  return {
    ticket,
    kind: 'POSITION',
    timeframe: 'M1',
    magicNumber: V2_MAGIC_M1,
    volume: 0.5,
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

describe('queueing a close', () => {
  it('records the ticket, its timeframe and the magic that authorised it', async () => {
    const result = await closeRequests.request(accountId, target('100'), 'FRIDAY_LIQUIDATION');

    expect(result.queued).toBe(true);
    const row = await prisma.xauusdM1M5CloseRequest.findFirst({ where: { accountId } });
    expect(row?.ticket).toBe('100');
    expect(row?.magicNumber).toBe(V2_MAGIC_M1);
    expect(row?.timeframe).toBe('M1');
    expect(row?.status).toBe('PENDING');
    expect(row?.reason).toBe('FRIDAY_LIQUIDATION');
  });

  it('does NOT queue a second close while one is already in flight', async () => {
    await closeRequests.request(accountId, target('100'), 'FRIDAY_LIQUIDATION');

    const second = await closeRequests.request(accountId, target('100'), 'FRIDAY_LIQUIDATION');

    expect(second.queued).toBe(false);
    expect(await prisma.xauusdM1M5CloseRequest.count({ where: { accountId } })).toBe(1);
  });

  it('still suppresses once the first has been CLAIMED but not answered', async () => {
    await closeRequests.request(accountId, target('100'), 'FRIDAY_LIQUIDATION');
    await closeRequests.claimOldest(accountId);

    const second = await closeRequests.request(accountId, target('100'), 'FRIDAY_LIQUIDATION');

    expect(second.queued).toBe(false);
  });

  it('DOES queue again after a refusal, because the position is still open', async () => {
    await closeRequests.request(accountId, target('100'), 'FRIDAY_LIQUIDATION');
    const claimed = await closeRequests.claimOldest(accountId);
    await closeRequests.recordResult(claimed!.id, { accepted: false, errorMessage: 'market closed' });

    const retry = await closeRequests.request(accountId, target('100'), 'FRIDAY_LIQUIDATION');

    expect(retry.queued).toBe(true);
  });

  it('suppresses per ticket, never across tickets', async () => {
    await closeRequests.request(accountId, target('100'), 'FRIDAY_LIQUIDATION');

    const other = await closeRequests.request(
      accountId,
      target('200', { timeframe: 'M5', magicNumber: V2_MAGIC_M5 }),
      'FRIDAY_LIQUIDATION',
    );

    expect(other.queued).toBe(true);
    expect(await prisma.xauusdM1M5CloseRequest.count({ where: { accountId } })).toBe(2);
  });
});

describe('claiming a close', () => {
  it('offers the same request only once', async () => {
    await closeRequests.request(accountId, target('100'), 'FRIDAY_LIQUIDATION');

    const first = await closeRequests.claimOldest(accountId);
    const second = await closeRequests.claimOldest(accountId);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('returns null when nothing is queued', async () => {
    expect(await closeRequests.claimOldest(accountId)).toBeNull();
  });

  it('records acceptance as ACCEPTED, which is not closure', async () => {
    await closeRequests.request(accountId, target('100'), 'FRIDAY_LIQUIDATION');
    const claimed = await closeRequests.claimOldest(accountId);

    await closeRequests.recordResult(claimed!.id, { accepted: true, errorMessage: null });

    const row = await prisma.xauusdM1M5CloseRequest.findUnique({ where: { id: claimed!.id } });
    // Named ACCEPTED rather than CLOSED on purpose: §9.3 establishes closure
    // by re-querying the broker, never by counting accepted requests.
    expect(row?.status).toBe('ACCEPTED');
    expect(row?.completedAt).not.toBeNull();
  });
});

describe('the liquidation broker port', () => {
  it('reports a suppressed duplicate as accepted, not as a failure', async () => {
    // A close IS in flight for this ticket, which is what the caller is asking
    // about. Reporting a failure would drive the retry and escalation path
    // over a request that is already doing exactly what was wanted.
    const broker = new M1M5QueueingLiquidationBroker(prisma, closeRequests, accountId);
    await broker.close(target('100'));

    const second = await broker.close(target('100'));

    expect(second.accepted).toBe(true);
    expect(second.error).toContain('already');
  });

  it('refuses to report a snapshot when the collector data is stale', async () => {
    // No account snapshot at all, so nothing recent has been pushed. Null
    // makes the liquidation planner refuse to run, which is correct: closing
    // from a stale list risks both missing an open position and trying to
    // close one that is already gone.
    const broker = new M1M5QueueingLiquidationBroker(prisma, closeRequests, accountId);

    expect(await broker.snapshot()).toBeNull();
  });

  it('reports open positions once the collector data is fresh', async () => {
    const now = Date.now();
    await prisma.accountSnapshot.create({
      data: {
        accountId, balance: 3000, equity: 3000, margin: 0, freeMargin: 3000,
        profit: 0, capturedAt: new Date(now - 1000),
      },
    });
    await prisma.position.create({
      data: {
        accountId, platform: 'MT5', externalPositionId: '100', symbol: V2_SYMBOL,
        side: 'SELL', volume: 0.5, openPrice: 4360, status: 'OPEN',
        openedAt: new Date(now - 60_000), rawPayload: { magic: V2_MAGIC_M1 },
      },
    });

    const broker = new M1M5QueueingLiquidationBroker(prisma, closeRequests, accountId, () => now);
    const items = await broker.snapshot();

    expect(items).toHaveLength(1);
    expect(items?.[0]).toMatchObject({ ticket: '100', magicNumber: V2_MAGIC_M1, kind: 'POSITION' });
  });

  it('reports a foreign position with its own magic, so the planner can exclude it', async () => {
    // Reported rather than filtered here: `planLiquidation` is the one place
    // that decides ownership, and it returns what it excluded. Filtering early
    // would hide from the operator that another bot's position was seen.
    const now = Date.now();
    await prisma.accountSnapshot.create({
      data: {
        accountId, balance: 3000, equity: 3000, margin: 0, freeMargin: 3000,
        profit: 0, capturedAt: new Date(now - 1000),
      },
    });
    await prisma.position.create({
      data: {
        accountId, platform: 'MT5', externalPositionId: '900', symbol: V2_SYMBOL,
        side: 'BUY', volume: 0.1, openPrice: 4360, status: 'OPEN',
        openedAt: new Date(now - 60_000), rawPayload: { magic: 262610190 },
      },
    });

    const broker = new M1M5QueueingLiquidationBroker(prisma, closeRequests, accountId, () => now);
    const items = await broker.snapshot();

    expect(items?.[0]?.magicNumber).toBe(262610190);
  });

  it('reports an unattributable position as magicNumber null', async () => {
    const now = Date.now();
    await prisma.accountSnapshot.create({
      data: {
        accountId, balance: 3000, equity: 3000, margin: 0, freeMargin: 3000,
        profit: 0, capturedAt: new Date(now - 1000),
      },
    });
    await prisma.position.create({
      data: {
        accountId, platform: 'MT5', externalPositionId: '901', symbol: V2_SYMBOL,
        side: 'BUY', volume: 0.1, openPrice: 4360, status: 'OPEN',
        openedAt: new Date(now - 60_000), rawPayload: {},
      },
    });

    const broker = new M1M5QueueingLiquidationBroker(prisma, closeRequests, accountId, () => now);

    // Null is what `isOwnedByThisApplication` treats as NOT ours, which is the
    // right default: an unattributable position is never adopted.
    expect(items0(await broker.snapshot())).toBeNull();
  });
});

function items0(items: readonly { magicNumber: number | null }[] | null): number | null {
  return items?.[0]?.magicNumber ?? null;
}
