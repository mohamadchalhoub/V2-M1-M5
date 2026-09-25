import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateResume, operatorResumeSession, type ResumeFacts } from '../../src/xauusd-sar/operator-resume';
import { SAR_MAGIC } from '../../src/xauusd-sar/safety-constants';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const NOW = Date.UTC(2026, 8, 24, 19, 50, 0); // 22:50 Beirut, Thursday
const TODAY = '2026-09-24';

const OK: ResumeFacts = {
  nowMs: NOW,
  sessionState: 'DAILY_CLOSED',
  sessionDate: TODAY,
  todayBeirut: TODAY,
  withinDailyClose: false,
  killSwitchOn: true,
  snapshotAgeMs: 5_000,
  tradeMode: 'DEMO',
  terminalConnected: true,
  terminalTradeAllowed: true,
  accountTradeAllowed: true,
  sessionOpen: true,
  symbolTradeMode: 4,
  quoteFresh: true,
  brokerSarPositions: 0,
  outstandingAttempts: 0,
};

describe('resume preconditions', () => {
  it('accepts when every condition holds', () => {
    expect(evaluateResume(OK)).toEqual([]);
  });

  it.each<[string, Partial<ResumeFacts>]>([
    ['not DEMO', { tradeMode: 'REAL' }],
    ['a SAR position is open at the broker', { brokerSarPositions: 1 }],
    ['an UNKNOWN session', { sessionState: 'REVERSAL_UNKNOWN' }],
    ['an outstanding attempt', { outstandingAttempts: 1 }],
    ['stale ticks', { quoteFresh: false }],
    ['an unhealthy collector', { snapshotAgeMs: 120_000 }],
    ['no collector snapshot', { snapshotAgeMs: null }],
    ['market closed', { sessionOpen: false }],
    ['terminal trading disabled', { terminalTradeAllowed: false }],
    ['account trading disabled', { accountTradeAllowed: false }],
    ['terminal disconnected', { terminalConnected: false }],
    ['symbol not fully tradable', { symbolTradeMode: 0 }],
    ['after 23:40 Beirut', { withinDailyClose: true }],
    ['kill switch OFF', { killSwitchOn: false }],
    ['a session from another day', { sessionDate: '2026-09-23' }],
    ['an active session', { sessionState: 'ACTIVE_BUY' }],
  ])('refuses with %s', (_label, change) => {
    expect(evaluateResume({ ...OK, ...change }).length).toBeGreaterThan(0);
  });
});

describe('operatorResumeSession against the database', () => {
  const prisma = new PrismaClient();
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase(prisma);
    const user = await createUser(prisma);
    accountId = (await createTradingAccount(prisma, user.id)).id;
    process.env.XAUUSD_SAR_KILL_SWITCH = 'true';
    await prisma.symbolMetadata.create({
      data: { symbol: 'XAUUSD', point: 0.01, volumeMin: 0.01, volumeMax: 5, volumeStep: 0.01, contractSize: 100, tradeMode: 4, digits: 2, profitCurrency: 'USD' },
    });
    await prisma.liveTick.create({ data: { symbol: 'XAUUSD', bid: 4292.46, ask: 4292.78, tickAt: new Date(NOW - 1_000) } });
    await prisma.xauusdM1M5Mt5Snapshot.create({
      data: {
        accountId,
        capturedAt: new Date(NOW - 5_000),
        loginId: '5056294252',
        tradeMode: 'DEMO',
        terminalConnected: true,
        terminalTradeAllowed: true,
        terminalTradeApiDisabled: false,
        accountTradeAllowed: true,
        accountTradeExpert: true,
        marginMode: 'RETAIL_HEDGING',
        sessionOpen: true,
        leverage: 100,
      },
    });
    await prisma.xauusdSarSession.create({
      data: { accountId, specHash: 'x', sessionDate: TODAY, state: 'DAILY_CLOSED', sessionReference: 4286.315, brokerTicket: null },
    });
    await prisma.xauusdSarOrderAttempt.create({
      data: { accountId, cycleId: 'c-old', idempotencyTag: 'SARhistory01', kind: 'REVERSAL', direction: 'BUY', volume: 0.01, status: 'FILLED', ticket: '1', fillPrice: 4290, resolvedAt: new Date(NOW - 600_000) },
    });
  });

  afterEach(() => {
    delete process.env.XAUUSD_SAR_KILL_SWITCH;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns the session to WAIT_MARKET_OPEN with a cleared reference and places no order', async () => {
    const result = await operatorResumeSession(prisma as never, accountId, NOW);
    expect(result.refusals).toEqual([]);
    expect(result.resumed).toBe(true);

    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('WAIT_MARKET_OPEN');
    expect(row!.sessionReference).toBeNull();
    expect(row!.sessionDate).toBe(TODAY);

    const attempts = await prisma.xauusdSarOrderAttempt.findMany({ where: { accountId } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('FILLED');
  });

  it('refuses while the broker still reports a SAR-magic position', async () => {
    await prisma.position.create({
      data: {
        accountId,
        platform: 'MT5',
        externalPositionId: '999',
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: 0.01,
        openPrice: 4290,
        status: 'OPEN',
        openedAt: new Date(NOW - 60_000),
        rawPayload: { magic: SAR_MAGIC },
      } as never,
    });
    const result = await operatorResumeSession(prisma as never, accountId, NOW);
    expect(result.resumed).toBe(false);
    const row = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
    expect(row!.state).toBe('DAILY_CLOSED');
  });

  it('ignores a foreign-magic position (magic 0) when checking broker flatness', async () => {
    await prisma.position.create({
      data: {
        accountId,
        platform: 'MT5',
        externalPositionId: '998',
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: 0.01,
        openPrice: 4290,
        status: 'OPEN',
        openedAt: new Date(NOW - 60_000),
        rawPayload: { magic: 0 },
      } as never,
    });
    const result = await operatorResumeSession(prisma as never, accountId, NOW);
    expect(result.resumed).toBe(true);
  });

  it('refuses with the kill switch off', async () => {
    delete process.env.XAUUSD_SAR_KILL_SWITCH;
    const result = await operatorResumeSession(prisma as never, accountId, NOW);
    expect(result.resumed).toBe(false);
  });
});
