import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { setupAccountWithToken } from '../helpers/factories';
import { GoldAccountStateService } from '../../src/gold-execution/gold-account-state.service';
import { GoldPreSendGuardService } from '../../src/gold-execution/gold-pre-send-guard.service';

// 2026-09-15T06:00:00Z = 09:00 Asia/Beirut — inside the window.
const IN_WINDOW_T = Date.parse('2026-09-15T06:00:00.000Z');
// 2026-09-15T09:30:00Z = 12:30 Asia/Beirut — just past the window closes at 12:00.
const AFTER_WINDOW_T = Date.parse('2026-09-15T09:30:00.000Z');

describe('GoldPreSendGuardService — final re-verification at the collector hand-off boundary', () => {
  let prisma: PrismaClient;
  let accountState: GoldAccountStateService;
  let guard: GoldPreSendGuardService;
  let isolatedKillSwitchDir: string;
  let originalKillSwitchEnv: string | undefined;
  let originalGoldKillSwitchEnv: string | undefined;

  beforeAll(() => {
    prisma = new PrismaClient();
    accountState = new GoldAccountStateService(prisma as any);
    guard = new GoldPreSendGuardService(prisma as any, accountState);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    // Isolate every test in this file from the repo's own (possibly currently-engaged)
    // backend/KILL_SWITCH file — that file is real operational state, not something a test run
    // should be sensitive to. Each test below redirects to a fresh, nonexistent path so the
    // switch reads as inactive unless a test explicitly creates it.
    originalKillSwitchEnv = process.env.AUTONOMOUS_KILL_SWITCH_PATH;
    originalGoldKillSwitchEnv = process.env.GOLD_KILL_SWITCH_PATH;
    isolatedKillSwitchDir = mkdtempSync(join(tmpdir(), 'gold-pre-send-guard-ks-'));
    process.env.AUTONOMOUS_KILL_SWITCH_PATH = join(isolatedKillSwitchDir, 'KILL_SWITCH');
    // Same isolation, for the gold-specific switch this guard actually reads
    // — must never be sensitive to the repo's own (possibly currently
    // engaged, e.g. as a deliberate operational pause) backend/GOLD_KILL_SWITCH.
    process.env.GOLD_KILL_SWITCH_PATH = join(isolatedKillSwitchDir, 'GOLD_KILL_SWITCH');
  });
  afterEach(async () => {
    delete process.env.GOLD_STOP_NEW_ENTRIES;
    rmSync(isolatedKillSwitchDir, { recursive: true, force: true });
    if (originalKillSwitchEnv === undefined) delete process.env.AUTONOMOUS_KILL_SWITCH_PATH;
    else process.env.AUTONOMOUS_KILL_SWITCH_PATH = originalKillSwitchEnv;
    if (originalGoldKillSwitchEnv === undefined) delete process.env.GOLD_KILL_SWITCH_PATH;
    else process.env.GOLD_KILL_SWITCH_PATH = originalGoldKillSwitchEnv;
  });

  async function seedDemoAccount(accountId: string) {
    await prisma.accountSnapshot.create({
      data: {
        accountId, tradeMode: 'DEMO', balance: 50000, equity: 50000, margin: 0, freeMargin: 50000,
        profit: 0, capturedAt: new Date(),
      },
    });
  }

  async function seedTick(atT: number, bid = 2650, ask = 2650.2) {
    await prisma.liveTick.upsert({
      where: { symbol: 'XAUUSD' },
      create: { symbol: 'XAUUSD', bid, ask, tickAt: new Date(atT) },
      update: { bid, ask, tickAt: new Date(atT) },
    });
  }

  it('approves a decision when window, freshness, price, occupancy and trade_mode all still check out', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await seedDemoAccount(account.id);
    await seedTick(IN_WINDOW_T);
    const decision = await prisma.autonomousDecision.create({
      data: {
        accountId: account.id, symbol: 'XAUUSD', action: 'OPEN_BUY', source: 'RULES_ONLY',
        entryPrice: 2650, stopLoss: 2640, takeProfit: 2660, reasoning: 'test', inputSnapshot: {},
        riskManagerApproved: true, orderStatus: 'SENT',
      },
    });

    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, action: 'OPEN_BUY',
      entryPrice: 2650, touchEndT: IN_WINDOW_T - 60_000,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a decision queued before noon Beirut but whose freshest quote is now after it closed — the exact "queued before, sent after" scenario', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await seedDemoAccount(account.id);
    // The decision's own touch was well inside the window...
    const touchEndT = IN_WINDOW_T;
    // ...but by the time this check runs, the freshest live quote is already after the window closed
    // (simulating queue/collector-poll delay carrying the actual send past noon Beirut).
    await seedTick(AFTER_WINDOW_T);
    const decision = await prisma.autonomousDecision.create({
      data: {
        accountId: account.id, symbol: 'XAUUSD', action: 'OPEN_BUY', source: 'RULES_ONLY',
        entryPrice: 2650, stopLoss: 2640, takeProfit: 2660, reasoning: 'test', inputSnapshot: {},
        riskManagerApproved: true, orderStatus: 'SENT',
      },
    });

    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, action: 'OPEN_BUY',
      entryPrice: 2650, touchEndT,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/entry window/);
  });

  it('rejects when the GOLD kill switch is active (not the legacy one)', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await seedDemoAccount(account.id);
    await seedTick(IN_WINDOW_T);
    const decision = await prisma.autonomousDecision.create({
      data: {
        accountId: account.id, symbol: 'XAUUSD', action: 'OPEN_BUY', source: 'RULES_ONLY',
        entryPrice: 2650, stopLoss: 2640, takeProfit: 2660, reasoning: 'test', inputSnapshot: {},
        riskManagerApproved: true, orderStatus: 'SENT',
      },
    });
    writeFileSync(process.env.GOLD_KILL_SWITCH_PATH as string, '');
    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, action: 'OPEN_BUY',
      entryPrice: 2650, touchEndT: IN_WINDOW_T - 60_000,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Kill switch/);
  });

  it('rejects when STOP NEW ENTRIES is active', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await seedDemoAccount(account.id);
    await seedTick(IN_WINDOW_T);
    const decision = await prisma.autonomousDecision.create({
      data: {
        accountId: account.id, symbol: 'XAUUSD', action: 'OPEN_BUY', source: 'RULES_ONLY',
        entryPrice: 2650, stopLoss: 2640, takeProfit: 2660, reasoning: 'test', inputSnapshot: {},
        riskManagerApproved: true, orderStatus: 'SENT',
      },
    });
    process.env.GOLD_STOP_NEW_ENTRIES = 'true';
    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, action: 'OPEN_BUY',
      entryPrice: 2650, touchEndT: IN_WINDOW_T - 60_000,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/STOP NEW ENTRIES/);
  });

  it('rejects when price has moved beyond the max entry deviation since the decision was queued', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await seedDemoAccount(account.id);
    await seedTick(IN_WINDOW_T, 2660, 2660.2); // moved $10 = 1000pt, well past the 200pt cap
    const decision = await prisma.autonomousDecision.create({
      data: {
        accountId: account.id, symbol: 'XAUUSD', action: 'OPEN_BUY', source: 'RULES_ONLY',
        entryPrice: 2650, stopLoss: 2640, takeProfit: 2660, reasoning: 'test', inputSnapshot: {},
        riskManagerApproved: true, orderStatus: 'SENT',
      },
    });
    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, action: 'OPEN_BUY',
      entryPrice: 2650, touchEndT: IN_WINDOW_T - 60_000,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/deviation|moved/);
  });

  it('rejects when the signal is older than the max signal age at send time', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await seedDemoAccount(account.id);
    await seedTick(IN_WINDOW_T);
    const decision = await prisma.autonomousDecision.create({
      data: {
        accountId: account.id, symbol: 'XAUUSD', action: 'OPEN_BUY', source: 'RULES_ONLY',
        entryPrice: 2650, stopLoss: 2640, takeProfit: 2660, reasoning: 'test', inputSnapshot: {},
        riskManagerApproved: true, orderStatus: 'SENT',
      },
    });
    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, action: 'OPEN_BUY',
      entryPrice: 2650, touchEndT: IN_WINDOW_T - 700_000, // 700s > 600s max
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/old/);
  });

  it('fails closed when touchEndT is missing from the decision record', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await seedDemoAccount(account.id);
    await seedTick(IN_WINDOW_T);
    const decision = await prisma.autonomousDecision.create({
      data: {
        accountId: account.id, symbol: 'XAUUSD', action: 'OPEN_BUY', source: 'RULES_ONLY',
        entryPrice: 2650, stopLoss: 2640, takeProfit: 2660, reasoning: 'test', inputSnapshot: {},
        riskManagerApproved: true, orderStatus: 'SENT',
      },
    });
    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, action: 'OPEN_BUY',
      entryPrice: 2650, touchEndT: null,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/freshness/);
  });

  it('rejects when new XAUUSD exposure appeared since the decision was queued, excluding the decision itself', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await seedDemoAccount(account.id);
    await seedTick(IN_WINDOW_T);
    const decision = await prisma.autonomousDecision.create({
      data: {
        accountId: account.id, symbol: 'XAUUSD', action: 'OPEN_BUY', source: 'RULES_ONLY',
        entryPrice: 2650, stopLoss: 2640, takeProfit: 2660, reasoning: 'test', inputSnapshot: {},
        riskManagerApproved: true, orderStatus: 'SENT', // this decision itself is already SENT — must be excluded
      },
    });
    await prisma.position.create({
      data: {
        accountId: account.id, platform: 'MT5', externalPositionId: 'manual-1', symbol: 'XAUUSD',
        side: 'BUY', volume: 0.02, openPrice: 2650, status: 'OPEN', openedAt: new Date(),
      },
    });
    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, action: 'OPEN_BUY',
      entryPrice: 2650, touchEndT: IN_WINDOW_T - 60_000,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exposure/);
  });

  it('does NOT reject solely because the decision itself is SENT (excludes its own row from occupancy)', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await seedDemoAccount(account.id);
    await seedTick(IN_WINDOW_T);
    const decision = await prisma.autonomousDecision.create({
      data: {
        accountId: account.id, symbol: 'XAUUSD', action: 'OPEN_BUY', source: 'RULES_ONLY',
        entryPrice: 2650, stopLoss: 2640, takeProfit: 2660, reasoning: 'test', inputSnapshot: {},
        riskManagerApproved: true, orderStatus: 'SENT',
      },
    });
    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, action: 'OPEN_BUY',
      entryPrice: 2650, touchEndT: IN_WINDOW_T - 60_000,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects when the account trade_mode is no longer DEMO', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await prisma.accountSnapshot.create({
      data: {
        accountId: account.id, tradeMode: 'REAL', balance: 50000, equity: 50000, margin: 0,
        freeMargin: 50000, profit: 0, capturedAt: new Date(),
      },
    });
    await seedTick(IN_WINDOW_T);
    const decision = await prisma.autonomousDecision.create({
      data: {
        accountId: account.id, symbol: 'XAUUSD', action: 'OPEN_BUY', source: 'RULES_ONLY',
        entryPrice: 2650, stopLoss: 2640, takeProfit: 2660, reasoning: 'test', inputSnapshot: {},
        riskManagerApproved: true, orderStatus: 'SENT',
      },
    });
    const result = await guard.check({
      decisionId: decision.id, accountId: account.id, action: 'OPEN_BUY',
      entryPrice: 2650, touchEndT: IN_WINDOW_T - 60_000,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/DEMO/);
  });
});
