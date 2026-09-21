import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { setupAccountWithToken } from '../helpers/factories';
import { TrendBreakoutSlotLockService } from '../../src/trend-breakout/slot-lock.service';
import { SymbolMetadataService } from '../../src/trend-breakout/symbol-metadata.service';
import { TrendBreakoutPreSendGuardService } from '../../src/trend-breakout/trend-breakout-pre-send-guard.service';

// 2026-09-15T06:00:00Z = 09:00 Asia/Beirut — inside the 03:00-12:00 window.
const IN_WINDOW_T = Date.parse('2026-09-15T06:00:00.000Z');
// 2026-09-15T09:30:00Z = 12:30 Asia/Beirut — just past the window closes at 12:00.
const AFTER_WINDOW_T = Date.parse('2026-09-15T09:30:00.000Z');

describe('TrendBreakoutPreSendGuardService — final re-verification at the collector hand-off boundary', () => {
  let prisma: PrismaClient;
  let slotLock: TrendBreakoutSlotLockService;
  let symbolMetadata: SymbolMetadataService;
  let guard: TrendBreakoutPreSendGuardService;
  let isolatedDir: string;
  const originalEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['TREND_BREAKOUT_KILL_SWITCH_PATH', 'TREND_BREAKOUT_STOP_NEW_ENTRIES_PATH', 'TREND_BREAKOUT_STOP_NEW_ENTRIES'];

  beforeAll(() => {
    prisma = new PrismaClient();
    slotLock = new TrendBreakoutSlotLockService(prisma as any);
    symbolMetadata = new SymbolMetadataService(prisma as any);
    guard = new TrendBreakoutPreSendGuardService(prisma as any, slotLock, symbolMetadata);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    isolatedDir = mkdtempSync(join(tmpdir(), 'tb-pre-send-guard-'));
    process.env.TREND_BREAKOUT_KILL_SWITCH_PATH = join(isolatedDir, 'TREND_BREAKOUT_KILL_SWITCH');
    process.env.TREND_BREAKOUT_STOP_NEW_ENTRIES_PATH = join(isolatedDir, 'TREND_BREAKOUT_STOP_NEW_ENTRIES');
    delete process.env.TREND_BREAKOUT_STOP_NEW_ENTRIES;
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    rmSync(isolatedDir, { recursive: true, force: true });
  });

  async function seedDemoAccount(accountId: string) {
    await prisma.accountSnapshot.create({
      data: { accountId, tradeMode: 'DEMO', balance: 50000, equity: 50000, margin: 0, freeMargin: 50000, profit: 0, capturedAt: new Date() },
    });
  }

  async function seedTick(symbol: string, atT: number, bid: number, ask: number) {
    await prisma.liveTick.upsert({
      where: { symbol }, create: { symbol, bid, ask, tickAt: new Date(atT) }, update: { bid, ask, tickAt: new Date(atT) },
    });
  }

  async function seedDecisionWithLock(accountId: string, instrument: 'EURUSD' | 'XAUUSD', signalCloseAt: Date) {
    const decision = await prisma.trendBreakoutDecision.create({
      data: {
        accountId, strategyVersion: 'test-v1', instrument, signalCloseAt, decisionAtBeirut: '09:00:00',
        action: 'OPEN_BUY', gateResults: [], orderStatus: 'SENT',
      },
    });
    await prisma.trendBreakoutSlotLock.create({ data: { accountId, instrument, decisionId: decision.id, state: 'PENDING' } });
    return decision;
  }

  it('approves when window, freshness, deviation, slot ownership and trade_mode all still check out (EURUSD)', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await seedDemoAccount(account.id);
    await seedTick('EURUSD', IN_WINDOW_T, 1.085, 1.0852);
    const signalCloseAt = new Date(IN_WINDOW_T - 30_000);
    const decision = await seedDecisionWithLock(account.id, 'EURUSD', signalCloseAt);

    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, instrument: 'EURUSD', brokerSymbol: 'EURUSD',
      action: 'OPEN_BUY', entryPrice: 1.0851, signalCloseAt,
    });
    expect(result.ok).toBe(true);
  });

  it('approves for XAUUSD symmetrically', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await seedDemoAccount(account.id);
    await seedTick('XAUUSD', IN_WINDOW_T, 2650, 2650.2);
    const signalCloseAt = new Date(IN_WINDOW_T - 30_000);
    const decision = await seedDecisionWithLock(account.id, 'XAUUSD', signalCloseAt);

    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, instrument: 'XAUUSD', brokerSymbol: 'XAUUSD',
      action: 'OPEN_BUY', entryPrice: 2650.1, signalCloseAt,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects when the trend-breakout kill switch is active', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await seedDemoAccount(account.id);
    await seedTick('EURUSD', IN_WINDOW_T, 1.085, 1.0852);
    const signalCloseAt = new Date(IN_WINDOW_T - 30_000);
    const decision = await seedDecisionWithLock(account.id, 'EURUSD', signalCloseAt);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.TREND_BREAKOUT_KILL_SWITCH_PATH as string, '');

    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, instrument: 'EURUSD', brokerSymbol: 'EURUSD',
      action: 'OPEN_BUY', entryPrice: 1.0851, signalCloseAt,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/kill switch/i);
  });

  it('rejects when STOP NEW ENTRIES is active', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await seedDemoAccount(account.id);
    await seedTick('XAUUSD', IN_WINDOW_T, 2650, 2650.2);
    const signalCloseAt = new Date(IN_WINDOW_T - 30_000);
    const decision = await seedDecisionWithLock(account.id, 'XAUUSD', signalCloseAt);
    process.env.TREND_BREAKOUT_STOP_NEW_ENTRIES = 'true';

    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, instrument: 'XAUUSD', brokerSymbol: 'XAUUSD',
      action: 'OPEN_BUY', entryPrice: 2650.1, signalCloseAt,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/STOP NEW ENTRIES/);
  });

  it('rejects with no live tick available', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await seedDemoAccount(account.id);
    const signalCloseAt = new Date(IN_WINDOW_T - 30_000);
    const decision = await seedDecisionWithLock(account.id, 'EURUSD', signalCloseAt);

    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, instrument: 'EURUSD', brokerSymbol: 'EURUSD',
      action: 'OPEN_BUY', entryPrice: 1.0851, signalCloseAt,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/live .* quote/);
  });

  it('rejects when the entry window has closed since queuing', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await seedDemoAccount(account.id);
    await seedTick('EURUSD', AFTER_WINDOW_T, 1.085, 1.0852);
    const signalCloseAt = new Date(IN_WINDOW_T - 30_000);
    const decision = await seedDecisionWithLock(account.id, 'EURUSD', signalCloseAt);

    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, instrument: 'EURUSD', brokerSymbol: 'EURUSD',
      action: 'OPEN_BUY', entryPrice: 1.0851, signalCloseAt,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/entry window/);
  });

  it('rejects a stale (expired) setup', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await seedDemoAccount(account.id);
    await seedTick('EURUSD', IN_WINDOW_T, 1.085, 1.0852);
    const signalCloseAt = new Date(IN_WINDOW_T - 120_000); // 120s > 60s expiry
    const decision = await seedDecisionWithLock(account.id, 'EURUSD', signalCloseAt);

    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, instrument: 'EURUSD', brokerSymbol: 'EURUSD',
      action: 'OPEN_BUY', entryPrice: 1.0851, signalCloseAt,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expired/);
  });

  it('rejects when price has moved beyond the per-instrument max entry deviation (XAUUSD)', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await seedDemoAccount(account.id);
    await seedTick('XAUUSD', IN_WINDOW_T, 2660, 2660.2); // moved $10 = 1000pt, well past the 200pt default cap
    const signalCloseAt = new Date(IN_WINDOW_T - 30_000);
    const decision = await seedDecisionWithLock(account.id, 'XAUUSD', signalCloseAt);

    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, instrument: 'XAUUSD', brokerSymbol: 'XAUUSD',
      action: 'OPEN_BUY', entryPrice: 2650, signalCloseAt,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/deviation|moved/);
  });

  it('rejects when the slot lock does not belong to this decision (lost/superseded claim)', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await seedDemoAccount(account.id);
    await seedTick('EURUSD', IN_WINDOW_T, 1.085, 1.0852);
    const signalCloseAt = new Date(IN_WINDOW_T - 30_000);
    // Decision created WITHOUT its own matching slot lock (simulates a lost claim).
    const decision = await prisma.trendBreakoutDecision.create({
      data: {
        accountId: account.id, strategyVersion: 'test-v1', instrument: 'EURUSD', signalCloseAt, decisionAtBeirut: '09:00:00',
        action: 'OPEN_BUY', gateResults: [], orderStatus: 'SENT',
      },
    });

    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, instrument: 'EURUSD', brokerSymbol: 'EURUSD',
      action: 'OPEN_BUY', entryPrice: 1.0851, signalCloseAt,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/slot lock/);
  });

  it('rejects when the account trade_mode is no longer DEMO', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await prisma.accountSnapshot.create({
      data: { accountId: account.id, tradeMode: 'REAL', balance: 50000, equity: 50000, margin: 0, freeMargin: 50000, profit: 0, capturedAt: new Date() },
    });
    await seedTick('EURUSD', IN_WINDOW_T, 1.085, 1.0852);
    const signalCloseAt = new Date(IN_WINDOW_T - 30_000);
    const decision = await seedDecisionWithLock(account.id, 'EURUSD', signalCloseAt);

    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, instrument: 'EURUSD', brokerSymbol: 'EURUSD',
      action: 'OPEN_BUY', entryPrice: 1.0851, signalCloseAt,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/DEMO/);
  });
});
