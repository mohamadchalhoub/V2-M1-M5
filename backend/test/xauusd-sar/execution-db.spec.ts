/**
 * xauusd-sar-v1's execution path against a REAL database, with a simulated
 * broker — the same reasoning as the frozen RSI strategy's and Engine B's
 * own DB-backed execution suites: the guarantees under test (atomic claim,
 * idempotent submission, UNKNOWN handling, daily close) are database
 * guarantees, and a mock would prove nothing about the thing that actually
 * protects the account.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SarExecutionService, type SarBrokerPort, type SarSubmitRequest, type SarSubmitResponse } from '../../src/xauusd-sar/execution.service';
import { setSarVolume } from '../../src/xauusd-sar/volume-setting';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
let accountId: string;

// 01:00 Beirut on a Wednesday in September (UTC+3).
const SESSION_START = Date.UTC(2026, 8, 23, 22, 0);

class FakeBroker implements SarBrokerPort {
  public readonly calls: SarSubmitRequest[] = [];
  private ticketSeq = 900000;
  constructor(private readonly response: 'FILLED' | 'FAILED' | 'UNKNOWN' = 'FILLED') {}
  async submit(request: SarSubmitRequest): Promise<SarSubmitResponse> {
    this.calls.push(request);
    if (this.response === 'FILLED') {
      this.ticketSeq += 1;
      const fillPrice = request.direction === 'BUY' ? 4500.5 : 4499.5;
      return { status: 'FILLED', ticket: String(this.ticketSeq), fillPrice };
    }
    if (this.response === 'FAILED') return { status: 'FAILED', error: 'rejected' };
    return { status: 'UNKNOWN', error: 'timeout' };
  }
}

function service(broker: SarBrokerPort) {
  return new SarExecutionService(prisma as never, broker);
}

beforeEach(async () => {
  await resetDatabase(prisma);
  const user = await createUser(prisma);
  accountId = (await createTradingAccount(prisma, user.id)).id;
  const metadata = await prisma.symbolMetadata.upsert({
    where: { symbol: 'XAUUSD' },
    create: {
      symbol: 'XAUUSD',
      point: 0.01,
      volumeMin: 0.01,
      volumeMax: 5,
      volumeStep: 0.01,
      contractSize: 100,
      tradeMode: 4,
      digits: 2,
      profitCurrency: 'USD',
    },
    update: {},
  });
  void metadata;
  await setSarVolume(prisma, { accountId, lots: 0.5, changedBy: 'test' });
  process.env.XAUUSD_SAR_ENABLED = 'true';
  process.env.XAUUSD_SAR_EXECUTION_MODE = 'DEMO';
  delete process.env.XAUUSD_SAR_KILL_SWITCH;
  delete process.env.V2_GLOBAL_KILL_SWITCH;
});

afterEach(() => {
  delete process.env.XAUUSD_SAR_ENABLED;
  delete process.env.XAUUSD_SAR_EXECUTION_MODE;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('session initialization', () => {
  it('captures a fixed reference once, and does nothing on a second call', async () => {
    const svc = service(new FakeBroker());
    await svc.ensureSession(accountId, SESSION_START);
    const first = await svc.initializeSession(accountId, { bid: 4500, ask: 4500.2, ageSeconds: 1, fresh: true }, SESSION_START);
    expect(first.action).toBe('SESSION_INITIALIZED');

    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('WAIT_INITIAL_DIRECTION');
    expect(Number(row!.sessionReference)).toBeCloseTo(4500.1, 6);

    const second = await svc.initializeSession(accountId, { bid: 9999, ask: 9999, ageSeconds: 1, fresh: true }, SESSION_START + 1000);
    expect(second.action).toBe('NONE');
    const stillSame = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(Number(stillSame!.sessionReference)).toBeCloseTo(4500.1, 6); // unchanged
  });

  it('does nothing on a stale quote', async () => {
    const svc = service(new FakeBroker());
    await svc.ensureSession(accountId, SESSION_START);
    const result = await svc.initializeSession(accountId, { bid: 4500, ask: 4500.2, ageSeconds: 45, fresh: false }, SESSION_START);
    expect(result.action).toBe('NONE');
  });
});

describe('the initial entry, end to end', () => {
  async function initialized() {
    const svc = service(new FakeBroker());
    await svc.ensureSession(accountId, SESSION_START);
    await svc.initializeSession(accountId, { bid: 4500, ask: 4500.2, ageSeconds: 1, fresh: true }, SESSION_START);
    return svc;
  }

  it('submits a BUY exactly once, opens the cycle, and records it', async () => {
    const broker = new FakeBroker('FILLED');
    const svc = service(broker);
    await svc.ensureSession(accountId, SESSION_START);
    await svc.initializeSession(accountId, { bid: 4500, ask: 4500.2, ageSeconds: 1, fresh: true }, SESSION_START);

    const result = await new SarExecutionService(prisma as never, broker).evaluateTick(
      accountId,
      { bid: 4500.4, ask: 4500.6, ageSeconds: 1, fresh: true },
      SESSION_START + 1000,
    );

    expect(result.action).toBe('INITIAL_ENTRY_SUBMITTED');
    expect(broker.calls).toHaveLength(1);
    expect(broker.calls[0].direction).toBe('BUY');
    expect(broker.calls[0].volumeLots).toBe(0.5);

    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('ACTIVE_BUY');
    expect(row!.brokerTicket).not.toBeNull();

    const cycles = await prisma.xauusdSarCycle.findMany({ where: { accountId } });
    expect(cycles).toHaveLength(1);
    expect(cycles[0].direction).toBe('BUY');
  });

  it('refuses to submit when the kill switch is engaged, and evaluates nothing', async () => {
    await initialized();
    process.env.XAUUSD_SAR_KILL_SWITCH = 'true';
    const broker = new FakeBroker('FILLED');
    const result = await service(broker).evaluateTick(accountId, { bid: 4500.4, ask: 4500.6, ageSeconds: 1, fresh: true }, SESSION_START + 1000);
    expect(result.action).toBe('BLOCKED');
    expect(broker.calls).toHaveLength(0);
    delete process.env.XAUUSD_SAR_KILL_SWITCH;
  });

  it('an UNKNOWN broker answer blocks further evaluation until reconciled', async () => {
    await initialized();
    const broker = new FakeBroker('UNKNOWN');
    const result = await service(broker).evaluateTick(accountId, { bid: 4500.4, ask: 4500.6, ageSeconds: 1, fresh: true }, SESSION_START + 1000);
    expect(result.action).toBe('BLOCKED');

    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('REVERSAL_UNKNOWN');

    // Blocked on every subsequent tick, whatever price does.
    const again = await service(new FakeBroker('FILLED')).evaluateTick(accountId, { bid: 4600, ask: 4600.2, ageSeconds: 1, fresh: true }, SESSION_START + 2000);
    expect(again.action).toBe('BLOCKED');
  });

  it('a broker-confirmed FAILED reverts to the prior state, not stuck UNKNOWN', async () => {
    await initialized();
    const broker = new FakeBroker('FAILED');
    await service(broker).evaluateTick(accountId, { bid: 4500.4, ask: 4500.6, ageSeconds: 1, fresh: true }, SESSION_START + 1000);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('WAIT_INITIAL_DIRECTION');
  });
});

describe('the full reversal cycle, end to end', () => {
  async function activeBuy(): Promise<SarExecutionService> {
    const broker = new FakeBroker('FILLED');
    const svc = service(broker);
    await svc.ensureSession(accountId, SESSION_START);
    await svc.initializeSession(accountId, { bid: 4500, ask: 4500.2, ageSeconds: 1, fresh: true }, SESSION_START);
    await svc.evaluateTick(accountId, { bid: 4500.4, ask: 4500.6, ageSeconds: 1, fresh: true }, SESSION_START + 1000);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('ACTIVE_BUY');
    return svc;
  }

  it('trails the high but does not reverse until the level is reached', async () => {
    const svc = await activeBuy();
    const result = await svc.evaluateTick(accountId, { bid: 4501.0, ask: 4501.2, ageSeconds: 1, fresh: true }, SESSION_START + 2000);
    expect(result.action).toBe('NONE');
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('ACTIVE_BUY');
    expect(Number(row!.extremeSinceEntry)).toBeCloseTo(4501.0, 6);
  });

  it('reverses BUY -> SELL exactly once when the level is crossed, opening a new cycle', async () => {
    const svc = await activeBuy();
    await svc.evaluateTick(accountId, { bid: 4503.0, ask: 4503.2, ageSeconds: 1, fresh: true }, SESSION_START + 2000);

    const result = await svc.evaluateTick(accountId, { bid: 4502.5, ask: 4502.7, ageSeconds: 1, fresh: true }, SESSION_START + 3000);
    expect(result.action).toBe('REVERSAL_SUBMITTED');

    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('ACTIVE_SELL');

    const cycles = await prisma.xauusdSarCycle.findMany({ where: { accountId }, orderBy: { entryAt: 'asc' } });
    expect(cycles).toHaveLength(2);
    expect(cycles[0].direction).toBe('BUY');
    expect(cycles[0].exitReason).toBe('REVERSAL');
    expect(cycles[0].exitAt).not.toBeNull();
    expect(cycles[1].direction).toBe('SELL');
  });
});

describe('the daily close', () => {
  it('flattens an active position and marks the session DAILY_CLOSED', async () => {
    const broker = new FakeBroker('FILLED');
    const svc = service(broker);
    await svc.ensureSession(accountId, SESSION_START);
    await svc.initializeSession(accountId, { bid: 4500, ask: 4500.2, ageSeconds: 1, fresh: true }, SESSION_START);
    await svc.evaluateTick(accountId, { bid: 4500.4, ask: 4500.6, ageSeconds: 1, fresh: true }, SESSION_START + 1000);

    const closeAt = Date.UTC(2026, 8, 23, 20, 40); // 23:40 Beirut
    const result = await svc.closeForDay(accountId, closeAt);
    expect(result.action).toBe('DAILY_CLOSED');

    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('DAILY_CLOSED');
    expect(row!.direction).toBeNull();
    expect(row!.brokerTicket).toBeNull();

    const cycles = await prisma.xauusdSarCycle.findMany({ where: { accountId } });
    expect(cycles[0].exitReason).toBe('DAILY_CLOSE');
    expect(cycles[0].exitAt).not.toBeNull();
  });

  it('closes even a flat WAIT_MARKET_OPEN session (nothing to flatten, but still marks DAILY_CLOSED)', async () => {
    const svc = service(new FakeBroker());
    await svc.ensureSession(accountId, SESSION_START);
    const first = await svc.closeForDay(accountId, SESSION_START);
    expect(first.action).toBe('DAILY_CLOSED');
  });

  it('is a true no-op once already DAILY_CLOSED — never double-closes', async () => {
    const svc = service(new FakeBroker());
    await svc.ensureSession(accountId, SESSION_START);
    await svc.closeForDay(accountId, SESSION_START);
    const second = await svc.closeForDay(accountId, SESSION_START + 1000);
    expect(second.action).toBe('NONE');
    expect(second.detail).toMatch(/already closed/);
  });
});
