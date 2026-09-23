/**
 * Engine B end to end, against a SIMULATED broker and a REAL database.
 *
 * The database is real because the guarantees under test are database
 * guarantees: the unique source key is what survives a restart, and the group
 * lock's primary key is what serialises two workers. Asserting either against
 * a mock would prove nothing about the thing that actually protects the
 * account.
 *
 * The broker is simulated because nothing here may place an order anywhere.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TelegramEngineExecutionService,
  type TelegramBrokerPort,
  type TelegramExecutionContext,
  type TelegramSubmitRequest,
  type TelegramSubmitResponse,
} from '../../src/telegram-engine/execution.service';
import type { TelegramSourceMessage } from '../../src/telegram-engine/ingestion.port';
import type { Mt5PermissionSnapshot } from '../../src/xauusd-m1m5/mt5-readiness';
import { TELEGRAM_MAGIC } from '../../src/telegram-engine/safety-constants';
import { TELEGRAM_SPEC } from '../../src/telegram-engine/spec';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();

/**
 * 16:00 Beirut on a Wednesday — deliberately inside Engine A's afternoon
 * pause, so every passing case below is also a statement that Engine B does
 * not observe it.
 */
const NOW = Date.UTC(2026, 8, 23, 13, 0, 0);
const LOGIN = '5050000001';

let accountId: string;
let seq = 0;
const savedEnv: Record<string, string | undefined> = {};

class FakeBroker implements TelegramBrokerPort {
  public readonly calls: TelegramSubmitRequest[] = [];
  constructor(private readonly response: TelegramSubmitResponse = { status: 'QUEUED' }) {}
  async submit(request: TelegramSubmitRequest): Promise<TelegramSubmitResponse> {
    this.calls.push(request);
    return this.response;
  }
}

/**
 * The service with a controllable clock. The leg loop reads the time again
 * immediately before submission, and this is what lets a test put the
 * submission itself past the lifetime while the signal-level check passed.
 */
class TestService extends TelegramEngineExecutionService {
  public clock: number = NOW;
  protected override now(): number {
    return this.clock;
  }
}

