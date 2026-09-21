// State-machine / cooldown / dedup / restart tests — drives
// AlertLifecycleService directly with synthetic RuleEvaluationResult objects
// so the transition table in RULE_ENGINE_SPEC.md §4/§5 is exercised in
// isolation from analytics. All Postgres-backed (rule_state/alerts must
// survive a "restart" — see the dedicated test below).
import { INestApplicationContext } from '@nestjs/common';
import { PrismaClient, RuleDefinition } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';
import { RuleEvaluationResult, RuleEvaluationStatus } from '../../src/rules/types/rule-engine.types';
import { buildRuleEngineContext } from './helpers';

function resultFor(
  rule: RuleDefinition,
  status: RuleEvaluationStatus,
  evaluatedAt: Date,
  triggerValues: Record<string, unknown> = { value: 1 },
): RuleEvaluationResult {
  return {
    ruleId: rule.id,
    accountId: rule.accountId,
    ruleType: rule.ruleType,
    evaluatedAt,
    status,
    reasonCode: `TEST_${status}`,
    triggerValues,
    baselineValues: { baseline: 1 },
    parameters: rule.parameters as Record<string, unknown>,
  };
}

describe('AlertLifecycleService (state machine)', () => {
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

  async function seedRule(cooldownSeconds: number | null = 1800) {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const rule = await ctx.ruleDefinitions.create(account.id, {
      name: 'test rule',
      ruleType: 'DRAWDOWN',
      parameters: { threshold_pct: 0.03 },
      cooldownSeconds: cooldownSeconds ?? undefined,
    });
    return { account, rule };
  }

  it('INACTIVE + TRIGGERED → creates one alert, state becomes ACTIVE', async () => {
    const { rule } = await seedRule();
    const t0 = new Date('2026-01-01T00:00:00Z');

    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.TRIGGERED, t0));

    const state = await ctx.ruleStates.get(rule.id);
    expect(state?.state).toBe('ACTIVE');
    expect(state?.lastTriggeredAt?.toISOString()).toBe(t0.toISOString());

    const alerts = await prisma.alert.findMany({ where: { ruleId: rule.id } });
    expect(alerts).toHaveLength(1);
  });

  it('repeated evaluation, condition unchanged (still TRIGGERED, within cooldown) → no new alert', async () => {
    const { rule } = await seedRule(1800);
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-01T00:10:00Z'); // 10 min later, within 30-min cooldown

    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.TRIGGERED, t0));
    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.TRIGGERED, t1));
    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.TRIGGERED, t1));

    const alerts = await prisma.alert.findMany({ where: { ruleId: rule.id } });
    expect(alerts).toHaveLength(1);
    const state = await ctx.ruleStates.get(rule.id);
    expect(state?.state).toBe('ACTIVE');
  });

  it('the 70-minute / 30-minute-cooldown worked example (RULE_ENGINE_SPEC.md §5) produces exactly three alerts', async () => {
    const { rule } = await seedRule(1800); // 30 min
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t15 = new Date('2026-01-01T00:15:00Z');
    const t30 = new Date('2026-01-01T00:30:00Z'); // cooldown elapsed exactly here
    const t45 = new Date('2026-01-01T00:45:00Z');
    const t60 = new Date('2026-01-01T01:00:00Z'); // cooldown elapsed again
    const t70 = new Date('2026-01-01T01:10:00Z');

    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.TRIGGERED, t0)); // alert #1
    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.TRIGGERED, t15)); // dedup
    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.TRIGGERED, t30)); // alert #2 (re-notify)
    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.TRIGGERED, t45)); // dedup
    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.TRIGGERED, t60)); // alert #3 (re-notify)
    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.NOT_TRIGGERED, t70)); // resolves

    const alerts = await prisma.alert.findMany({ where: { ruleId: rule.id }, orderBy: { triggeredAt: 'asc' } });
    expect(alerts).toHaveLength(3);
    expect(alerts.map((a) => a.triggeredAt.toISOString())).toEqual([
      t0.toISOString(),
      t30.toISOString(),
      t60.toISOString(),
    ]);

    const state = await ctx.ruleStates.get(rule.id);
    expect(state?.state).toBe('INACTIVE');
    expect(state?.resolvedAt?.toISOString()).toBe(t70.toISOString());
  });

  it('ACTIVE + NOT_TRIGGERED → resolves (state INACTIVE), no new alert', async () => {
    const { rule } = await seedRule();
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-01T00:05:00Z');

    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.TRIGGERED, t0));
    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.NOT_TRIGGERED, t1));

    const state = await ctx.ruleStates.get(rule.id);
    expect(state?.state).toBe('INACTIVE');
    expect(state?.cooldownUntil).toBeNull();
    const alerts = await prisma.alert.findMany({ where: { ruleId: rule.id } });
    expect(alerts).toHaveLength(1); // only the original trigger, no alert for resolving
  });

  it('condition becomes true again after resolving → a fresh episode, independent cooldown clock', async () => {
    const { rule } = await seedRule(1800);
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-01T00:05:00Z'); // resolves
    const t2 = new Date('2026-01-01T00:06:00Z'); // re-triggers ONE MINUTE later — well within the old cooldown

    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.TRIGGERED, t0));
    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.NOT_TRIGGERED, t1));
    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.TRIGGERED, t2));

    const alerts = await prisma.alert.findMany({ where: { ruleId: rule.id }, orderBy: { triggeredAt: 'asc' } });
    // A fresh trigger right after resolving is a NEW episode, not bound by
    // the previous episode's cooldown — this must fire immediately.
    expect(alerts).toHaveLength(2);
    const state = await ctx.ruleStates.get(rule.id);
    expect(state?.state).toBe('ACTIVE');
    expect(state?.lastTriggeredAt?.toISOString()).toBe(t2.toISOString());
  });

  it('INSUFFICIENT_DATA is a true no-op — never resolves an ACTIVE alert, never creates one from INACTIVE', async () => {
    const { rule } = await seedRule();
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-01T00:05:00Z');

    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.TRIGGERED, t0));
    let state = await ctx.ruleStates.get(rule.id);
    expect(state?.state).toBe('ACTIVE');

    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.INSUFFICIENT_DATA, t1));
    state = await ctx.ruleStates.get(rule.id);
    expect(state?.state).toBe('ACTIVE'); // unchanged, not resolved

    const alerts = await prisma.alert.findMany({ where: { ruleId: rule.id } });
    expect(alerts).toHaveLength(1); // no second alert created either
  });

  it('a custom (non-default) cooldownSeconds is honored, not RULE_DEFAULT_COOLDOWN_SECONDS', async () => {
    const { rule } = await seedRule(60); // 1 minute
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t30s = new Date('2026-01-01T00:00:30Z'); // within 60s cooldown
    const t61s = new Date('2026-01-01T00:01:01Z'); // past 60s cooldown

    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.TRIGGERED, t0));
    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.TRIGGERED, t30s));
    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.TRIGGERED, t61s));

    const alerts = await prisma.alert.findMany({ where: { ruleId: rule.id } });
    expect(alerts).toHaveLength(2); // t0 and t61s, not t30s
  });

  it('two concurrent apply() calls for the same rule+account/TRIGGERED result never create two alerts (Phase 4 review — concurrency fix)', async () => {
    const { rule } = await seedRule();
    const t0 = new Date('2026-01-01T00:00:00Z');
    const result = resultFor(rule, RuleEvaluationStatus.TRIGGERED, t0);

    // Simulates two near-simultaneous ingestion requests for the same
    // account (e.g. two collector processes, or a retried push landing
    // alongside the original) both evaluating the same rule at once.
    await Promise.all([ctx.alertLifecycle.apply(rule, result), ctx.alertLifecycle.apply(rule, result)]);

    const alerts = await prisma.alert.findMany({ where: { ruleId: rule.id } });
    expect(alerts).toHaveLength(1);
    const state = await ctx.ruleStates.get(rule.id);
    expect(state?.state).toBe('ACTIVE');
  });

  it('restart simulation: a fresh service instance reading rule_state from Postgres continues the same episode without a duplicate alert or a lost cooldown', async () => {
    const { rule } = await seedRule(1800);
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t10 = new Date('2026-01-01T00:10:00Z');

    await ctx.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.TRIGGERED, t0));

    // Simulate a process restart: build a brand-new DI graph (fresh
    // AlertLifecycleService instance, no in-memory state carried over) and
    // continue the same episode through it.
    const restarted = await buildRuleEngineContext();
    try {
      await restarted.alertLifecycle.apply(rule, resultFor(rule, RuleEvaluationStatus.TRIGGERED, t10));

      const alerts = await prisma.alert.findMany({ where: { ruleId: rule.id } });
      expect(alerts).toHaveLength(1); // still within the 30-min cooldown — no duplicate
      const state = await restarted.ruleStates.get(rule.id);
      expect(state?.state).toBe('ACTIVE');
    } finally {
      await restarted.context.close();
    }
  });
});
