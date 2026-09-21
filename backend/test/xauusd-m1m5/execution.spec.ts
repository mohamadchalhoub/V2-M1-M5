/**
 * §15.6 — execution against a SIMULATED broker, with a real database.
 *
 * Simulated-broker integration tests, not unit tests and not runtime
 * verification: the database constraints and the ordering are real, the
 * broker is not. Nothing here places an order anywhere.
 *
 * The cases that matter are the ones where the broker misbehaves — refuses,
 * throws, or answers ambiguously — because those are what decide whether a
 * timeframe slot is correctly held or wrongly freed.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { M1M5ExecutionService, type BrokerPort, type ExecutionContext, type SubmitResponse } from '../../src/xauusd-m1m5/execution.service';
import { M1M5OccupancyService } from '../../src/xauusd-m1m5/occupancy.service';
import type { CrossingSignal } from '../../src/xauusd-m1m5/crossing';
import type { Mt5PermissionSnapshot } from '../../src/xauusd-m1m5/mt5-readiness';
import { V2_MAGIC_M1, V2_MAGIC_M5 } from '../../src/xauusd-m1m5/safety-constants';
import type { Timeframe } from '../../src/xauusd-m1m5/spec';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
const occupancy = new M1M5OccupancyService(prisma);

const NOW = Date.UTC(2026, 8, 23, 7, 0, 0);
const LOGIN = '5050000001';

let accountId: string;
let seq = 0;
const savedEnv: Record<string, string | undefined> = {};

class FakeBroker implements BrokerPort {
  public calls = 0;
  constructor(private readonly response: SubmitResponse | (() => never)) {}
  async submit(): Promise<SubmitResponse> {
    this.calls += 1;
    if (typeof this.response === 'function') this.response();
    return this.response;
  }
}

function service(broker: BrokerPort) {
  return new M1M5ExecutionService(prisma, occupancy, broker);
}

function signal(timeframe: Timeframe, direction: 'SELL' | 'BUY' = 'SELL'): CrossingSignal {
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

const READY_SNAPSHOT: Mt5PermissionSnapshot = {
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

function ctx(over: Partial<ExecutionContext> & { signal: CrossingSignal }): ExecutionContext {
  return {
    accountId,
    nowMs: NOW,
    freshQuote: { bid: 4450, ask: 4450.2, tickAtMs: NOW - 500 },
    constraints: { pointSize: 0.01, stopLevelPoints: 0, freezeLevelPoints: 0, tickSize: 0.01 },
    account: { equity: 10_000, freeMargin: 9_000, dayLoss: 0, drawdown: 0 },
    committed: [],
    marginRequired: 500,
    stopRisk: 40,
    mt5Snapshot: READY_SNAPSHOT,
    expectedLoginId: LOGIN,
    scheduleAllowsEntries: true,
    scheduleDetail: 'Clock permits new entries.',
    configuredVolume: 0.5,
    ...over,
  };
}

beforeEach(async () => {
  await resetDatabase(prisma);
  const user = await createUser(prisma);
  const account = await createTradingAccount(prisma, user.id);
  accountId = account.id;
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

const FILLED: SubmitResponse = {
  status: 'FILLED',
  ticket: '900001',
  fillPrice: 4450,
  brokerStopLoss: 4455,
  brokerTakeProfit: 4445,
};

describe('§7 the happy path', () => {
  it('submits, records the fill, and holds the timeframe', async () => {
    const broker = new FakeBroker(FILLED);
    const result = await service(broker).execute(ctx({ signal: signal('M1') }));

    expect(result.outcome).toBe('SUBMITTED');
    expect(broker.calls).toBe(1);

    const row = await prisma.xauusdM1M5Decision.findUnique({ where: { id: result.decisionId! } });
    expect(row).toMatchObject({ orderStatus: 'FILLED', approved: true, magicNumber: V2_MAGIC_M1 });
    expect(Number(row?.volumeLots)).toBe(0.5);
    expect(Number(row?.stopLoss)).toBe(4455);
    expect(Number(row?.takeProfit)).toBe(4445);
    expect(String(row?.ticket)).toBe('900001');

    expect(await occupancy.current(accountId, 'M1')).toMatchObject({ state: 'FILLED' });
  });

  it('stamps the correct magic number per timeframe', async () => {
    const m1 = await service(new FakeBroker(FILLED)).execute(ctx({ signal: signal('M1') }));
    const m5 = await service(new FakeBroker(FILLED)).execute(ctx({ signal: signal('M5') }));

    const rowM1 = await prisma.xauusdM1M5Decision.findUnique({ where: { id: m1.decisionId! } });
    const rowM5 = await prisma.xauusdM1M5Decision.findUnique({ where: { id: m5.decisionId! } });
    expect(rowM1?.magicNumber).toBe(V2_MAGIC_M1);
    expect(rowM5?.magicNumber).toBe(V2_MAGIC_M5);
  });

  it('allows M1 and M5 to hold positions simultaneously', async () => {
    await service(new FakeBroker(FILLED)).execute(ctx({ signal: signal('M1', 'SELL') }));
    await service(new FakeBroker(FILLED)).execute(ctx({ signal: signal('M5', 'BUY') }));

    expect(await occupancy.current(accountId, 'M1')).not.toBeNull();
    expect(await occupancy.current(accountId, 'M5')).not.toBeNull();
  });
});

describe('§4/§7 an ambiguous broker response holds the slot', () => {
  it('an UNKNOWN response keeps the timeframe occupied', async () => {
    const result = await service(new FakeBroker({ status: 'UNKNOWN', error: 'response lost' })).execute(
      ctx({ signal: signal('M1') }),
    );
    expect(result.outcome).toBe('SUBMITTED');

    const row = await prisma.xauusdM1M5Decision.findUnique({ where: { id: result.decisionId! } });
    expect(row?.orderStatus).toBe('UNKNOWN');
    // Held, because it may already be a live position.
    expect(await occupancy.current(accountId, 'M1')).toMatchObject({ state: 'UNKNOWN' });

    // And a second signal on that timeframe cannot get in.
    const second = await service(new FakeBroker(FILLED)).execute(ctx({ signal: signal('M1') }));
    expect(second.outcome).toBe('SKIPPED_OCCUPIED');
  });

  it('a thrown error is recorded as UNKNOWN, never as a failure', async () => {
    const broker = new FakeBroker((() => {
      throw new Error('socket hang up');
    }) as unknown as () => never);
    const result = await service(broker).execute(ctx({ signal: signal('M5') }));

    const row = await prisma.xauusdM1M5Decision.findUnique({ where: { id: result.decisionId! } });
    expect(row?.orderStatus).toBe('UNKNOWN');
    expect(row?.failureReason).toContain('socket hang up');
    expect(await occupancy.current(accountId, 'M5')).toMatchObject({ state: 'UNKNOWN' });
  });

  it('a broker-confirmed FAILED releases the slot, because nothing was opened', async () => {
    const result = await service(new FakeBroker({ status: 'FAILED', error: 'invalid stops' })).execute(
      ctx({ signal: signal('M1') }),
    );
    const row = await prisma.xauusdM1M5Decision.findUnique({ where: { id: result.decisionId! } });
    expect(row?.orderStatus).toBe('FAILED');
    expect(await occupancy.current(accountId, 'M1')).toBeNull();
  });
});

describe('§8 MT5 readiness gates submission', () => {
  it('refuses when no MT5 snapshot exists, and writes no decision', async () => {
    const broker = new FakeBroker(FILLED);
    const result = await service(broker).execute(ctx({ signal: signal('M1'), mt5Snapshot: null }));
    expect(result.outcome).toBe('REFUSED_MT5_NOT_READY');
    expect(broker.calls).toBe(0);
    expect(await prisma.xauusdM1M5Decision.count()).toBe(0);
  });

  it('refuses a netting account, because hedging is structural here', async () => {
    const broker = new FakeBroker(FILLED);
    const result = await service(broker).execute(
      ctx({ signal: signal('M1'), mt5Snapshot: { ...READY_SNAPSHOT, marginMode: 'RETAIL_NETTING' } }),
    );
    expect(result.outcome).toBe('REFUSED_MT5_NOT_READY');
    expect(result.detail).toContain('HEDGING_UNSUPPORTED');
    expect(broker.calls).toBe(0);
  });

  it('refuses when the terminal holds a different account', async () => {
    const broker = new FakeBroker(FILLED);
    const result = await service(broker).execute(
      ctx({ signal: signal('M1'), mt5Snapshot: { ...READY_SNAPSHOT, loginId: '9999999999' } }),
    );
    expect(result.detail).toContain('ACCOUNT_IDENTITY_MISMATCH');
    expect(broker.calls).toBe(0);
  });

  it('refuses a non-DEMO account', async () => {
    const broker = new FakeBroker(FILLED);
    const result = await service(broker).execute(
      ctx({ signal: signal('M1'), mt5Snapshot: { ...READY_SNAPSHOT, tradeMode: 'REAL' } }),
    );
    expect(result.detail).toContain('NOT_DEMO');
    expect(broker.calls).toBe(0);
  });
});

describe('§7 risk and pre-send gates', () => {
  it('records a risk refusal as a decision, and never calls the broker', async () => {
    const broker = new FakeBroker(FILLED);
    const result = await service(broker).execute(ctx({ signal: signal('M1'), stopRisk: 60 }));

    expect(result.outcome).toBe('REFUSED_RISK');
    expect(broker.calls).toBe(0);
    const row = await prisma.xauusdM1M5Decision.findUnique({ where: { id: result.decisionId! } });
    // The audit trail records the refusal, not just the submissions.
    expect(row?.approved).toBe(false);
    expect(row?.skipReason).toBe('STOP_RISK_CAP');
    expect(await occupancy.current(accountId, 'M1')).toBeNull();
  });

  it('includes the other timeframe in the combined cap', async () => {
    const broker = new FakeBroker(FILLED);
    const result = await service(broker).execute(
      ctx({ signal: signal('M1'), stopRisk: 45, committed: [{ timeframe: 'M5', stopRisk: 60, reserved: false }] }),
    );
    expect(result.outcome).toBe('REFUSED_RISK');
    expect(result.detail).toContain('Combined stop risk');
  });

  it('a Friday cutoff crossed after the decision cancels at pre-send and frees the slot', async () => {
    const broker = new FakeBroker(FILLED);
    const result = await service(broker).execute(
      ctx({
        signal: signal('M1'),
        scheduleAllowsEntries: false,
        scheduleDetail: 'Friday entry cutoff reached (23:00 Beirut).',
      }),
    );
    expect(result.outcome).toBe('REFUSED_PRE_SEND');
    expect(broker.calls).toBe(0);
    // Never sent, so the slot is genuinely free.
    expect(await occupancy.current(accountId, 'M1')).toBeNull();
  });

  it('a kill switch engaged after the decision stops the send', async () => {
    process.env.XAUUSD_M1M5_KILL_SWITCH = 'true';
    const broker = new FakeBroker(FILLED);
    const result = await service(broker).execute(ctx({ signal: signal('M1') }));
    expect(result.outcome).toBe('REFUSED_PRE_SEND');
    expect(broker.calls).toBe(0);
  });

  it('refuses a stale signal rather than submitting it late', async () => {
    const broker = new FakeBroker(FILLED);
    const s = signal('M1');
    const result = await service(broker).execute(
      ctx({ signal: { ...s, observedAt: NOW - 120_000 } }),
    );
    expect(result.outcome).toBe('REFUSED_PRE_SEND');
    expect(result.detail).toMatch(/no longer the event the rules described/i);
  });
});

describe('§8 no per-trade approval exists', () => {
  it('SHADOW runs every gate and submits nothing', async () => {
    process.env.XAUUSD_M1M5_EXECUTION_MODE = 'SHADOW';
    const broker = new FakeBroker(FILLED);
    const result = await service(broker).execute(ctx({ signal: signal('M1') }));

    expect(result.outcome).toBe('NOT_SUBMITTING_MODE');
    expect(broker.calls).toBe(0);
    // The decision is still recorded, so a shadow run is auditable.
    expect(await prisma.xauusdM1M5Decision.count()).toBe(1);
    expect(await occupancy.current(accountId, 'M1')).toBeNull();
  });

  it('OFF submits nothing', async () => {
    process.env.XAUUSD_M1M5_EXECUTION_MODE = 'OFF';
    const broker = new FakeBroker(FILLED);
    const result = await service(broker).execute(ctx({ signal: signal('M1') }));
    expect(result.outcome).toBe('NOT_SUBMITTING_MODE');
    expect(broker.calls).toBe(0);
  });

  it('DEMO submits with no approval step in between', async () => {
    // The point of this test is the ABSENCE of a gate: a signal that passes
    // the deterministic checks reaches the broker with nothing asked of a
    // human, an AI, Telegram or the dashboard.
    const broker = new FakeBroker(FILLED);
    const result = await service(broker).execute(ctx({ signal: signal('M1') }));
    expect(result.outcome).toBe('SUBMITTED');
    expect(broker.calls).toBe(1);
  });
});

describe('§12 the decision row is the audit trail', () => {
  it('records the evidence a later reader needs', async () => {
    const result = await service(new FakeBroker(FILLED)).execute(ctx({ signal: signal('M1') }));
    const row = await prisma.xauusdM1M5Decision.findUnique({ where: { id: result.decisionId! } });
    const evidence = row?.evidence as Record<string, any>;

    expect(evidence.signal.rsi).toBe(92);
    expect(evidence.signal.previousRsi).toBe(90);
    expect(evidence.signal.threshold).toBe(91);
    expect(evidence.volume.lots).toBe(0.5);
    expect(evidence.volume.provenance).toBeTruthy();
    expect(evidence.brackets.stopLossDistance).toBe(5);
    expect(evidence.mt5.hedgingSupported).toBe(true);
    expect(evidence.executionMode).toBe('DEMO');
    expect(Number(row?.rsiValue)).toBe(92);
  });

  it('a replayed signal id cannot create a second decision', async () => {
    const s = signal('M1');
    const first = await service(new FakeBroker(FILLED)).execute(ctx({ signal: s }));
    expect(first.outcome).toBe('SUBMITTED');

    // The unique constraint on (accountId, strategyVersion, eventId) is what
    // makes replay impossible, so this throws rather than duplicating.
    await expect(service(new FakeBroker(FILLED)).execute(ctx({ signal: s }))).rejects.toThrow();
    expect(await prisma.xauusdM1M5Decision.count()).toBe(1);
  });
});
