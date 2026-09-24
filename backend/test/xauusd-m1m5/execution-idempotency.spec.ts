/** ENGINE A RETIRED: getM1M5ExecutionMode() is now hard-locked to OFF (see legacy-entries-disabled.ts), so tests below that require a real DEMO submission through M1M5ExecutionService are skipped rather than deleted -- xauusd-sar-v1 is Engine A now, and its own submission-path tests live under test/xauusd-sar/. */
/**
 * One crossing, at most one order attempt -- however fast and however often
 * anything evaluates it. Against a real database, with a simulated broker.
 *
 * The one-second execution pass means orders are now claimed and evaluated
 * every second instead of every ten. None of that may create a second order:
 *
 *   - the SAME crossing evaluated twice (a retried cycle, a restart mid-cycle,
 *     or concurrently) produces one decision and one broker attempt, because
 *     the crossing's identity is a unique constraint;
 *   - a DIFFERENT crossing on a timeframe that is already held -- pending,
 *     sent or UNKNOWN -- is skipped, because occupancy is an atomic row;
 *   - repeated or concurrent claims hand a queued order out once;
 *   - an UNKNOWN or pending submission keeps its slot until real broker state
 *     resolves it.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { M1M5DecisionQueueService } from '../../src/xauusd-m1m5/decision-queue.service';
import { describeLatency, executionLatency } from '../../src/xauusd-m1m5/execution-latency';
import {
  M1M5ExecutionService,
  type BrokerPort,
  type ExecutionContext,
  type SubmitResponse,
} from '../../src/xauusd-m1m5/execution.service';
import { M1M5OccupancyService } from '../../src/xauusd-m1m5/occupancy.service';
import type { CrossingSignal } from '../../src/xauusd-m1m5/crossing';
import type { Mt5PermissionSnapshot } from '../../src/xauusd-m1m5/mt5-readiness';
import type { Timeframe } from '../../src/xauusd-m1m5/spec';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
const occupancy = new M1M5OccupancyService(prisma);
const queue = new M1M5DecisionQueueService(prisma, occupancy);

// Wednesday 10:00 Beirut: inside the trading window, clear of both pauses.
const NOW = Date.UTC(2026, 8, 23, 7, 0, 0);
const LOGIN = '5050000001';

let accountId: string;
let seq = 0;
const savedEnv: Record<string, string | undefined> = {};

class CountingBroker implements BrokerPort {
  public calls = 0;
  constructor(private readonly response: SubmitResponse) {}
  async submit(): Promise<SubmitResponse> {
    this.calls += 1;
    return this.response;
  }
}

const QUEUED: SubmitResponse = { status: 'QUEUED' };
const UNKNOWN: SubmitResponse = { status: 'UNKNOWN', error: 'no response' };

function service(broker: BrokerPort) {
  return new M1M5ExecutionService(prisma, occupancy, broker);
}

function signal(timeframe: Timeframe, direction: 'SELL' | 'BUY' = 'SELL', signalId?: string): CrossingSignal {
  seq += 1;
  return {
    signalId: signalId ?? `${timeframe}:${direction}:${NOW}:${seq}`,
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

describe('the same crossing, evaluated more than once', () => {
  it.skip('produces ONE decision and ONE broker attempt when evaluated twice [Engine A retired]', async () => {
    const broker = new CountingBroker(QUEUED);
    const s = signal('M1');

    const first = await service(broker).execute(ctx(s));
    const second = await service(broker).execute(ctx(s));

    expect(first.outcome).toBe('QUEUED');
    expect(second.outcome).toBe('SKIPPED_DUPLICATE');
    expect(broker.calls).toBe(1);
    expect(await prisma.xauusdM1M5Decision.count({ where: { accountId } })).toBe(1);
  });

  it.skip('produces ONE broker attempt when evaluated concurrently [Engine A retired]', async () => {
    const broker = new CountingBroker(QUEUED);
    const s = signal('M1');

    const results = await Promise.all(Array.from({ length: 5 }, () => service(broker).execute(ctx(s))));

    expect(results.filter((r) => r.outcome === 'QUEUED')).toHaveLength(1);
    expect(broker.calls).toBe(1);
    expect(await prisma.xauusdM1M5Decision.count({ where: { accountId } })).toBe(1);
  });

  it.skip('records when the crossing was detected [Engine A retired]', async () => {
    const result = await service(new CountingBroker(QUEUED)).execute(ctx(signal('M1')));

    const row = await prisma.xauusdM1M5Decision.findUnique({ where: { id: result.decisionId! } });
    expect(row?.detectedAt?.getTime()).toBe(NOW);
  });
});

describe('a held timeframe', () => {
  it.skip('skips a NEW crossing while the first order is still pending [Engine A retired]', async () => {
    const broker = new CountingBroker(QUEUED);
    await service(broker).execute(ctx(signal('M1')));

    const second = await service(broker).execute(ctx(signal('M1')));

    expect(second.outcome).toBe('SKIPPED_OCCUPIED');
    expect(broker.calls).toBe(1);
  });

  it.skip('keeps the slot on an UNKNOWN submission, and skips the next crossing [Engine A retired]', async () => {
    // An UNKNOWN may be a live position. Freeing its slot would permit a
    // second position on a timeframe that may already hold one.
    const broker = new CountingBroker(UNKNOWN);
    await service(broker).execute(ctx(signal('M1')));

    expect((await occupancy.current(accountId, 'M1'))?.state).toBe('UNKNOWN');
    const next = await service(broker).execute(ctx(signal('M1')));

    expect(next.outcome).toBe('SKIPPED_OCCUPIED');
    expect(broker.calls).toBe(1);
    expect((await occupancy.current(accountId, 'M1'))?.state).toBe('UNKNOWN');
  });

  it.skip('leaves the other timeframe free: M1 and M5 are independent [Engine A retired]', async () => {
    const broker = new CountingBroker(QUEUED);
    await service(broker).execute(ctx(signal('M1')));

    const m5 = await service(broker).execute(ctx(signal('M5')));

    expect(m5.outcome).toBe('QUEUED');
    expect(broker.calls).toBe(2);
  });
});

describe('claiming, as the one-second pass does', () => {
  it.skip('hands a queued order out ONCE across ten concurrent claims [Engine A retired]', async () => {
    await service(new CountingBroker(QUEUED)).execute(ctx(signal('M1')));

    const claims = await Promise.all(Array.from({ length: 10 }, () => queue.claimOldest(accountId, NOW)));

    expect(claims.filter((c) => c !== null)).toHaveLength(1);
  });

  it.skip('hands it out once across repeated sequential claims [Engine A retired]', async () => {
    await service(new CountingBroker(QUEUED)).execute(ctx(signal('M1')));

    const claims = [];
    for (let i = 0; i < 10; i += 1) claims.push(await queue.claimOldest(accountId, NOW + i * 1000));

    expect(claims.filter((c) => c !== null)).toHaveLength(1);
  });

  it.skip('never re-offers an UNKNOWN submission, so it is never attempted twice [Engine A retired]', async () => {
    const queued = await service(new CountingBroker(QUEUED)).execute(ctx(signal('M1')));
    await queue.claimOldest(accountId, NOW);
    await queue.recordResult(queued.decisionId!, {
      ok: false, ticket: null, filledPrice: null, brokerStopLoss: null, brokerTakeProfit: null,
      errorMessage: 'no response', uncertain: true,
    });

    for (let i = 1; i <= 5; i += 1) {
      expect(await queue.claimOldest(accountId, NOW + i * 1000)).toBeNull();
    }
    expect((await occupancy.current(accountId, 'M1'))?.state).toBe('UNKNOWN');
  });

  it.skip('cancels, rather than sends, a signal that aged past the limit before it was claimed [Engine A retired]', async () => {
    const queued = await service(new CountingBroker(QUEUED)).execute(ctx(signal('M1')));

    // The collector was down; it is claimed 90s after the crossing.
    const claimed = await queue.claimOldest(accountId, NOW + 90_000);

    expect(claimed).toBeNull();
    const row = await prisma.xauusdM1M5Decision.findUnique({ where: { id: queued.decisionId! } });
    expect(row?.orderStatus).toBe('NONE');
    expect(row?.skipReason).toContain('old');
    expect(await occupancy.current(accountId, 'M1')).toBeNull();
  });
});

describe("recording the collector's result", () => {
  async function claimedOrder() {
    const queued = await service(new CountingBroker(QUEUED)).execute(ctx(signal('M1')));
    await queue.claimOldest(accountId, NOW);
    return queued.decisionId!;
  }

  it.skip('cancels a NOT-SENT order and frees the slot, without calling it a broker failure [Engine A retired]', async () => {
    const id = await claimedOrder();

    const outcome = await queue.recordResult(id, {
      ok: false, ticket: null, filledPrice: null, brokerStopLoss: null, brokerTakeProfit: null,
      errorMessage: 'price has moved 150 points', uncertain: false, notSent: true,
      executionEvaluatedAt: new Date(NOW + 400),
    });

    expect(outcome).toBe('NOT_SENT');
    const row = await prisma.xauusdM1M5Decision.findUnique({ where: { id } });
    expect(row?.orderStatus).toBe('NONE');
    expect(row?.skipReason).toContain('150 points');
    expect(await occupancy.current(accountId, 'M1')).toBeNull();
  });

  it.skip('never treats an UNCERTAIN result as not-sent, even if both flags arrive [Engine A retired]', async () => {
    // A contradictory report must resolve in the SAFE direction: held.
    const id = await claimedOrder();

    const outcome = await queue.recordResult(id, {
      ok: false, ticket: null, filledPrice: null, brokerStopLoss: null, brokerTakeProfit: null,
      errorMessage: 'confused', uncertain: true, notSent: true,
    });

    expect(outcome).toBe('UNKNOWN');
    expect((await occupancy.current(accountId, 'M1'))?.state).toBe('UNKNOWN');
  });

  it.skip('stores the full execution timeline, and dates the fill from the acknowledgement [Engine A retired]', async () => {
    const id = await claimedOrder();
    const evaluated = new Date(NOW + 800);
    const submitted = new Date(NOW + 850);
    const acknowledged = new Date(NOW + 1_150);

    await queue.recordResult(id, {
      ok: true, ticket: '58566028247', filledPrice: 4449.9, brokerStopLoss: 4455, brokerTakeProfit: 4445,
      errorMessage: null, uncertain: false,
      executionEvaluatedAt: evaluated, submittedAt: submitted, acknowledgedAt: acknowledged,
    });

    const row = await prisma.xauusdM1M5Decision.findUnique({ where: { id } });
    expect(row?.executionEvaluatedAt?.getTime()).toBe(evaluated.getTime());
    expect(row?.submittedAt?.getTime()).toBe(submitted.getTime());
    expect(row?.acknowledgedAt?.getTime()).toBe(acknowledged.getTime());
    expect(row?.filledAt?.getTime()).toBe(acknowledged.getTime());

    // Detected at NOW: 850ms ours, 300ms the broker's, 1.15s in total.
    expect(executionLatency(row!)).toEqual({
      detectionToSubmissionMs: 850,
      submissionToFillMs: 300,
      signalToFillMs: 1_150,
    });
  });
});

describe('executionLatency', () => {
  it('reports unknown rather than a figure built from a missing instant', () => {
    const l = executionLatency({
      detectedAt: new Date(NOW),
      executionEvaluatedAt: null,
      submittedAt: null,
      acknowledgedAt: null,
    });
    expect(l).toEqual({ detectionToSubmissionMs: null, submissionToFillMs: null, signalToFillMs: null });
    expect(describeLatency(l)).toContain('unknown');
  });

  it("labels our share and the broker's share separately", () => {
    const line = describeLatency({ detectionToSubmissionMs: 850, submissionToFillMs: 300, signalToFillMs: 1_150 });
    expect(line).toBe('Latency: signal->submit 0.85s (ours), submit->fill 0.30s (broker), total 1.15s');
  });
});
