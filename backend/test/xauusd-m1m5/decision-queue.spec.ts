/**
 * The order queue between the strategy and the collector, against a real
 * database.
 *
 * These are integration tests because the guarantees being verified ARE
 * database guarantees. The claim is safe because an `updateMany` guarded on
 * `orderStatus: PENDING` matches at most once; asserting that against a mock
 * would prove only that the mock was written to agree.
 *
 * The cases that carry the weight are the ones about what happens to the SLOT,
 * because that is what decides whether a second position can be opened on a
 * timeframe that may already hold one.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { M1M5DecisionQueueService } from '../../src/xauusd-m1m5/decision-queue.service';
import { M1M5OccupancyService } from '../../src/xauusd-m1m5/occupancy.service';
import { SPEC_HASH, XAUUSD_M1M5_STRATEGY_VERSION, type Direction, type Timeframe } from '../../src/xauusd-m1m5/spec';
import { v2MagicForTimeframe } from '../../src/xauusd-m1m5/safety-constants';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
const occupancy = new M1M5OccupancyService(prisma);
const queue = new M1M5DecisionQueueService(prisma, occupancy);

let accountId: string;
let seq = 0;

/**
 * A decision already queued for the collector: PENDING, priced, with its
 * timeframe claimed — exactly the state `M1M5ExecutionService` leaves behind
 * when its broker port answers QUEUED.
 */
