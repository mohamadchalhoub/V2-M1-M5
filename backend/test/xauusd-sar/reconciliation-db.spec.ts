/**
 * xauusd-sar-v1's automatic UNKNOWN reconciliation, against a REAL database.
 *
 * Every case below was named explicitly by the operator after a live
 * incident (2026-09-24): a reversal's close step was rejected for "absence
 * of network connection", the session correctly went REVERSAL_UNKNOWN, and
 * — because this was never wired to a live broker feed — the position sat
 * unmanaged until its own $10 catastrophic backstop take-profit closed it
 * (+$20, by luck; it could as easily have been a loss). These tests exist so
 * that recovery path never again depends on a human running SQL by hand.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SarReconciliationService, type BrokerDealLite, type BrokerPositionLite } from '../../src/xauusd-sar/reconciliation.service';
import { SPEC_HASH } from '../../src/xauusd-sar/spec';
import { SAR_MAGIC } from '../../src/xauusd-sar/safety-constants';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
let accountId: string;

const NOW = Date.UTC(2026, 8, 24, 8, 0, 0);
const SESSION_DATE = '2026-09-24';

const notifier = { notify: async () => undefined } as never;

function service() {
  return new SarReconciliationService(prisma as never, notifier);
}

/**
 * A REVERSAL_UNKNOWN session with an old SELL position and a stuck attempt
 * trying to reverse it to BUY. `claimedAtMs` defaults to `requestedAtMs`
 * (Fix 4, 2026-09-25: claimed-vs-unclaimed age gates were split, so a test
 * whose intent is "the collector claimed and tried, and enough time has
 * passed since" must set claimedAt explicitly, same as production's own
 * claim timestamp would be) -- pass `claimedAtMs: null` to test the
 * genuinely-unclaimed grace period instead.
 */
async function seedStuckReversal(opts: { requestedAtMs?: number; claimedAtMs?: number | null } = {}) {
  await prisma.xauusdSarSession.create({
    data: {
      accountId,
      specHash: SPEC_HASH,
      sessionDate: SESSION_DATE,
      state: 'REVERSAL_UNKNOWN',
      sessionReference: 4279.125,
      initialBuyTrigger: 4279.625,
      initialSellTrigger: 4278.625,
      cycleId: 'cycle-old',
      direction: 'SELL',
      entryFillPrice: 4282.78,
      extremeSinceEntry: 4282.78,
      reversalLevel: 4283.28,
      brokerTicket: '58606170943',
      unknownSince: new Date(NOW - 5000),
    },
  });
  await prisma.xauusdSarCycle.create({
    data: { accountId, cycleId: 'cycle-old', direction: 'SELL', entryTicket: '58606170943', entryFillPrice: 4282.78, entryAt: new Date(NOW - 20000) },
  });
  const requestedAtMs = opts.requestedAtMs ?? NOW - 20000;
  const claimedAtMs = opts.claimedAtMs === undefined ? requestedAtMs : opts.claimedAtMs;
  await prisma.xauusdSarOrderAttempt.create({
    data: {
      accountId, cycleId: 'cycle-new', idempotencyTag: 'SARtest0000001', kind: 'REVERSAL', direction: 'BUY',
      volume: 0.02, status: 'SENT', requestedAt: new Date(requestedAtMs),
      claimedAt: claimedAtMs === null ? null : new Date(claimedAtMs),
    },
  });
}

/** A REVERSAL_UNKNOWN session for a stuck INITIAL entry (no prior position). See seedStuckReversal's own comment on claimedAtMs. */
async function seedStuckInitial(opts: { requestedAtMs?: number; claimedAtMs?: number | null } = {}) {
  await prisma.xauusdSarSession.create({
    data: {
      accountId,
      specHash: SPEC_HASH,
      sessionDate: SESSION_DATE,
      state: 'REVERSAL_UNKNOWN',
      sessionReference: 4279.125,
      initialBuyTrigger: 4279.625,
      initialSellTrigger: 4278.625,
      unknownSince: new Date(NOW - 5000),
    },
  });
  const requestedAtMs = opts.requestedAtMs ?? NOW - 20000;
  const claimedAtMs = opts.claimedAtMs === undefined ? requestedAtMs : opts.claimedAtMs;
  await prisma.xauusdSarOrderAttempt.create({
    data: {
      accountId, cycleId: 'cycle-new', idempotencyTag: 'SARtest0000002', kind: 'INITIAL', direction: 'BUY',
      volume: 0.02, status: 'SENT', requestedAt: new Date(requestedAtMs),
      claimedAt: claimedAtMs === null ? null : new Date(claimedAtMs),
    },
  });
}

