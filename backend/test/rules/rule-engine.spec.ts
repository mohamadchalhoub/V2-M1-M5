// End-to-end RuleEngineService.evaluateAccount tests against real seeded
// Postgres rows (no live MT5) — RULE_ENGINE_SPEC.md §10.2/§10.3.
import { INestApplicationContext } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';
import { buildRuleEngineContext } from './helpers';
import { seedClosingTrade, seedInDeal, seedOpenPosition, seedSnapshot } from './seed';

describe('RuleEngineService.evaluateAccount', () => {
  let prisma: PrismaClient;
  let context: INestApplicationContext;
  let ctx: Awaited<ReturnType<typeof buildRuleEngineContext>>;

  beforeAll(async () => {
    prisma = new PrismaClient();
    ctx = await buildRuleEngineContext();
    context = ctx.context;
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await context.close();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  /** The "bad session" worked example (Phase 0 §23 / RULE_ENGINE_SPEC.md §2.6): 0.50 lots after four losses at 3.8% drawdown. */
  async function seedBadSession(accountId: string) {
    // Baseline: small opening volumes a few days before "today", so
    // averagePositionVolume ≈ 0.2.
    await seedInDeal(prisma, accountId, { executedAt: new Date('2026-06-05T09:00:00Z'), volume: 0.2 });
    await seedInDeal(prisma, accountId, { executedAt: new Date('2026-06-06T09:00:00Z'), volume: 0.2 });
    await seedInDeal(prisma, accountId, { executedAt: new Date('2026-06-07T09:00:00Z'), volume: 0.2 });

    // Anchor snapshot for "today" (2026-06-10T00:00:00Z boundary) and the
    // all-time equity peak.
    await seedSnapshot(prisma, accountId, {
      capturedAt: new Date('2026-06-09T23:00:00Z'),
      balance: 10_000,
      equity: 10_000,
    });

    // Four consecutive losing closing deals today.
    for (let i = 0; i < 4; i++) {
      const hour = String(1 + i).padStart(2, '0');
      await seedClosingTrade(prisma, accountId, {
        executedAt: new Date(`2026-06-10T${hour}:00:00Z`),
        profit: -100,
      });
    }

    // Latest snapshot: equity down 3.8% from the 10,000 peak.
    await seedSnapshot(prisma, accountId, {
      capturedAt: new Date('2026-06-10T10:00:00Z'),
      balance: 9_600,
      equity: 9_620,
    });

    // The oversized open position (0.50 lots vs ~0.20 baseline).
    await seedOpenPosition(prisma, accountId, { volume: 0.5, openedAt: new Date('2026-06-10T10:30:00Z') });
  }

  async function seedThreeLeafRules(accountId: string) {
    const drawdown = await ctx.ruleDefinitions.create(accountId, {
      name: 'drawdown',
      ruleType: 'DRAWDOWN',
      parameters: { threshold_pct: 0.03 },
    });
    const streak = await ctx.ruleDefinitions.create(accountId, {
      name: 'consecutive losses',
      ruleType: 'CONSECUTIVE_LOSSES',
      parameters: { count: 4 },
    });
    const size = await ctx.ruleDefinitions.create(accountId, {
      name: 'position size',
      ruleType: 'POSITION_SIZE_MULTIPLE',
      parameters: { factor: 2, baseline: 'avg' },
    });
    return { drawdown, streak, size };
  }

  const NOW = new Date('2026-06-10T12:00:00Z');

  it('DAILY_LOSS_LIMIT triggers end-to-end from ingested snapshot data', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    await seedSnapshot(prisma, account.id, { capturedAt: new Date('2026-06-09T23:00:00Z'), balance: 10_000, equity: 10_000 });
    await seedSnapshot(prisma, account.id, { capturedAt: new Date('2026-06-10T10:00:00Z'), balance: 9_480, equity: 9_480 });
    await ctx.ruleDefinitions.create(account.id, {
      name: 'daily loss',
      ruleType: 'DAILY_LOSS_LIMIT',
      parameters: { threshold_pct: 0.05 },
    });

    const results = await ctx.ruleEngine.evaluateAccount(account.id, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('TRIGGERED');

    const alerts = await prisma.alert.findMany({ where: { accountId: account.id } });
    expect(alerts).toHaveLength(1);
  });

  it('multiple starter rules trigger simultaneously — each gets its own independent alert', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    await seedBadSession(account.id);
    const { drawdown, streak, size } = await seedThreeLeafRules(account.id);

    const results = await ctx.ruleEngine.evaluateAccount(account.id, NOW);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'TRIGGERED')).toBe(true);

    const alerts = await prisma.alert.findMany({ where: { accountId: account.id } });
    expect(alerts.map((a) => a.ruleId).sort()).toEqual([drawdown.id, streak.id, size.id].sort());
  });

  it('COMPOUND AND — triggers only once all three components are ACTIVE (the "risk escalation" worked example)', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    await seedBadSession(account.id);
    const { drawdown, streak, size } = await seedThreeLeafRules(account.id);
    const compound = await ctx.ruleDefinitions.create(account.id, {
      name: 'risk escalation',
      ruleType: 'COMPOUND',
      parameters: { combinator: 'AND', component_rule_ids: [drawdown.id, streak.id, size.id] },
    });

    const results = await ctx.ruleEngine.evaluateAccount(account.id, NOW);
    const compoundResult = results.find((r) => r.ruleId === compound.id);
    expect(compoundResult?.status).toBe('TRIGGERED');

    const compoundAlert = await prisma.alert.findFirst({ where: { ruleId: compound.id } });
    expect(compoundAlert).not.toBeNull();
  });

  it('COMPOUND AND — does not trigger when only two of three components are ACTIVE', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    await seedBadSession(account.id);
    const { drawdown, streak, size } = await seedThreeLeafRules(account.id);
    // Raise the drawdown threshold so it does NOT trigger this time.
    await ctx.ruleDefinitions.update(drawdown.id, { parameters: { threshold_pct: 0.5 } });
    const compound = await ctx.ruleDefinitions.create(account.id, {
      name: 'risk escalation',
      ruleType: 'COMPOUND',
      parameters: { combinator: 'AND', component_rule_ids: [drawdown.id, streak.id, size.id] },
    });

    const results = await ctx.ruleEngine.evaluateAccount(account.id, NOW);
    const compoundResult = results.find((r) => r.ruleId === compound.id);
    expect(compoundResult?.status).toBe('NOT_TRIGGERED');

    const compoundAlert = await prisma.alert.findFirst({ where: { ruleId: compound.id } });
    expect(compoundAlert).toBeNull();
  });

  it('COMPOUND OR — triggers when just one component is ACTIVE', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    await seedBadSession(account.id);
    const { drawdown, streak, size } = await seedThreeLeafRules(account.id);
    // Only the streak rule will actually be satisfied.
    await ctx.ruleDefinitions.update(drawdown.id, { parameters: { threshold_pct: 0.5 } });
    await ctx.ruleDefinitions.update(size.id, { parameters: { factor: 100, baseline: 'avg' } });
    const compound = await ctx.ruleDefinitions.create(account.id, {
      name: 'any warning sign',
      ruleType: 'COMPOUND',
      parameters: { combinator: 'OR', component_rule_ids: [drawdown.id, streak.id, size.id] },
    });

    const results = await ctx.ruleEngine.evaluateAccount(account.id, NOW);
    const compoundResult = results.find((r) => r.ruleId === compound.id);
    expect(compoundResult?.status).toBe('TRIGGERED');
  });

  it('a disabled rule is never evaluated and never produces an alert', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    await seedBadSession(account.id);
    const { drawdown } = await seedThreeLeafRules(account.id);
    await ctx.ruleDefinitions.setEnabled(drawdown.id, false);

    const results = await ctx.ruleEngine.evaluateAccount(account.id, NOW);
    expect(results.find((r) => r.ruleId === drawdown.id)).toBeUndefined();

    const alerts = await prisma.alert.findMany({ where: { ruleId: drawdown.id } });
    expect(alerts).toHaveLength(0);
  });

  it('TRADE_FREQUENCY_MULTIPLE triggers end-to-end on a burst of trades against a real baseline', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);

    // Baseline: ~1 trade/hour over the prior few days.
    for (let day = 5; day <= 9; day++) {
      await seedClosingTrade(prisma, account.id, {
        executedAt: new Date(`2026-06-0${day}T09:00:00Z`),
        profit: 5,
      });
    }
    await seedSnapshot(prisma, account.id, { capturedAt: new Date('2026-06-09T23:00:00Z'), balance: 10_000, equity: 10_000 });

    // A burst: 5 closing trades in the last 30 minutes before NOW.
    for (let i = 0; i < 5; i++) {
      await seedClosingTrade(prisma, account.id, {
        executedAt: new Date(NOW.getTime() - (5 + i) * 60_000),
        profit: -10,
      });
    }

    await ctx.ruleDefinitions.create(account.id, {
      name: 'overtrading',
      ruleType: 'TRADE_FREQUENCY_MULTIPLE',
      parameters: { factor: 2, window_minutes: 30 },
    });

    const results = await ctx.ruleEngine.evaluateAccount(account.id, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('TRIGGERED');
  });

  it('account isolation: identical rule configs on two accounts evaluate independently', async () => {
    const user = await createUser(prisma);
    const accountA = await createTradingAccount(prisma, user.id);
    const accountB = await createTradingAccount(prisma, user.id);

    await seedBadSession(accountA.id);
    // Account B: healthy, no drawdown, no losing streak.
    await seedSnapshot(prisma, accountB.id, { capturedAt: new Date('2026-06-09T23:00:00Z'), balance: 10_000, equity: 10_000 });
    await seedSnapshot(prisma, accountB.id, { capturedAt: new Date('2026-06-10T10:00:00Z'), balance: 10_050, equity: 10_050 });

    const ruleA = await ctx.ruleDefinitions.create(accountA.id, {
      name: 'drawdown',
      ruleType: 'DRAWDOWN',
      parameters: { threshold_pct: 0.03 },
    });
    const ruleB = await ctx.ruleDefinitions.create(accountB.id, {
      name: 'drawdown',
      ruleType: 'DRAWDOWN',
      parameters: { threshold_pct: 0.03 },
    });

    const resultsA = await ctx.ruleEngine.evaluateAccount(accountA.id, NOW);
    const resultsB = await ctx.ruleEngine.evaluateAccount(accountB.id, NOW);

    expect(resultsA.find((r) => r.ruleId === ruleA.id)?.status).toBe('TRIGGERED');
    expect(resultsB.find((r) => r.ruleId === ruleB.id)?.status).toBe('NOT_TRIGGERED');

    const alertsA = await prisma.alert.findMany({ where: { accountId: accountA.id } });
    const alertsB = await prisma.alert.findMany({ where: { accountId: accountB.id } });
    expect(alertsA).toHaveLength(1);
    expect(alertsB).toHaveLength(0);
    expect(alertsA[0].accountId).toBe(accountA.id);
  });

  it('historical trigger snapshots are immutable: editing a rule after it fires never rewrites the old alert', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    await seedBadSession(account.id);
    const rule = await ctx.ruleDefinitions.create(account.id, {
      name: 'drawdown',
      ruleType: 'DRAWDOWN',
      parameters: { threshold_pct: 0.03 },
    });

    await ctx.ruleEngine.evaluateAccount(account.id, NOW);
    const alert = await prisma.alert.findFirstOrThrow({ where: { ruleId: rule.id } });
    expect((alert.ruleSnapshot as any).parameters.threshold_pct).toBe(0.03);
    expect((alert.triggerValues as any).drawdown).toBeCloseTo(0.038, 3);

    // Retune the rule after the fact.
    await ctx.ruleDefinitions.update(rule.id, { parameters: { threshold_pct: 0.1 } });

    const sameAlertReread = await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } });
    expect((sameAlertReread.ruleSnapshot as any).parameters.threshold_pct).toBe(0.03);
    expect((sameAlertReread.triggerValues as any).drawdown).toBeCloseTo(0.038, 3);
    expect(sameAlertReread.triggeredAt.toISOString()).toBe(alert.triggeredAt.toISOString());
  });

  it('an account with no enabled rules evaluates to an empty result with no analytics calls needed', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const results = await ctx.ruleEngine.evaluateAccount(account.id, NOW);
    expect(results).toEqual([]);
  });

  it('a brand-new account with no data at all never triggers, and reports INSUFFICIENT_DATA where expected', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    await ctx.ruleDefinitions.create(account.id, {
      name: 'drawdown',
      ruleType: 'DRAWDOWN',
      parameters: { threshold_pct: 0.03 },
    });
    await ctx.ruleDefinitions.create(account.id, {
      name: 'streak',
      ruleType: 'CONSECUTIVE_LOSSES',
      parameters: { count: 4 },
    });

    const results = await ctx.ruleEngine.evaluateAccount(account.id, NOW);
    const drawdownResult = results.find((r) => r.ruleType === 'DRAWDOWN');
    const streakResult = results.find((r) => r.ruleType === 'CONSECUTIVE_LOSSES');
    expect(drawdownResult?.status).toBe('INSUFFICIENT_DATA'); // no snapshots yet
    expect(streakResult?.status).toBe('NOT_TRIGGERED'); // 0 trades is a known, boring answer

    const alerts = await prisma.alert.findMany({ where: { accountId: account.id } });
    expect(alerts).toHaveLength(0);
  });
});