async function queued(
  timeframe: Timeframe,
  direction: Direction = 'SELL',
  observedAtMs?: number,
): Promise<string> {
  seq += 1;
  const row = await prisma.xauusdM1M5Decision.create({
    data: {
      strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
      specHash: SPEC_HASH,
      accountId,
      timeframe,
      direction,
      // Relative to the claim time the tests use, never the wall clock: the
      // claim now refuses a signal older than 60s, so a wall-clock default
      // would make these tests pass or fail depending on the day.
      observedAt: new Date(observedAtMs ?? at('2026-09-22T09:00:00Z') - seq * 1000),
      eventId: `evt-${timeframe}-${seq}`,
      rsiValue: 92,
      previousRsi: 90,
      threshold: 91,
      basisPrice: 4360,
      observationMode: 'TICK',
      entryPrice: 4360,
      stopLoss: 4365,
      takeProfit: 4355,
      volumeLots: 0.5,
      magicNumber: v2MagicForTimeframe(timeframe),
      orderStatus: 'PENDING',
      sentAt: new Date(),
      approved: true,
      reasoning: 'test',
      evidence: {},
    },
  });
  await occupancy.claim(accountId, timeframe, row.id);
  await occupancy.advance(accountId, timeframe, 'SENT');
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

describe('claiming a queued order', () => {
  it('returns nothing when the queue is empty', async () => {
    expect(await queue.claimOldest(accountId, Date.now())).toBeNull();
  });

  it('moves the claimed row from PENDING to SENT', async () => {
    const id = await queued('M1');

    const claimed = await queue.claimOldest(accountId, at('2026-09-22T09:00:00Z'));

    expect(claimed?.id).toBe(id);
    const row = await prisma.xauusdM1M5Decision.findUnique({ where: { id } });
    expect(row?.orderStatus).toBe('SENT');
  });

  it('offers the same order only once, so two collectors cannot both place it', async () => {
    await queued('M1');

    const first = await queue.claimOldest(accountId, at('2026-09-22T09:00:00Z'));
    const second = await queue.claimOldest(accountId, at('2026-09-22T09:00:00Z'));

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('claims the oldest signal first', async () => {
    // Explicit timestamps rather than creation order. The queue orders by
    // observedAt, so a test that leaned on insertion order would pass without
    // saying anything about the rule it names -- and would keep passing if the
    // ordering were changed to createdAt.
    // Both inside the 60s signal-age limit, so ordering is all that differs.
    const newer = await queued('M5', 'SELL', at('2026-09-22T08:59:50Z'));
    const older = await queued('M1', 'SELL', at('2026-09-22T08:59:30Z'));

    const claimed = await queue.claimOldest(accountId, at('2026-09-22T09:00:00Z'));

    expect(claimed?.id).toBe(older);
    expect(claimed?.id).not.toBe(newer);
  });

  it('CANCELS rather than sends an order whose schedule window closed while it waited', async () => {
    // Observed ten seconds before the claim, so it is the SCHEDULE that
    // refuses it here, not the signal-age limit.
    const id = await queued('M1', 'SELL', at('2026-09-25T20:29:50Z'));

    // 23:30 Beirut on a Friday: inside both the overnight pause and the
    // Friday cutoff. The row was queued while entries were allowed.
    const claimed = await queue.claimOldest(accountId, at('2026-09-25T20:30:00Z'));

    expect(claimed).toBeNull();
    const row = await prisma.xauusdM1M5Decision.findUnique({ where: { id } });
    expect(row?.orderStatus).toBe('NONE');
    expect(row?.approved).toBe(false);
    expect(row?.skipReason).toContain('Cancelled at collector claim');
  });

  it('frees the slot when it cancels, because nothing was ever sent', async () => {
    await queued('M1', 'SELL', at('2026-09-25T20:29:50Z'));

    await queue.claimOldest(accountId, at('2026-09-25T20:30:00Z'));

    expect(await occupancy.current(accountId, 'M1')).toBeNull();
  });
});

describe('recording what the broker did', () => {
  it('records a fill and marks the slot FILLED', async () => {
    const id = await queued('M1');
    await queue.claimOldest(accountId, at('2026-09-22T09:00:00Z'));

    const outcome = await queue.recordResult(id, {
      ok: true, ticket: '555', filledPrice: 4360.2,
      brokerStopLoss: 4365, brokerTakeProfit: 4355,
      errorMessage: null, uncertain: false,
    });

    expect(outcome).toBe('FILLED');
    const row = await prisma.xauusdM1M5Decision.findUnique({ where: { id } });
    expect(row?.orderStatus).toBe('FILLED');
    expect(row?.ticket).toBe(555n);
    expect(row?.filledAt).not.toBeNull();
    expect((await occupancy.current(accountId, 'M1'))?.state).toBe('FILLED');
  });

  it('releases the slot ONLY on a broker-confirmed refusal', async () => {
    const id = await queued('M1');
    await queue.claimOldest(accountId, at('2026-09-22T09:00:00Z'));

    const outcome = await queue.recordResult(id, {
      ok: false, ticket: null, filledPrice: null, brokerStopLoss: null,
      brokerTakeProfit: null, errorMessage: 'invalid price', uncertain: false,
    });

    expect(outcome).toBe('FAILED');
    expect(await occupancy.current(accountId, 'M1')).toBeNull();
  });

  it('HOLDS the slot when the broker answer was lost', async () => {
    // The case the whole three-state design exists for. An uncertain response
    // may be a live position; freeing the slot here would let the next signal
    // open a second one on a timeframe that already holds one.
    const id = await queued('M1');
    await queue.claimOldest(accountId, at('2026-09-22T09:00:00Z'));

    const outcome = await queue.recordResult(id, {
      ok: false, ticket: null, filledPrice: null, brokerStopLoss: null,
      brokerTakeProfit: null, errorMessage: 'no response', uncertain: true,
    });

    expect(outcome).toBe('UNKNOWN');
    expect((await occupancy.current(accountId, 'M1'))?.state).toBe('UNKNOWN');
  });

  it('ignores a replayed result rather than overwriting a settled outcome', async () => {
    const id = await queued('M1');
    await queue.claimOldest(accountId, at('2026-09-22T09:00:00Z'));
    await queue.recordResult(id, {
      ok: true, ticket: '555', filledPrice: 4360.2, brokerStopLoss: null,
      brokerTakeProfit: null, errorMessage: null, uncertain: false,
    });

    const replay = await queue.recordResult(id, {
      ok: false, ticket: null, filledPrice: null, brokerStopLoss: null,
      brokerTakeProfit: null, errorMessage: 'late failure', uncertain: false,
    });

    expect(replay).toBe('IGNORED_UNCLAIMED');
    const row = await prisma.xauusdM1M5Decision.findUnique({ where: { id } });
    expect(row?.orderStatus).toBe('FILLED');
    expect((await occupancy.current(accountId, 'M1'))?.state).toBe('FILLED');
  });

  it('ignores a result for an order nobody claimed', async () => {
    const id = await queued('M1');

    expect(
      await queue.recordResult(id, {
        ok: true, ticket: '999', filledPrice: 4360, brokerStopLoss: null,
        brokerTakeProfit: null, errorMessage: null, uncertain: false,
      }),
    ).toBe('IGNORED_UNCLAIMED');
  });
});

function at(iso: string): number {
  return Date.parse(iso);
}