function pos(ticket: string, magic: number | null, comment: string | null = null): BrokerPositionLite {
  return { ticket, magicNumber: magic, comment };
}
function deal(
  ticket: string, positionId: string | null, magic: number | null, entry: BrokerDealLite['entry'], price: number, comment: string | null = null,
): BrokerDealLite {
  return { ticket, positionId, magicNumber: magic, comment, entry, price };
}

const freshInput = (overrides: Partial<Parameters<SarReconciliationService['reconcile']>[0]> = {}) => ({
  accountId,
  nowMs: NOW,
  snapshotAtMs: NOW - 500,
  snapshotComplete: true,
  mt5Connected: true,
  positions: [] as BrokerPositionLite[],
  deals: [] as BrokerDealLite[],
  ...overrides,
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const user = await createUser(prisma);
  accountId = (await createTradingAccount(prisma, user.id)).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('case A: old position still open', () => {
  it('resumes managing the existing ticket unchanged, never guessing a new one', async () => {
    await seedStuckReversal();
    const outcome = await service().reconcile(freshInput({
      positions: [pos('58606170943', SAR_MAGIC)],
    }));
    expect(outcome.resolved).toBe(true);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('ACTIVE_SELL');
    expect(row!.brokerTicket).toBe('58606170943');
    expect(row!.unknownSince).toBeNull();
    const attempt = await prisma.xauusdSarOrderAttempt.findUnique({ where: { idempotencyTag: 'SARtest0000001' } });
    expect(attempt!.status).toBe('FAILED');
  });
});

describe('case A minimum-age grace period (2026-09-24 live incident)', () => {
  // Real incident: reconciliation runs from the collector on roughly the
  // same one-second cadence as that SAME collector's own execution-poll,
  // immediately before it in the same cycle. Without a grace period,
  // reconciliation could see "old ticket still open" and revert the
  // session the INSTANT a reversal was claimed -- before the collector's
  // own poll ever got a chance to attempt the close. Confirmed live: an
  // attempt resolved as Case A in 148ms, producing a rapid ACTIVE_* <->
  // REVERSAL_UNKNOWN ping-pong and a cluster of FAILED attempts the
  // collector's own logs never showed, because reconciliation killed them
  // before the collector ever claimed them.

  it('A: does not mark FAILED and does not restore ACTIVE when the attempt is younger than the minimum age, even though the old ticket is confirmed still open', async () => {
    await seedStuckReversal({ requestedAtMs: NOW - 2000 }); // 2s old -- well under SAR_RECONCILE_MIN_AGE_SECONDS (10s)
    const outcome = await service().reconcile(freshInput({
      positions: [pos('58606170943', SAR_MAGIC)],
    }));

    expect(outcome.resolved).toBe(false);
    expect(outcome.detail).toMatch(/too soon|too young|fair chance/i);

    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('REVERSAL_UNKNOWN'); // NOT reverted to ACTIVE_SELL
    expect(row!.brokerTicket).toBe('58606170943'); // ticket/direction unchanged

    const attempt = await prisma.xauusdSarOrderAttempt.findUnique({ where: { idempotencyTag: 'SARtest0000001' } });
    expect(attempt!.status).toBe('SENT'); // NOT marked FAILED -- still pending for the collector
    expect(attempt!.resolvedAt).toBeNull();
  });

  it('B: once the collector executes that same attempt, the reversal succeeds exactly once (via the existing Case B path)', async () => {
    await seedStuckReversal({ requestedAtMs: NOW - 2000 });

    // First reconcile call: too young, does nothing (case A above).
    const first = await service().reconcile(freshInput({ positions: [pos('58606170943', SAR_MAGIC)] }));
    expect(first.resolved).toBe(false);

    // The collector's OWN execution poll (a separate code path entirely --
    // not reconciliation) then actually closes the old ticket and opens
    // the new one, and the NEXT broker snapshot reflects that.
    const second = await service().reconcile(freshInput({
      nowMs: NOW + 500,
      snapshotAtMs: NOW + 400,
      positions: [pos('58606999999', SAR_MAGIC)],
      deals: [
        deal('99000001', '58606170943', SAR_MAGIC, 'OUT', 4283.3, 'sar-SARtest0000001'),
        deal('99000002', '58606999999', SAR_MAGIC, 'IN', 4283.28, 'sar-SARtest0000001'),
      ],
    }));

    expect(second.resolved).toBe(true);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('ACTIVE_BUY');
    expect(row!.brokerTicket).toBe('58606999999');

    const attempt = await prisma.xauusdSarOrderAttempt.findUnique({ where: { idempotencyTag: 'SARtest0000001' } });
    expect(attempt!.status).toBe('FILLED'); // resolved exactly once, via Case B -- never touched by Case A first

    const cycles = await prisma.xauusdSarCycle.count({ where: { accountId } });
    expect(cycles).toBe(2); // the pre-seeded old cycle + exactly one new cycle -- no duplicate
  });

  it('C: once the minimum age has elapsed, the existing Case A resolution still fires as designed', async () => {
    await seedStuckReversal({ requestedAtMs: NOW - 11_000 }); // 11s old -- past the 10s gate
    const outcome = await service().reconcile(freshInput({
      positions: [pos('58606170943', SAR_MAGIC)],
    }));

    expect(outcome.resolved).toBe(true);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('ACTIVE_SELL');
    const attempt = await prisma.xauusdSarOrderAttempt.findUnique({ where: { idempotencyTag: 'SARtest0000001' } });
    expect(attempt!.status).toBe('FAILED');
  });

  it('D: surviving even when reconciliation runs immediately after the atomic claim (age ~0s), before any execution poll', async () => {
    await seedStuckReversal({ requestedAtMs: NOW }); // claimed this very instant
    const outcome = await service().reconcile(freshInput({
      nowMs: NOW,
      snapshotAtMs: NOW - 100,
      positions: [pos('58606170943', SAR_MAGIC)],
    }));

    expect(outcome.resolved).toBe(false);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('REVERSAL_UNKNOWN');
    const attempt = await prisma.xauusdSarOrderAttempt.findUnique({ where: { idempotencyTag: 'SARtest0000001' } });
    expect(attempt!.status).toBe('SENT');
  });

  it('E: reconciliation and the execution poll overlapping in time never produces a duplicate order or a lost valid attempt', async () => {
    await seedStuckReversal({ requestedAtMs: NOW - 500 });

    // Several rapid reconciliation passes land while the attempt is still
    // young (simulating the collector's ~1s reconcile-then-poll cadence
    // running several times before the close/open actually completes).
    const passes = [
      await service().reconcile(freshInput({ nowMs: NOW + 300, snapshotAtMs: NOW + 200, positions: [pos('58606170943', SAR_MAGIC)] })),
      await service().reconcile(freshInput({ nowMs: NOW + 900, snapshotAtMs: NOW + 800, positions: [pos('58606170943', SAR_MAGIC)] })),
    ];
    expect(passes.every((p) => p.resolved === false)).toBe(true); // still too young both times -- untouched

    // The execution poll finally completes.
    const final = await service().reconcile(freshInput({
      nowMs: NOW + 1200,
      snapshotAtMs: NOW + 1100,
      positions: [pos('58606999999', SAR_MAGIC)],
      deals: [
        deal('99000001', '58606170943', SAR_MAGIC, 'OUT', 4283.3, 'sar-SARtest0000001'),
        deal('99000002', '58606999999', SAR_MAGIC, 'IN', 4283.28, 'sar-SARtest0000001'),
      ],
    }));
    expect(final.resolved).toBe(true);

    const attempts = await prisma.xauusdSarOrderAttempt.count({ where: { accountId, idempotencyTag: 'SARtest0000001' } });
    expect(attempts).toBe(1); // exactly one attempt row throughout -- no duplicate created by the repeated passes
    const cycles = await prisma.xauusdSarCycle.count({ where: { accountId } });
    expect(cycles).toBe(2); // no duplicate cycle either
  });
});

describe('case B: opposite position exists (broker succeeded, our ack was lost)', () => {
  it('adopts the broker-confirmed new position and closes the old cycle from its own exit deal', async () => {
    await seedStuckReversal();
    const outcome = await service().reconcile(freshInput({
      positions: [pos('58606999999', SAR_MAGIC)],
      deals: [
        deal('99000001', '58606170943', SAR_MAGIC, 'OUT', 4272.78, '[tp 4272.78]'),
        deal('99000002', '58606999999', SAR_MAGIC, 'IN', 4272.80, 'sar-SARtest0000001'),
      ],
    }));
    expect(outcome.resolved).toBe(true);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('ACTIVE_BUY');
    expect(row!.brokerTicket).toBe('58606999999');
    expect(Number(row!.entryFillPrice)).toBeCloseTo(4272.80, 6);

    const oldCycle = await prisma.xauusdSarCycle.findFirst({ where: { entryTicket: '58606170943' } });
    expect(oldCycle!.exitAt).not.toBeNull();
    expect(Number(oldCycle!.exitFillPrice)).toBeCloseTo(4272.78, 6);

    const newCycle = await prisma.xauusdSarCycle.findFirst({ where: { entryTicket: '58606999999' } });
    expect(newCycle).not.toBeNull();
  });

  it('adopts the new position even when the old ticket has no matching exit deal in the lookback window', async () => {
    await seedStuckReversal();
    const outcome = await service().reconcile(freshInput({
      positions: [pos('58606999999', SAR_MAGIC)],
      deals: [deal('99000002', '58606999999', SAR_MAGIC, 'IN', 4272.80, 'sar-SARtest0000001')],
    }));
    expect(outcome.resolved).toBe(true);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('ACTIVE_BUY');
  });

  it('an INITIAL attempt with a matching fill opens its first cycle', async () => {
    await seedStuckInitial();
    const outcome = await service().reconcile(freshInput({
      positions: [pos('58607000001', SAR_MAGIC)],
      deals: [deal('99000010', '58607000001', SAR_MAGIC, 'IN', 4279.70, 'sar-SARtest0000002')],
    }));
    expect(outcome.resolved).toBe(true);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('ACTIVE_BUY');
    expect(row!.brokerTicket).toBe('58607000001');
  });
});

describe('case C: broker flat', () => {
  it('closes the old cycle from the broker exit deal and returns to WAIT_INITIAL_DIRECTION, keeping the same trigger levels', async () => {
    await seedStuckReversal({ requestedAtMs: NOW - 15000 });
    const outcome = await service().reconcile(freshInput({
      positions: [],
      deals: [deal('99000001', '58606170943', SAR_MAGIC, 'OUT', 4272.78, '[tp 4272.78]')],
    }));
    expect(outcome.resolved).toBe(true);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('WAIT_INITIAL_DIRECTION');
    expect(row!.brokerTicket).toBeNull();
    expect(Number(row!.initialBuyTrigger)).toBeCloseTo(4279.625, 6);
    expect(Number(row!.initialSellTrigger)).toBeCloseTo(4278.625, 6);

    const cycle = await prisma.xauusdSarCycle.findFirst({ where: { entryTicket: '58606170943' } });
    expect(cycle!.exitReason).toBe('RECONCILED_BROKER_CLOSE');
    expect(Number(cycle!.exitFillPrice)).toBeCloseTo(4272.78, 6);
  });

  it('still resolves flat when no exit deal is found, leaving the exit price unrecorded rather than guessed', async () => {
    await seedStuckReversal({ requestedAtMs: NOW - 15000 });
    const outcome = await service().reconcile(freshInput({ positions: [], deals: [] }));
    expect(outcome.resolved).toBe(true);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('WAIT_INITIAL_DIRECTION');
    const cycle = await prisma.xauusdSarCycle.findFirst({ where: { entryTicket: '58606170943' } });
    expect(cycle!.exitReason).toBe('RECONCILED_UNCONFIRMED_EXIT');
    expect(cycle!.exitFillPrice).toBeNull();
  });

  it('an INITIAL attempt never found anywhere reverts to WAIT_INITIAL_DIRECTION', async () => {
    await seedStuckInitial({ requestedAtMs: NOW - 15000 });
    const outcome = await service().reconcile(freshInput({ positions: [], deals: [] }));
    expect(outcome.resolved).toBe(true);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('WAIT_INITIAL_DIRECTION');
  });
});

describe('case D: contradictory broker state', () => {
  it('refuses to guess when the old ticket is still open AND a new fill also matches this attempt', async () => {
    await seedStuckReversal();
    const outcome = await service().reconcile(freshInput({
      positions: [pos('58606170943', SAR_MAGIC), pos('58606999999', SAR_MAGIC)],
      deals: [deal('99000002', '58606999999', SAR_MAGIC, 'IN', 4272.80, 'sar-SARtest0000001')],
    }));
    expect(outcome.resolved).toBe(false);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('REVERSAL_UNKNOWN');
  });

  it('refuses to guess when more than one position carries the SAR magic', async () => {
    await seedStuckReversal();
    const outcome = await service().reconcile(freshInput({
      positions: [pos('58606170943', SAR_MAGIC), pos('11111111', SAR_MAGIC)],
    }));
    expect(outcome.resolved).toBe(false);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('REVERSAL_UNKNOWN');
  });
});

describe('freshness and authority gates', () => {
  it('never resolves from an incomplete snapshot', async () => {
    await seedStuckReversal();
    const outcome = await service().reconcile(freshInput({ snapshotComplete: false, positions: [] }));
    expect(outcome.resolved).toBe(false);
    expect(outcome.detail).toMatch(/incomplete/);
  });

  it('never resolves when the collector reports MT5 disconnected', async () => {
    await seedStuckReversal();
    const outcome = await service().reconcile(freshInput({ mt5Connected: false, positions: [] }));
    expect(outcome.resolved).toBe(false);
    expect(outcome.detail).toMatch(/disconnected/);
  });

  it('never resolves from a stale snapshot', async () => {
    await seedStuckReversal();
    const outcome = await service().reconcile(freshInput({ snapshotAtMs: NOW - 60_000, positions: [] }));
    expect(outcome.resolved).toBe(false);
    expect(outcome.detail).toMatch(/stale/);
  });

  it('does not conclude absence for an attempt still within the minimum-age grace window', async () => {
    await seedStuckReversal({ requestedAtMs: NOW - 2000 });
    const outcome = await service().reconcile(freshInput({ positions: [], deals: [] }));
    expect(outcome.resolved).toBe(false);
    expect(outcome.detail).toMatch(/too soon/);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('REVERSAL_UNKNOWN');
  });
});

describe('ownership isolation', () => {
  it('never touches or reasons about a foreign-magic position, and reports it for visibility only', async () => {
    await seedStuckReversal();
    const outcome = await service().reconcile(freshInput({
      positions: [
        pos('58606170943', SAR_MAGIC),
        pos('77777777', 262610210), // Engine B
        pos('88888888', 262610200), // legacy RSI M1
        pos('99999999', null), // manual, no magic
      ],
    }));
    expect(outcome.resolved).toBe(true); // case A: old ticket still open
    expect(outcome.foreignSarMagicPositions.sort()).toEqual(['77777777', '88888888', '99999999']);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('ACTIVE_SELL');
    expect(row!.brokerTicket).toBe('58606170943'); // unchanged -- never adopted a foreign ticket
  });
});

describe('idempotency', () => {
  it('a second, later snapshot after resolution is a safe no-op', async () => {
    await seedStuckReversal({ requestedAtMs: NOW - 15000 });
    const first = await service().reconcile(freshInput({
      positions: [],
      deals: [deal('99000001', '58606170943', SAR_MAGIC, 'OUT', 4272.78, '[tp 4272.78]')],
    }));
    expect(first.resolved).toBe(true);

    const second = await service().reconcile(freshInput({ nowMs: NOW + 5000, snapshotAtMs: NOW + 4500, positions: [] }));
    expect(second.resolved).toBe(false);
    expect(second.detail).toBe('no UNKNOWN to resolve.');

    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('WAIT_INITIAL_DIRECTION');
    const cycles = await prisma.xauusdSarCycle.count({ where: { accountId } });
    expect(cycles).toBe(1); // no duplicate cycle rows created by the repeat delivery
  });
});

describe('catastrophic-backstop incident detection', () => {
  it('records a high-severity incident when the exit deal is a broker auto-close, not our own reversal', async () => {
    await seedStuckReversal({ requestedAtMs: NOW - 15000 });
    // SELL entry 4282.78, reversal level 4283.28 (SELL: entry + 0.50).
    // A "[sl ...]" comment -- never our own "sar-" prefix -- landing well
    // past that level is the catastrophic backstop, not a normal reversal.
    const outcome = await service().reconcile(freshInput({
      positions: [],
      deals: [deal('99000001', '58606170943', SAR_MAGIC, 'OUT', 4292.78, '[sl 4292.78]')],
    }));
    expect(outcome.resolved).toBe(true);

    const incidents = await prisma.xauusdSarCatastrophicIncident.findMany({ where: { accountId } });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].direction).toBe('SELL');
    expect(incidents[0].entryTicket).toBe('58606170943');
    expect(Number(incidents[0].entryFillPrice)).toBeCloseTo(4282.78, 6);
    expect(Number(incidents[0].exitFillPrice)).toBeCloseTo(4292.78, 6);
    expect(Number(incidents[0].adverseDistanceUsd)).toBeCloseTo(10.0, 6);
    expect(incidents[0].thresholdWasPreviouslyCrossed).toBe(true); // 4292.78 >= 4283.28
  });

  it('marks the threshold as NOT previously crossed when the exit is on the friendly side of the last known reversal level', async () => {
    await seedStuckReversal({ requestedAtMs: NOW - 15000 });
    // A pathological/contrived case for this specific check: the backstop
    // fired, but the recorded exit price never actually reached the
    // (still-open) $0.50 level -- a straight gap past the entry side,
    // not evidence of a stalled reversal pipeline.
    const outcome = await service().reconcile(freshInput({
      positions: [],
      deals: [deal('99000001', '58606170943', SAR_MAGIC, 'OUT', 4280.0, '[sl 4280.00]')],
    }));
    expect(outcome.resolved).toBe(true);

    const incidents = await prisma.xauusdSarCatastrophicIncident.findMany({ where: { accountId } });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].thresholdWasPreviouslyCrossed).toBe(false); // 4280.0 < 4283.28
  });

  it('never records an incident for a normal, correctly-tagged reversal close', async () => {
    await seedStuckReversal({ requestedAtMs: NOW - 15000 });
    const outcome = await service().reconcile(freshInput({
      positions: [pos('58606999999', SAR_MAGIC)],
      deals: [
        deal('99000001', '58606170943', SAR_MAGIC, 'OUT', 4283.3, 'sar-SARb5ee0faa34a5'),
        deal('99000002', '58606999999', SAR_MAGIC, 'IN', 4283.28, 'sar-SARtest0000001'),
      ],
    }));
    expect(outcome.resolved).toBe(true);
    const incidents = await prisma.xauusdSarCatastrophicIncident.findMany({ where: { accountId } });
    expect(incidents).toHaveLength(0);
  });

  it('never records an incident when no exit deal was found at all (unconfirmed exit, not a backstop)', async () => {
    await seedStuckReversal({ requestedAtMs: NOW - 15000 });
    const outcome = await service().reconcile(freshInput({ positions: [], deals: [] }));
    expect(outcome.resolved).toBe(true);
    const incidents = await prisma.xauusdSarCatastrophicIncident.findMany({ where: { accountId } });
    expect(incidents).toHaveLength(0);
  });
});

describe('no UNKNOWN pending', () => {
  it('is a no-op that only reports foreign exposure when the session is not UNKNOWN', async () => {
    await prisma.xauusdSarSession.create({
      data: { accountId, specHash: SPEC_HASH, sessionDate: SESSION_DATE, state: 'ACTIVE_BUY', brokerTicket: 'abc' },
    });
    const outcome = await service().reconcile(freshInput({ positions: [pos('999', 262610210)] }));
    expect(outcome.resolved).toBe(false);
    expect(outcome.foreignSarMagicPositions).toEqual(['999']);
  });
});
