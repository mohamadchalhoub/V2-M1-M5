/**
 * The SAR execution watchdog (defense-in-depth, not a second engine).
 *
 * Every test here proves one of the explicit invariants demanded after the
 * two live losses on 2026-09-24: the watchdog calls the SAME `evaluateTick`
 * the normal scheduler calls, so "at most one broker reversal attempt" is
 * never a separate mechanism to get right — it falls out of the existing
 * atomic claim these tests exercise directly.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SarExecutionService, type SarBrokerPort, type SarSubmitRequest, type SarSubmitResponse } from '../../src/xauusd-sar/execution.service';
import { setSarVolume } from '../../src/xauusd-sar/volume-setting';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
let accountId: string;

const SESSION_START = Date.UTC(2026, 8, 23, 22, 0);

class FakeBroker implements SarBrokerPort {
  public readonly calls: SarSubmitRequest[] = [];
  private ticketSeq = 900000;
  async submit(request: SarSubmitRequest): Promise<SarSubmitResponse> {
    this.calls.push(request);
    this.ticketSeq += 1;
    const fillPrice = request.direction === 'BUY' ? 4500.5 : 4499.5;
    return { status: 'FILLED', ticket: String(this.ticketSeq), fillPrice };
  }
}

function service(broker: SarBrokerPort) {
  return new SarExecutionService(prisma as never, broker);
}

async function activeBuy(broker: SarBrokerPort) {
  const svc = service(broker);
  await svc.ensureSession(accountId, SESSION_START);
  await svc.initializeSession(accountId, { bid: 4500, ask: 4500.2, ageSeconds: 1, fresh: true }, SESSION_START);
  // ASK crosses the BUY trigger (4500.1 + 0.5 = 4500.6).
  await svc.evaluateTick(accountId, { bid: 4500.4, ask: 4500.6, ageSeconds: 1, fresh: true }, SESSION_START + 1000);
  return svc;
}

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
  await setSarVolume(prisma, { accountId, lots: 0.5, changedBy: 'test' });
  process.env.XAUUSD_SAR_ENABLED = 'true';
  process.env.XAUUSD_SAR_EXECUTION_MODE = 'DEMO';
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the watchdog stands down while the normal evaluator is fresh', () => {
  it('does nothing at all -- no evaluation, no broker call -- when lastEvaluatedAt is recent', async () => {
    const broker = new FakeBroker();
    await activeBuy(broker);
    // Fill entry BUY @ 4500.5. Reversal level = 4500.5 - 0.5 = 4500.0.
    // A tick sets lastEvaluatedAt to the entry instant.
    await service(broker).evaluateTick(accountId, { bid: 4500.5, ask: 4500.7, ageSeconds: 1, fresh: true }, SESSION_START + 1500);
    const callsBeforeWatchdog = broker.calls.length;

    // Quote crosses the reversal level, but only 2s have passed -- well
    // under the 8s threshold.
    const result = await service(broker).watchdogCheck(accountId, { bid: 4499.9, ask: 4500.1, ageSeconds: 1, fresh: true }, SESSION_START + 3500);

    expect(result.watchdogActed).toBe(false);
    expect(result.action).toBe('NONE');
    expect(broker.calls).toHaveLength(callsBeforeWatchdog);
  });
});

describe('the watchdog acts when the normal evaluator has gone stale', () => {
  it('initiates the reversal itself once the threshold is crossed and the evaluator is stale', async () => {
    const broker = new FakeBroker();
    await activeBuy(broker); // entry BUY @ 4500.5, lastEvaluatedAt still null (no trailing tick yet)
    const callsBeforeWatchdog = broker.calls.length;

    // 30s later -- comfortably past the 8s threshold -- with a quote that
    // has crossed the reversal level (4500.5 - 0.5 = 4500.0).
    const result = await service(broker).watchdogCheck(accountId, { bid: 4499.9, ask: 4500.1, ageSeconds: 1, fresh: true }, SESSION_START + 31_000);

    expect(result.watchdogActed).toBe(true);
    expect(result.action).toBe('REVERSAL_SUBMITTED');
    expect(broker.calls).toHaveLength(callsBeforeWatchdog + 1);
    expect(broker.calls[broker.calls.length - 1].direction).toBe('SELL');

    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('ACTIVE_SELL');
  });

  it('never trades when the threshold has not been crossed, even while stale', async () => {
    const broker = new FakeBroker();
    await activeBuy(broker);
    const callsBefore = broker.calls.length;

    // Still above the reversal level (4500.0) -- no crossing.
    const result = await service(broker).watchdogCheck(accountId, { bid: 4500.2, ask: 4500.4, ageSeconds: 1, fresh: true }, SESSION_START + 31_000);

    expect(result.action).toBe('NONE');
    expect(broker.calls).toHaveLength(callsBefore);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('ACTIVE_BUY');
  });

  it('does not guess from a stale quote, even when the evaluator itself is stale', async () => {
    const broker = new FakeBroker();
    await activeBuy(broker);
    const callsBefore = broker.calls.length;

    const result = await service(broker).watchdogCheck(accountId, { bid: 4499.9, ask: 4500.1, ageSeconds: 45, fresh: false }, SESSION_START + 31_000);

    expect(result.watchdogActed).toBe(false);
    expect(result.action).toBe('NONE');
    expect(broker.calls).toHaveLength(callsBefore);
  });

  it('has nothing to watch outside ACTIVE_BUY/ACTIVE_SELL (e.g. mid-UNKNOWN, or before any position)', async () => {
    const svc = service(new FakeBroker());
    await svc.ensureSession(accountId, SESSION_START);
    const result = await svc.watchdogCheck(accountId, { bid: 4500, ask: 4500.2, ageSeconds: 1, fresh: true }, SESSION_START);
    expect(result.watchdogActed).toBe(false);
    expect(result.action).toBe('NONE');
  });
});

describe('the hard invariant: at most one broker reversal attempt however this races', () => {
  it('produces exactly one reversal when the normal evaluator and the watchdog are both invoked for the same crossing', async () => {
    // A broker whose reversal fill lands far from the crossing quote, so
    // this test is deterministic regardless of exactly how the two calls
    // interleave: if the SECOND caller loses the atomic claim outright, it
    // gets 0 rows and does nothing; if instead it runs against the
    // ALREADY-reversed fresh cycle, that cycle's own reversal level (set
    // far from this quote) means it correctly finds nothing to do either
    // way. Either path proves the same invariant -- exactly one broker call.
    class FarFillBroker implements SarBrokerPort {
      public readonly calls: SarSubmitRequest[] = [];
      private ticketSeq = 900000;
      async submit(request: SarSubmitRequest): Promise<SarSubmitResponse> {
        this.calls.push(request);
        this.ticketSeq += 1;
        const fillPrice = request.direction === 'BUY' ? 4500.5 : 4490.0;
        return { status: 'FILLED', ticket: String(this.ticketSeq), fillPrice };
      }
    }
    const broker = new FarFillBroker();
    await activeBuy(broker); // entry BUY @ 4500.5, reversal level 4500.0, lastEvaluatedAt null
    const callsBefore = broker.calls.length;
    const crossingQuote = { bid: 4499.9, ask: 4500.1, ageSeconds: 1, fresh: true };

    // True concurrency: both callers race the SAME atomic claim.
    const [normal, watchdog] = await Promise.all([
      service(broker).evaluateTick(accountId, crossingQuote, SESSION_START + 31_000),
      service(broker).watchdogCheck(accountId, crossingQuote, SESSION_START + 31_000),
    ]);

    const submittedCount = [normal.action, watchdog.action].filter((a) => a === 'REVERSAL_SUBMITTED').length;
    expect(submittedCount).toBe(1);
    expect(broker.calls).toHaveLength(callsBefore + 1);

    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('ACTIVE_SELL');
  });

  it('the watchdog does nothing once the normal evaluator has already claimed the same reversal', async () => {
    const broker = new FakeBroker();
    await activeBuy(broker);
    const crossingQuote = { bid: 4499.9, ask: 4500.1, ageSeconds: 1, fresh: true };

    const normal = await service(broker).evaluateTick(accountId, crossingQuote, SESSION_START + 31_000);
    expect(normal.action).toBe('REVERSAL_SUBMITTED');
    const callsAfterNormal = broker.calls.length;

    // The watchdog fires next tick with the same stale-looking timestamp;
    // the session has already moved to ACTIVE_SELL with a fresh cycle, so
    // there is nothing left for it to claim at the old level.
    const watchdog = await service(broker).watchdogCheck(accountId, crossingQuote, SESSION_START + 31_100);
    expect(watchdog.action).not.toBe('REVERSAL_SUBMITTED');
    expect(broker.calls).toHaveLength(callsAfterNormal);
  });
});
