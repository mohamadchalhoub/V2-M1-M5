/**
 * Regression coverage for the 2026-09-25 incident repair, reproducing the
 * exact production defects found during the forensic investigation:
 *
 *   Fix 1: closeForDay() must never transition to DAILY_CLOSED / clear
 *          session ownership unless broker-confirmed flat, for ANY
 *          non-terminal state (not just ACTIVE_BUY/ACTIVE_SELL).
 *   Fix 2: an orphaned SAR-magic broker position (or a ticket mismatch on
 *          an owned one) must move the session to RECOVERY_REQUIRED, never
 *          be silently ignored or auto-adopted.
 *   Fix 3: (collector-side, Python -- see collector/tests/test_runner_sar_
 *          execution.py and collector/tests/test_executor.py)
 *   Fix 4: reconciliation must not conclude FAILED for a reversal the
 *          collector never even claimed, using the same short age gate
 *          meant for a claimed-but-uncompleted attempt.
 *   Daily-close FLATTEN fix: a daily close must close and stop, never
 *          reopen the opposite side (the old code reused 'REVERSAL', which
 *          the collector always follows with a fresh open).
 *   Bracket removal: new SAR orders carry `noBracket: true` and no
 *          catastrophicStopPoints field at all.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SarExecutionService, type SarBrokerPort, type SarSubmitRequest, type SarSubmitResponse } from '../../src/xauusd-sar/execution.service';
import { SarReconciliationService, type BrokerDealLite, type BrokerPositionLite } from '../../src/xauusd-sar/reconciliation.service';
import { SPEC_HASH } from '../../src/xauusd-sar/spec';
import { SAR_MAGIC } from '../../src/xauusd-sar/safety-constants';
import { setSarVolume } from '../../src/xauusd-sar/volume-setting';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
let accountId: string;

const NOW = Date.UTC(2026, 8, 25, 8, 0, 0);
const SESSION_DATE = '2026-09-25';
const notifier = { notify: async () => undefined } as never;

function reconciliationService() {
  return new SarReconciliationService(prisma as never, notifier);
}

class QueueingFakeBroker implements SarBrokerPort {
  public readonly calls: SarSubmitRequest[] = [];
  async submit(request: SarSubmitRequest): Promise<SarSubmitResponse> {
    this.calls.push(request);
    return { status: 'QUEUED' };
  }
}

function executionService(broker: SarBrokerPort) {
  return new SarExecutionService(prisma as never, broker);
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
  const metadata = await prisma.symbolMetadata.upsert({
    where: { symbol: 'XAUUSD' },
    create: { symbol: 'XAUUSD', point: 0.01, volumeMin: 0.01, volumeMax: 5, volumeStep: 0.01, contractSize: 100, tradeMode: 4, digits: 2, profitCurrency: 'USD' },
    update: {},
  });
  void metadata;
  await setSarVolume(prisma, { accountId, lots: 0.01, changedBy: 'test' });
  process.env.XAUUSD_SAR_ENABLED = 'true';
  process.env.XAUUSD_SAR_EXECUTION_MODE = 'DEMO';
  delete process.env.XAUUSD_SAR_KILL_SWITCH;
  delete process.env.V2_GLOBAL_KILL_SWITCH;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedSession(overrides: Partial<Parameters<typeof prisma.xauusdSarSession.create>[0]['data']> = {}) {
  return prisma.xauusdSarSession.create({
    data: {
      accountId,
      specHash: SPEC_HASH,
      sessionDate: SESSION_DATE,
      state: 'ACTIVE_SELL',
      sessionReference: 4279.125,
      cycleId: 'cycle-1',
      direction: 'SELL',
      entryFillPrice: 4274.07,
      extremeSinceEntry: 4274.07,
      reversalLevel: 4274.57,
      brokerTicket: '58620919833',
      ...overrides,
    },
  });
}

describe('Fix 1: closeForDay requires broker-confirmed flat, for ANY non-terminal state', () => {
  it('production incident reproduction: REVERSAL_UNKNOWN at 23:40 is NEVER wiped to DAILY_CLOSED', async () => {
    // Exactly the confirmed production state: a reversal was mid-flight
    // (claimed by the collector, broker answer not yet known) when the
    // daily-close window arrived. The OLD code had no branch for this and
    // fell through to an unconditional wipe.
    await seedSession({ state: 'REVERSAL_UNKNOWN', unknownSince: new Date(NOW - 3000) });
    const svc = executionService(new QueueingFakeBroker());

    const result = await svc.closeForDay(accountId, NOW);

    expect(result.action).toBe('BLOCKED');
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('REVERSAL_UNKNOWN'); // untouched, not DAILY_CLOSED
    expect(row!.brokerTicket).toBe('58620919833'); // ownership NOT cleared
    expect(row!.direction).toBe('SELL');
  });

  it('RECOVERY_REQUIRED also blocks the close — never guessed flat', async () => {
    await seedSession({ state: 'RECOVERY_REQUIRED', direction: null, brokerTicket: null, cycleId: null });
    const svc = executionService(new QueueingFakeBroker());

    const result = await svc.closeForDay(accountId, NOW);

    expect(result.action).toBe('BLOCKED');
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('RECOVERY_REQUIRED');
  });

  it('ACTIVE_SELL queues a FLATTEN (not REVERSAL) and stays BLOCKED until reconciliation confirms flat', async () => {
    await seedSession({ state: 'ACTIVE_SELL' });
    const broker = new QueueingFakeBroker();
    const svc = executionService(broker);

    const result = await svc.closeForDay(accountId, NOW);

    expect(result.action).toBe('BLOCKED');
    expect(broker.calls).toHaveLength(1);
    expect(broker.calls[0].kind).toBe('FLATTEN'); // never 'REVERSAL' -- see the daily-close FLATTEN fix
    expect(broker.calls[0].closingTicket).toBe('58620919833');
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('REVERSAL_UNKNOWN'); // claimed, awaiting reconciliation -- not DAILY_CLOSED yet
  });

  it('a genuinely flat WAIT_INITIAL_DIRECTION session (no ticket) completes DAILY_CLOSED normally', async () => {
    await seedSession({ state: 'WAIT_INITIAL_DIRECTION', direction: null, brokerTicket: null, cycleId: null, entryFillPrice: null, extremeSinceEntry: null, reversalLevel: null });
    const svc = executionService(new QueueingFakeBroker());

    const result = await svc.closeForDay(accountId, NOW);

    expect(result.action).toBe('DAILY_CLOSED');
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('DAILY_CLOSED');
  });

  it('a data-defect state with an unexpected ticket is BLOCKED, never guessed flat', async () => {
    await seedSession({ state: 'WAIT_INITIAL_DIRECTION', direction: null, brokerTicket: 'unexpected-ticket', cycleId: null });
    const svc = executionService(new QueueingFakeBroker());

    const result = await svc.closeForDay(accountId, NOW);

    expect(result.action).toBe('BLOCKED');
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('WAIT_INITIAL_DIRECTION'); // untouched
  });
});

describe('Fix 2: orphan/mismatch detection moves the session to RECOVERY_REQUIRED', () => {
  it('production incident reproduction: WAIT_MARKET_OPEN with an orphaned SAR-magic broker position', async () => {
    await seedSession({
      state: 'WAIT_MARKET_OPEN', direction: null, brokerTicket: null, cycleId: null,
      entryFillPrice: null, extremeSinceEntry: null, reversalLevel: null,
    });
    const outcome = await reconciliationService().reconcile(freshInput({
      positions: [pos('58620919833', SAR_MAGIC, 'sar-SAR694bc0bb0f47')],
    }));

    expect(outcome.resolved).toBe(false);
    expect(outcome.detail).toMatch(/orphaned position/);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('RECOVERY_REQUIRED');
  });

  it('WAIT_INITIAL_DIRECTION with an orphan is also caught (not just WAIT_MARKET_OPEN)', async () => {
    await seedSession({
      state: 'WAIT_INITIAL_DIRECTION', direction: null, brokerTicket: null, cycleId: null,
      entryFillPrice: null, extremeSinceEntry: null, reversalLevel: null,
      initialBuyTrigger: 4279.625, initialSellTrigger: 4278.625,
    });
    const outcome = await reconciliationService().reconcile(freshInput({
      positions: [pos('58620919833', SAR_MAGIC)],
    }));

    expect(outcome.resolved).toBe(false);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('RECOVERY_REQUIRED');
  });

  it('ownership mismatch: ACTIVE_SELL expects one ticket, broker shows a different one', async () => {
    await seedSession({ state: 'ACTIVE_SELL', brokerTicket: '11111' });
    const outcome = await reconciliationService().reconcile(freshInput({
      positions: [pos('22222', SAR_MAGIC)],
    }));

    expect(outcome.resolved).toBe(false);
    expect(outcome.detail).toMatch(/ownership mismatch/);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('RECOVERY_REQUIRED');
  });

  it('does NOT flag a healthy match: ACTIVE_SELL owning exactly the broker-reported ticket', async () => {
    await seedSession({ state: 'ACTIVE_SELL', brokerTicket: '58620919833' });
    const outcome = await reconciliationService().reconcile(freshInput({
      positions: [pos('58620919833', SAR_MAGIC)],
    }));

    expect(outcome.resolved).toBe(false); // "no UNKNOWN to resolve" -- normal, not an incident
    expect(outcome.detail).toBe('no UNKNOWN to resolve.');
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('ACTIVE_SELL'); // untouched
  });

  it('does NOT flag anything on an incomplete/disconnected snapshot — never guesses from untrustworthy data', async () => {
    await seedSession({
      state: 'WAIT_MARKET_OPEN', direction: null, brokerTicket: null, cycleId: null,
      entryFillPrice: null, extremeSinceEntry: null, reversalLevel: null,
    });
    const outcome = await reconciliationService().reconcile(freshInput({
      snapshotComplete: false,
      positions: [pos('58620919833', SAR_MAGIC)],
    }));

    expect(outcome.resolved).toBe(false);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('WAIT_MARKET_OPEN'); // untouched -- snapshot wasn't trustworthy
  });

  it('once RECOVERY_REQUIRED, further reconcile passes do not re-alert or re-write (idempotent)', async () => {
    await seedSession({ state: 'RECOVERY_REQUIRED', direction: null, brokerTicket: null, cycleId: null });
    const outcome = await reconciliationService().reconcile(freshInput({
      positions: [pos('58620919833', SAR_MAGIC)],
    }));
    expect(outcome.resolved).toBe(false);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('RECOVERY_REQUIRED');
  });
});

describe('RECOVERY_REQUIRED blocks all normal evaluation', () => {
  it('evaluateTick refuses to act while RECOVERY_REQUIRED', async () => {
    await seedSession({ state: 'RECOVERY_REQUIRED', direction: null, brokerTicket: null, cycleId: null });
    const result = await executionService(new QueueingFakeBroker()).evaluateTick(
      accountId, { bid: 4500, ask: 4500.2, ageSeconds: 1, fresh: true }, NOW,
    );
    expect(result.action).toBe('BLOCKED');
  });
});

describe('Fix 4: reconciliation respects claimed-vs-unclaimed reversal attempts', () => {
  async function seedUnclaimedReversal(opts: { requestedAtMs: number }) {
    await seedSession({ state: 'REVERSAL_UNKNOWN', unknownSince: new Date(opts.requestedAtMs) });
    await prisma.xauusdSarCycle.create({
      data: { accountId, cycleId: 'cycle-1', direction: 'SELL', entryTicket: '58620919833', entryFillPrice: 4274.07, entryAt: new Date(opts.requestedAtMs - 60000) },
    });
    await prisma.xauusdSarOrderAttempt.create({
      data: {
        accountId, cycleId: 'cycle-2', idempotencyTag: 'SARunclaimed01', kind: 'REVERSAL', direction: 'BUY',
        volume: 0.01, status: 'SENT', requestedAt: new Date(opts.requestedAtMs), claimedAt: null,
      },
    });
  }

  it('production incident reproduction: an UNCLAIMED reversal at 9.5s old is NOT judged failed (old 10s gate would have killed it)', async () => {
    await seedUnclaimedReversal({ requestedAtMs: NOW - 9500 });
    const outcome = await reconciliationService().reconcile(freshInput({
      positions: [pos('58620919833', SAR_MAGIC)],
    }));

    expect(outcome.resolved).toBe(false);
    expect(outcome.detail).toMatch(/unclaimed/);
    const attempt = await prisma.xauusdSarOrderAttempt.findUnique({ where: { idempotencyTag: 'SARunclaimed01' } });
    expect(attempt!.status).toBe('SENT'); // NOT marked FAILED
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('REVERSAL_UNKNOWN'); // still waiting, not reverted to ACTIVE_SELL
  });

  it('an unclaimed reversal genuinely older than the unclaimed grace period IS concluded (collector likely down)', async () => {
    await seedUnclaimedReversal({ requestedAtMs: NOW - 35000 }); // > SAR_RECONCILE_UNCLAIMED_GRACE_SECONDS (30s)
    const outcome = await reconciliationService().reconcile(freshInput({
      positions: [pos('58620919833', SAR_MAGIC)],
    }));

    expect(outcome.resolved).toBe(true);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('ACTIVE_SELL'); // resumed managing the still-open old ticket
  });

  it('a CLAIMED reversal still uses the short 10s gate, anchored to claimedAt not requestedAt', async () => {
    // Requested long ago (would fail the OLD requestedAt-based 10s gate),
    // but claimed only 2s ago -- the collector picked it up recently and
    // deserves its own fair chance, measured from when it actually tried.
    await seedSession({ state: 'REVERSAL_UNKNOWN', unknownSince: new Date(NOW - 40000) });
    await prisma.xauusdSarCycle.create({
      data: { accountId, cycleId: 'cycle-1', direction: 'SELL', entryTicket: '58620919833', entryFillPrice: 4274.07, entryAt: new Date(NOW - 100000) },
    });
    await prisma.xauusdSarOrderAttempt.create({
      data: {
        accountId, cycleId: 'cycle-2', idempotencyTag: 'SARclaimed01', kind: 'REVERSAL', direction: 'BUY',
        volume: 0.01, status: 'SENT', requestedAt: new Date(NOW - 40000), claimedAt: new Date(NOW - 2000),
      },
    });
    const outcome = await reconciliationService().reconcile(freshInput({
      positions: [pos('58620919833', SAR_MAGIC)],
    }));

    expect(outcome.resolved).toBe(false);
    expect(outcome.detail).toMatch(/claimed/);
    const attempt = await prisma.xauusdSarOrderAttempt.findUnique({ where: { idempotencyTag: 'SARclaimed01' } });
    expect(attempt!.status).toBe('SENT');
  });

  it('a CLAIMED reversal past the 10s claimed-age gate IS concluded', async () => {
    await seedSession({ state: 'REVERSAL_UNKNOWN', unknownSince: new Date(NOW - 40000) });
    await prisma.xauusdSarCycle.create({
      data: { accountId, cycleId: 'cycle-1', direction: 'SELL', entryTicket: '58620919833', entryFillPrice: 4274.07, entryAt: new Date(NOW - 100000) },
    });
    await prisma.xauusdSarOrderAttempt.create({
      data: {
        accountId, cycleId: 'cycle-2', idempotencyTag: 'SARclaimed02', kind: 'REVERSAL', direction: 'BUY',
        volume: 0.01, status: 'SENT', requestedAt: new Date(NOW - 40000), claimedAt: new Date(NOW - 11000),
      },
    });
    const outcome = await reconciliationService().reconcile(freshInput({
      positions: [pos('58620919833', SAR_MAGIC)],
    }));

    expect(outcome.resolved).toBe(true);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('ACTIVE_SELL');
  });
});

describe('Bracket removal: new SAR orders carry no catastrophic bracket', () => {
  it('a fresh INITIAL entry sends noBracket:true and no catastrophicStopPoints', async () => {
    await seedSession({
      state: 'WAIT_INITIAL_DIRECTION', direction: null, brokerTicket: null, cycleId: null,
      entryFillPrice: null, extremeSinceEntry: null, reversalLevel: null,
      initialBuyTrigger: 4500.5, initialSellTrigger: 4499.5,
    });
    const broker = new QueueingFakeBroker();
    await executionService(broker).evaluateTick(accountId, { bid: 4500.4, ask: 4500.6, ageSeconds: 1, fresh: true }, NOW);

    expect(broker.calls).toHaveLength(1);
    // SarSubmitRequest itself never carried a bracket-distance field (that
    // lived only in the HTTP controller's response payload) -- confirmed
    // instead via the controller's own contract test below.
    expect(broker.calls[0].kind).toBe('INITIAL');
  });

  it('the collector-facing pending-order payload carries noBracket:true and never catastrophicStopPoints', async () => {
    const { SarExecutionController } = await import('../../src/xauusd-sar/execution.controller');
    const accounts = { getOrThrow: async () => ({ id: accountId }) } as never;
    const execution = new SarExecutionService(prisma as never, new QueueingFakeBroker());
    const reconciliation = {} as never;
    const controller = new SarExecutionController(accounts, execution, reconciliation, prisma as never);

    await seedSession({
      state: 'WAIT_INITIAL_DIRECTION', direction: null, brokerTicket: null, cycleId: null,
      entryFillPrice: null, extremeSinceEntry: null, reversalLevel: null,
      initialBuyTrigger: 4500.5, initialSellTrigger: 4499.5,
    });
    await execution.evaluateTick(accountId, { bid: 4500.4, ask: 4500.6, ageSeconds: 1, fresh: true }, NOW);

    const response = await controller.getPendingOrder(accountId);
    expect(response.order).not.toBeNull();
    expect(response.order!.noBracket).toBe(true);
    expect(response.order).not.toHaveProperty('catastrophicStopPoints');
  });
});

// 2026-09-25 HARDENING PASS — requirement 1: FLATTEN requires independent
// broker-flat confirmation. A successful MT5 close acknowledgment alone
// must never be sufficient to declare DAILY_CLOSED.
describe('Hardening: FLATTEN requires independent broker-flat confirmation', () => {
  class QueueingFakeBroker2 implements SarBrokerPort {
    async submit(): Promise<SarSubmitResponse> {
      return { status: 'QUEUED' };
    }
  }

  async function seedPendingConfirmation() {
    await seedSession({ state: 'DAILY_CLOSE_PENDING_CONFIRMATION', brokerTicket: '58620919833' });
    await prisma.xauusdSarCycle.create({
      data: { accountId, cycleId: 'cycle-1', direction: 'SELL', entryTicket: '58620919833', entryFillPrice: 4274.07, entryAt: new Date(NOW - 3_600_000) },
    });
    await prisma.xauusdSarOrderAttempt.create({
      data: {
        accountId, cycleId: 'cycle-1', idempotencyTag: 'SARCLOSEtest01', kind: 'FLATTEN', direction: 'BUY',
        volume: 0.01, status: 'SENT', requestedAt: new Date(NOW - 5000), claimedAt: new Date(NOW - 4000),
      },
    });
  }

  it('A. FLATTEN close ack + broker still shows position => NOT DAILY_CLOSED', async () => {
    await seedPendingConfirmation();
    const outcome = await reconciliationService().reconcile(freshInput({
      positions: [pos('58620919833', SAR_MAGIC)], // the SAME ticket that was "closed"
    }));
    expect(outcome.resolved).toBe(false);
    expect(outcome.detail).toMatch(/not yet confirmed flat/);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('DAILY_CLOSE_PENDING_CONFIRMATION'); // unchanged, not DAILY_CLOSED
    expect(row!.brokerTicket).toBe('58620919833'); // not cleared
  });

  it('B. FLATTEN close ack + stale/incomplete snapshot => NOT DAILY_CLOSED', async () => {
    await seedPendingConfirmation();
    const incomplete = await reconciliationService().reconcile(freshInput({ snapshotComplete: false, positions: [] }));
    expect(incomplete.resolved).toBe(false);
    let row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('DAILY_CLOSE_PENDING_CONFIRMATION');

    const disconnected = await reconciliationService().reconcile(freshInput({ mt5Connected: false, positions: [] }));
    expect(disconnected.resolved).toBe(false);
    row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('DAILY_CLOSE_PENDING_CONFIRMATION');

    const stale = await reconciliationService().reconcile(freshInput({ snapshotAtMs: NOW - 60_000, positions: [] }));
    expect(stale.resolved).toBe(false);
    row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('DAILY_CLOSE_PENDING_CONFIRMATION');
  });

  it('C. FLATTEN close ack + fresh complete snapshot + zero SAR positions => DAILY_CLOSED', async () => {
    await seedPendingConfirmation();
    const outcome = await reconciliationService().reconcile(freshInput({ positions: [] }));
    expect(outcome.resolved).toBe(true);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('DAILY_CLOSED');
    expect(row!.brokerTicket).toBeNull();
    expect(row!.direction).toBeNull();
  });

  it('D. FLATTEN close ack + contradictory SAR position => RECOVERY_REQUIRED', async () => {
    await seedPendingConfirmation();
    const outcome = await reconciliationService().reconcile(freshInput({
      positions: [pos('99999999999', SAR_MAGIC)], // a DIFFERENT, unexpected ticket
    }));
    expect(outcome.resolved).toBe(false);
    expect(outcome.detail).toMatch(/contradictory/);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('RECOVERY_REQUIRED');
  });

  it('closeForDay refuses to resubmit a second FLATTEN while one is already pending confirmation', async () => {
    await seedPendingConfirmation();
    const result = await executionService(new QueueingFakeBroker2()).closeForDay(accountId, NOW);
    expect(result.action).toBe('BLOCKED');
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('DAILY_CLOSE_PENDING_CONFIRMATION'); // untouched, no duplicate submission
  });

  it('evaluateTick refuses to act while DAILY_CLOSE_PENDING_CONFIRMATION', async () => {
    await seedPendingConfirmation();
    const result = await executionService(new QueueingFakeBroker()).evaluateTick(
      accountId, { bid: 4500, ask: 4500.2, ageSeconds: 1, fresh: true }, NOW,
    );
    expect(result.action).toBe('BLOCKED');
  });
});

// 2026-09-25 HARDENING PASS — requirement 2: unclaimed-reversal
// observability. Purely informational; must never alter execution state.
describe('Hardening: unclaimed-reversal execution-delay alert', () => {
  async function seedUnclaimedReversalAt(ageSeconds: number) {
    const requestedAtMs = NOW - ageSeconds * 1000;
    await seedSession({ state: 'REVERSAL_UNKNOWN', unknownSince: new Date(requestedAtMs) });
    await prisma.xauusdSarCycle.create({
      data: { accountId, cycleId: 'cycle-1', direction: 'SELL', entryTicket: '58620919833', entryFillPrice: 4274.07, entryAt: new Date(requestedAtMs - 60000) },
    });
    await prisma.xauusdSarOrderAttempt.create({
      data: {
        accountId, cycleId: 'cycle-2', idempotencyTag: 'SARunclaimedDelay', kind: 'REVERSAL', direction: 'BUY',
        volume: 0.01, status: 'SENT', requestedAt: new Date(requestedAtMs), claimedAt: null,
      },
    });
  }

  it('E. unclaimed > warning threshold (10s) => exactly one DISTINCT alert (deduplicated by the notifier\'s own durable dedupKey), no state/order mutation', async () => {
    // The dedup guarantee lives in TelegramEngineNotificationService's own
    // durable, DB-backed unique constraint on dedupKey (confirmed by
    // reading notification.service.ts directly: deliverOne() catches the
    // unique-violation and treats it as "already recorded, and already
    // sent or queued for retry" -- a no-op, not an error). This code does
    // not (and must not) reimplement that dedup itself; it only needs to
    // ALWAYS pass the SAME dedupKey for the same attempt, so the real
    // notifier's own persistence collapses repeat calls into one actual
    // delivery. A naive test spy that doesn't replicate that persistence
    // would (correctly) see notify() invoked on every pass -- so this test
    // asserts the real invariant: identical dedupKey every time.
    const notified: unknown[] = [];
    const spyingNotifier = { notify: async (...args: unknown[]) => { notified.push(args); } } as never;
    await seedUnclaimedReversalAt(15); // > 10s threshold, < 30s reconciliation grace

    const svc = new SarReconciliationService(prisma as never, spyingNotifier);
    await svc.reconcile(freshInput({ positions: [pos('58620919833', SAR_MAGIC)] }));
    await svc.reconcile(freshInput({ positions: [pos('58620919833', SAR_MAGIC)], nowMs: NOW + 1000 }));

    const delayAlerts = notified.filter((args) => (args as unknown[])[0] === 'SAR_EXECUTION_DELAY');
    expect(delayAlerts.length).toBeGreaterThanOrEqual(1);
    const dedupKeys = new Set(delayAlerts.map((args) => (args as unknown[])[1]));
    expect(dedupKeys.size).toBe(1); // every call for this attempt shares the SAME dedupKey

    const attempt = await prisma.xauusdSarOrderAttempt.findUnique({ where: { idempotencyTag: 'SARunclaimedDelay' } });
    expect(attempt!.status).toBe('SENT'); // no state mutation from the alert itself
    expect(attempt!.claimedAt).toBeNull();
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('REVERSAL_UNKNOWN'); // unchanged (15s < 30s grace, still deferred)
  });

  it('E2. the REAL notifier (durable DB dedup, not a mock) delivers exactly ONE actual message across repeated reconciliation passes', async () => {
    const { TelegramEngineNotificationService } = await import('../../src/telegram-engine/notifications/notification.service');
    let fetchCalls = 0;
    const fakeFetch = (async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) } as Response;
    }) as typeof fetch;
    const realNotifier = new TelegramEngineNotificationService(
      prisma as never,
      { botToken: 'test-token', tradingChatIds: [], opsChatIds: [{ chatId: 'ops-1' }] } as never,
      fakeFetch,
    );
    await seedUnclaimedReversalAt(15);

    const svc = new SarReconciliationService(prisma as never, realNotifier);
    await svc.reconcile(freshInput({ positions: [pos('58620919833', SAR_MAGIC)] }));
    await svc.reconcile(freshInput({ positions: [pos('58620919833', SAR_MAGIC)], nowMs: NOW + 1000 }));
    await svc.reconcile(freshInput({ positions: [pos('58620919833', SAR_MAGIC)], nowMs: NOW + 2000 }));

    expect(fetchCalls).toBe(1); // real Telegram send happened exactly once across 3 passes
  });

  it('F. unclaimed < warning threshold (10s) => no alert', async () => {
    const notified: unknown[] = [];
    const spyingNotifier = { notify: async (...args: unknown[]) => { notified.push(args); } } as never;
    await seedUnclaimedReversalAt(5); // well under the 10s alert threshold

    const svc = new SarReconciliationService(prisma as never, spyingNotifier);
    await svc.reconcile(freshInput({ positions: [pos('58620919833', SAR_MAGIC)] }));

    const delayAlerts = notified.filter((args) => (args as unknown[])[0] === 'SAR_EXECUTION_DELAY');
    expect(delayAlerts).toHaveLength(0);
  });

  it('alert delivery failure never affects reconciliation — resolution proceeds normally', async () => {
    const throwingNotifier = { notify: async () => { throw new Error('telegram down'); } } as never;
    await seedUnclaimedReversalAt(15);

    const svc = new SarReconciliationService(prisma as never, throwingNotifier);
    const outcome = await svc.reconcile(freshInput({ positions: [pos('58620919833', SAR_MAGIC)] }));
    expect(outcome.resolved).toBe(false); // still correctly deferred (15s < 30s grace) -- no crash
  });
});