function service(broker: TelegramBrokerPort): TestService {
  return new TestService(prisma, broker);
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

// Still called SELL_TWO_TP: the message itself publishes two targets, which
// is exactly the case this engine now collapses to one leg, at TP1 (4329).
// TP2 (4300) is parsed and stored but never becomes a broker order.
const SELL_TWO_TP = ['Gold sell now 4338', 'SL 4348', 'TP 4329', 'TP 4300'].join('\n');

/** Builds a multi-line message body, matching the channel's real layout. */
function lines(...parts: string[]): string {
  return parts.join('\n');
}

function message(over: Partial<TelegramSourceMessage> = {}): TelegramSourceMessage {
  seq += 1;
  return {
    channelId: '-1001234567890',
    channelUsername: 'SFxauusd1',
    messageId: String(seq),
    text: SELL_TWO_TP,
    publishedAtMs: NOW - 5_000,
    receivedAtMs: NOW - 4_000,
    ...over,
  };
}

function ctx(over: Partial<TelegramExecutionContext> = {}): TelegramExecutionContext {
  return {
    accountId,
    nowMs: NOW,
    snapshot: READY_SNAPSHOT,
    expectedLoginId: LOGIN,
    symbolSessionOpen: true,
    symbolTradable: true,
    quote: { bid: 4338.0, ask: 4338.3, tickAtMs: NOW - 500 },
    constraints: { pointSize: 0.01, stopLevelPoints: 0, freezeLevelPoints: 0, tickSize: 0.01 },
    contractSize: 100,
    leverage: 100,
    freeMargin: 9_000,
    recoveryComplete: true,
    ...over,
  };
}

beforeEach(async () => {
  await resetDatabase(prisma);
  const user = await createUser(prisma);
  const account = await createTradingAccount(prisma, user.id);
  accountId = account.id;
  for (const k of [
    'TELEGRAM_ENGINE_EXECUTION_MODE',
    'TELEGRAM_ENGINE_ENABLED',
    'TELEGRAM_ENGINE_KILL_SWITCH',
    'V2_GLOBAL_KILL_SWITCH',
  ]) {
    savedEnv[k] = process.env[k];
  }
  process.env.TELEGRAM_ENGINE_EXECUTION_MODE = 'DEMO';
  // Both are required for a leg to reach the broker: the mode says HOW and
  // the switch says WHETHER. Engine B does not trade because it was
  // deployed, so the switch defaults off and a test must opt in.
  process.env.TELEGRAM_ENGINE_ENABLED = 'true';
  delete process.env.TELEGRAM_ENGINE_KILL_SWITCH;
  delete process.env.V2_GLOBAL_KILL_SWITCH;
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

describe('a valid fresh signal, published inside Engine A’s 14:00–19:00 pause', () => {
  it('submits exactly one leg, regardless of how many targets were published', async () => {
    const broker = new FakeBroker();
    const result = await service(broker).process(message(), ctx());

    expect(result.outcome).toBe('SUBMITTED');
    expect(result.legsSubmitted).toBe(1);
    expect(broker.calls).toHaveLength(1);
  });

  it('sends 0.01 lot, with the source stop and TP1 (not the farther published target)', async () => {
    const broker = new FakeBroker();
    await service(broker).process(message(), ctx());

    expect(broker.calls.map((c) => c.volumeLots)).toEqual([0.01]);
    expect(broker.calls.map((c) => c.stopLoss)).toEqual([4348]);
    expect(broker.calls.map((c) => c.takeProfit)).toEqual([4329]);
    expect(broker.calls.map((c) => c.direction)).toEqual(['SELL']);
  });

  it('stamps the leg with the Telegram magic number', async () => {
    const broker = new FakeBroker();
    await service(broker).process(message(), ctx());
    expect(broker.calls.map((c) => c.magicNumber)).toEqual([TELEGRAM_MAGIC]);
  });

  it('records the single leg as one signal group, numbered 1', async () => {
    const broker = new FakeBroker();
    const result = await service(broker).process(message(), ctx());

    const legs = await prisma.telegramSignalLeg.findMany({
      where: { signalId: result.signalId! },
      orderBy: { legIndex: 'asc' },
    });
    expect(legs.map((l) => l.legIndex)).toEqual([1]);
    expect(legs.every((l) => l.orderStatus === 'PENDING')).toBe(true);
  });

  it('records the age at which the leg was submitted, as evidence the lifetime was re-checked', async () => {
    const result = await service(new FakeBroker()).process(message(), ctx());
    const legs = await prisma.telegramSignalLeg.findMany({ where: { signalId: result.signalId! } });
    expect(legs.every((l) => l.ageAtSubmissionMs !== null)).toBe(true);
  });
});

describe('the 1-hour lifetime', () => {
  it('refuses a signal already past its lifetime, and opens nothing', async () => {
    const broker = new FakeBroker();
    const result = await service(broker).process(
      message({ publishedAtMs: NOW - (TELEGRAM_SPEC.maxSignalAgeMs + 90_000) }),
      ctx(),
    );

    expect(result.outcome).toBe('TELEGRAM_SIGNAL_EXPIRED');
    expect(broker.calls).toHaveLength(0);
  });

  it('refuses the leg if the clock crosses the lifetime between the signal-level check and submission', async () => {
    // The signal-level check (step 5) uses ctx.nowMs; the per-leg check
    // (step 9) uses this.now(), re-read immediately before the broker call.
    // Publishing just inside the lifetime by ctx.nowMs but past it by the
    // service's own clock reproduces a round trip that took just long
    // enough to matter, without needing a second leg to demonstrate it.
    const broker = new FakeBroker();
    const svc = service(broker);
    const publishedAtMs = NOW - (TELEGRAM_SPEC.maxSignalAgeMs - 2_000);
    svc.clock = NOW + 5_000; // this.now() already past the lifetime

    const result = await svc.process(message({ publishedAtMs }), ctx());

    expect(result.legsSubmitted).toBe(0);
    expect(broker.calls).toHaveLength(0);
    const legs = await prisma.telegramSignalLeg.findMany({
      where: { signalId: result.signalId! },
      orderBy: { legIndex: 'asc' },
    });
    expect(legs[0].orderStatus).toBe('SKIPPED');
    expect(legs[0].skipReason).toBe('TELEGRAM_SIGNAL_EXPIRED');
  });

  it('refuses a signal whose publication time the transport could not supply', async () => {
    const broker = new FakeBroker();
    const result = await service(broker).process(message({ publishedAtMs: null }), ctx());
    expect(result.outcome).toBe('TELEGRAM_SIGNAL_EXPIRED');
    expect(broker.calls).toHaveLength(0);
  });
});

describe('a closed market is consumed permanently, never queued', () => {
  it('records TELEGRAM_MARKET_CLOSED and places no order', async () => {
    const broker = new FakeBroker();
    const result = await service(broker).process(message(), ctx({ symbolSessionOpen: false }));

    expect(result.outcome).toBe('TELEGRAM_MARKET_CLOSED');
    expect(broker.calls).toHaveLength(0);
    expect(await prisma.telegramSignalLeg.count()).toBe(0);
  });

  it('does not execute that signal when the market reopens and the message is redelivered', async () => {
    const broker = new FakeBroker();
    const svc = service(broker);
    const msg = message();

    await svc.process(msg, ctx({ symbolSessionOpen: false }));
    // Monday: the market is open and the transport replays the backlog.
    const replay = await svc.process(msg, ctx({ symbolSessionOpen: true }));

    expect(replay.outcome).toBe('TELEGRAM_DUPLICATE_SIGNAL');
    expect(broker.calls).toHaveLength(0);
  });

  it('holds no queue of its own: nothing is left waiting for a reopening', async () => {
    await service(new FakeBroker()).process(message(), ctx({ symbolSessionOpen: false }));
    expect(await prisma.telegramSignalGroupLock.count()).toBe(0);
    const signal = await prisma.telegramSignal.findFirst();
    expect(signal!.outcome).toBe('TELEGRAM_MARKET_CLOSED');
  });
});

describe('duplicates', () => {
  it('executes the same message only once, however many times it is delivered', async () => {
    const broker = new FakeBroker();
    const svc = service(broker);
    const msg = message();

    const first = await svc.process(msg, ctx());
    await prisma.telegramSignalGroupLock.deleteMany(); // the first group finished
    const second = await svc.process(msg, ctx());

    expect(first.outcome).toBe('SUBMITTED');
    expect(second.outcome).toBe('TELEGRAM_DUPLICATE_SIGNAL');
    expect(broker.calls).toHaveLength(1); // the first signal's one leg, and no more
  });

  it('survives a restart: the guard is the database, not process memory', async () => {
    const broker = new FakeBroker();
    const msg = message();
    await service(broker).process(msg, ctx());
    await prisma.telegramSignalGroupLock.deleteMany();

    // A completely new service instance, as after a restart.
    const afterRestart = await service(broker).process(msg, ctx());
    expect(afterRestart.outcome).toBe('TELEGRAM_DUPLICATE_SIGNAL');
    expect(broker.calls).toHaveLength(1);
  });

  it('does not open a second trade for a restatement with a DIFFERENT target list', async () => {
    // The real pattern from @SFxauusd1: the same entry and stop republished
    // seconds later with the targets varied. Not equal by fingerprint, so
    // only this rule stops it becoming a second trade.
    const broker = new FakeBroker();
    const svc = service(broker);
    await svc.process(
      message({ messageId: '77242', text: lines('Gold buy now 4316', '', 'Sl 4305', '', 'Tp 4323') }),
      ctx({ quote: { bid: 4315.7, ask: 4316.0, tickAtMs: NOW - 500 } }),
    );
    await prisma.telegramSignalGroupLock.deleteMany();

    const restated = await svc.process(
      message({ messageId: '77250', text: lines('Gold buy now 4316', '', 'Sl 4305', '', 'Tp 4323', 'Tp 4360') }),
      ctx({ quote: { bid: 4315.7, ask: 4316.0, tickAtMs: NOW - 500 } }),
    );

    expect(restated.outcome).toBe('TELEGRAM_DUPLICATE_SIGNAL');
    expect(restated.detail).toMatch(/same entry, same stop/);
    // One leg from the first signal, and nothing more.
    expect(broker.calls).toHaveLength(1);
    expect(await prisma.telegramSignalLeg.count()).toBe(1);
  });

  it('does not open a second position for a repost under a new message id', async () => {
    const broker = new FakeBroker();
    const svc = service(broker);
    await svc.process(message({ messageId: '500' }), ctx());
    await prisma.telegramSignalGroupLock.deleteMany();

    const repost = await svc.process(message({ messageId: '501', publishedAtMs: NOW - 4_000 }), ctx());

    expect(repost.outcome).toBe('TELEGRAM_DUPLICATE_SIGNAL');
    expect(broker.calls).toHaveLength(1);
    expect(await prisma.telegramSignalLeg.count()).toBe(1);
  });
});

describe('signal-group occupancy', () => {
  it('consumes a second signal that arrives while a group is in flight', async () => {
    const broker = new FakeBroker();
    const svc = service(broker);
    await svc.process(message(), ctx());

    // A different trade at the same level, so it is neither a duplicate nor
    // refused for deviation — occupancy is the only thing that can stop it.
    const second = await svc.process(message({ text: 'Gold sell now 4338\nSL 4350\nTP 4320' }), ctx());

    expect(second.outcome).toBe('TELEGRAM_OCCUPIED');
    expect(second.detail).toMatch(/not queued behind/i);
    expect(broker.calls).toHaveLength(1);
  });
});

describe('messages that are not this engine’s business', () => {
  it('discards a message from another channel without recording it', async () => {
    const broker = new FakeBroker();
    const result = await service(broker).process(message({ channelUsername: 'SomeOtherSignals' }), ctx());

    expect(result.outcome).toBe('DISCARDED_NOT_SOURCE');
    expect(await prisma.telegramSignal.count()).toBe(0);
  });

  it('discards a message whose channel could not be identified', async () => {
    const result = await service(new FakeBroker()).process(message({ channelUsername: null }), ctx());
    expect(result.outcome).toBe('DISCARDED_NOT_SOURCE');
  });

  it('discards ordinary chat from the source channel', async () => {
    const result = await service(new FakeBroker()).process(
      message({ text: 'Good morning everyone, gold looking heavy today' }),
      ctx(),
    );
    expect(result.outcome).toBe('DISCARDED_NOT_A_SIGNAL');
    expect(await prisma.telegramSignal.count()).toBe(0);
  });
});

describe('the remaining gates', () => {
  it('refuses when free margin is unknown, rather than treating an unread account as solvent', async () => {
    const broker = new FakeBroker();
    const result = await service(broker).process(message(), ctx({ freeMargin: null }));
    expect(result.outcome).toBe('TELEGRAM_INSUFFICIENT_MARGIN');
    expect(broker.calls).toHaveLength(0);
  });

  it('refuses when the market is materially WORSE than the published entry', async () => {
    const broker = new FakeBroker();
    const result = await service(broker).process(
      // A SELL published at 4338 with the market at 4341 is $3 adverse.
      message(),
      ctx({ quote: { bid: 4341.0, ask: 4341.3, tickAtMs: NOW - 500 }, maxAdverseUsd: 1.5 }),
    );
    expect(result.outcome).toBe('TELEGRAM_LEGS_REFUSED');
    expect(result.detail).toMatch(/TELEGRAM_ADVERSE_ENTRY_DEVIATION/);
    expect(broker.calls).toHaveLength(0);
  });

  it('REFUSES a market that has moved toward the target, even though it looks like a better entry', async () => {
    // Changed on operator instruction: an earlier version accepted this
    // unconditionally. The published entry is the trade now — price having
    // moved at all off it, favourably included, is refused.
    const broker = new FakeBroker();
    const result = await service(broker).process(
      // $4 better than published, and still short of TP1 at 4329.
      message(),
      ctx({ quote: { bid: 4334.0, ask: 4334.3, tickAtMs: NOW - 500 }, maxAdverseUsd: 1.5 }),
    );
    expect(result.outcome).toBe('TELEGRAM_LEGS_REFUSED');
    expect(result.detail).toMatch(/TELEGRAM_ADVERSE_ENTRY_DEVIATION/);
    expect(broker.calls).toHaveLength(0);
  });

  it('cancels the whole group once price has reached the first target', async () => {
    const broker = new FakeBroker();
    const result = await service(broker).process(
      message(),
      ctx({ quote: { bid: 4328.7, ask: 4329.0, tickAtMs: NOW - 500 } }),
    );
    expect(result.outcome).toBe('TELEGRAM_TP1_ALREADY_REACHED');
    expect(broker.calls).toHaveLength(0);
    expect(await prisma.telegramSignalLeg.count()).toBe(0);

    // And the latch is recorded, so a retracement cannot revive it.
    const signal = await prisma.telegramSignal.findFirst();
    expect(signal!.tp1Touched).toBe(true);
    expect(Number(signal!.tp1)).toBe(4329);
  });

  it('refuses when reconciliation has not recovered broker state', async () => {
    const broker = new FakeBroker();
    const result = await service(broker).process(message(), ctx({ recoveryComplete: false }));
    expect(result.outcome).toBe('TELEGRAM_UNAVAILABLE');
    expect(result.detail).toMatch(/RECOVERY_INCOMPLETE/);
    expect(broker.calls).toHaveLength(0);
  });

  it('refuses when the engine switch is off, even in DEMO mode', async () => {
    process.env.TELEGRAM_ENGINE_ENABLED = 'false';
    const broker = new FakeBroker();
    const result = await service(broker).process(message(), ctx());
    expect(result.outcome).toBe('TELEGRAM_NOT_SUBMITTING_MODE');
    expect(broker.calls).toHaveLength(0);
  });

  it('SHADOW runs every gate and plans the legs, but queues nothing', async () => {
    process.env.TELEGRAM_ENGINE_EXECUTION_MODE = 'SHADOW';
    const broker = new FakeBroker();
    const result = await service(broker).process(message(), ctx());

    expect(result.outcome).toBe('TELEGRAM_NOT_SUBMITTING_MODE');
    expect(broker.calls).toHaveLength(0);
    expect(await prisma.telegramSignalLeg.count()).toBe(1);
    // The group is released, so a later live signal is not blocked by a
    // rehearsal that never reached the broker.
    expect(await prisma.telegramSignalGroupLock.count()).toBe(0);
  });

  it('the global kill switch stops the engine before anything is claimed', async () => {
    process.env.V2_GLOBAL_KILL_SWITCH = 'true';
    const broker = new FakeBroker();
    const result = await service(broker).process(message(), ctx());

    expect(result.outcome).toBe('TELEGRAM_UNAVAILABLE');
    expect(broker.calls).toHaveLength(0);
    expect(await prisma.telegramSignalGroupLock.count()).toBe(0);
  });
});

describe('an ambiguous broker answer', () => {
  it('records UNKNOWN as UNKNOWN and holds the group, because it may be a live position', async () => {
    const broker = new FakeBroker({ status: 'UNKNOWN', error: 'timeout' });
    const result = await service(broker).process(message(), ctx());

    const legs = await prisma.telegramSignalLeg.findMany({ where: { signalId: result.signalId! } });
    expect(legs.every((l) => l.orderStatus === 'UNKNOWN')).toBe(true);
    expect(await prisma.telegramSignalGroupLock.count()).toBe(1);
  });

  it('releases the group when every leg is a broker-confirmed refusal', async () => {
    const broker = new FakeBroker({ status: 'FAILED', error: 'rejected' });
    await service(broker).process(message(), ctx());
    expect(await prisma.telegramSignalGroupLock.count()).toBe(0);
  });
});
