import { INestApplicationContext } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';
import { buildRuleEngineContext } from './helpers';

describe('RuleDefinitionsService', () => {
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

  it('rejects invalid parameters per rule_type instead of persisting a malformed rule', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);

    await expect(
      ctx.ruleDefinitions.create(account.id, {
        name: 'bad drawdown',
        ruleType: 'DRAWDOWN',
        parameters: { threshold_pct: 1.5 }, // out of [0,1] range
      }),
    ).rejects.toThrow();

    await expect(
      ctx.ruleDefinitions.create(account.id, {
        name: 'bad consecutive losses',
        ruleType: 'CONSECUTIVE_LOSSES',
        parameters: { count: 0 }, // must be >= 1
      }),
    ).rejects.toThrow();

    await expect(
      ctx.ruleDefinitions.create(account.id, {
        name: 'bad position size',
        ruleType: 'POSITION_SIZE_MULTIPLE',
        parameters: { factor: 2, baseline: 'median' }, // not 'avg' | 'max'
      }),
    ).rejects.toThrow();

    await expect(
      ctx.ruleDefinitions.create(account.id, {
        name: 'wrong shape entirely',
        ruleType: 'DAILY_LOSS_LIMIT',
        parameters: { count: 4 }, // CONSECUTIVE_LOSSES's shape, not this type's
      }),
    ).rejects.toThrow();

    const rules = await prisma.ruleDefinition.findMany({ where: { accountId: account.id } });
    expect(rules).toHaveLength(0);
  });

  it('accepts valid parameters for every leaf rule type', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);

    const dailyLoss = await ctx.ruleDefinitions.create(account.id, {
      name: 'daily loss',
      ruleType: 'DAILY_LOSS_LIMIT',
      parameters: { threshold_pct: 0.05 },
    });
    const drawdown = await ctx.ruleDefinitions.create(account.id, {
      name: 'drawdown',
      ruleType: 'DRAWDOWN',
      parameters: { threshold_pct: 0.03 },
    });
    const streak = await ctx.ruleDefinitions.create(account.id, {
      name: 'streak',
      ruleType: 'CONSECUTIVE_LOSSES',
      parameters: { count: 4 },
    });
    const size = await ctx.ruleDefinitions.create(account.id, {
      name: 'size',
      ruleType: 'POSITION_SIZE_MULTIPLE',
      parameters: { factor: 2, baseline: 'avg' },
    });
    const freq = await ctx.ruleDefinitions.create(account.id, {
      name: 'freq',
      ruleType: 'TRADE_FREQUENCY_MULTIPLE',
      parameters: { factor: 3, window_minutes: 60 },
    });

    expect([dailyLoss.id, drawdown.id, streak.id, size.id, freq.id].every(Boolean)).toBe(true);
  });

  it('COMPOUND: rejects a component belonging to a different account', async () => {
    const user = await createUser(prisma);
    const accountA = await createTradingAccount(prisma, user.id);
    const accountB = await createTradingAccount(prisma, user.id);

    const foreignRule = await ctx.ruleDefinitions.create(accountB.id, {
      name: 'foreign',
      ruleType: 'DRAWDOWN',
      parameters: { threshold_pct: 0.03 },
    });
    const ownRule = await ctx.ruleDefinitions.create(accountA.id, {
      name: 'own',
      ruleType: 'CONSECUTIVE_LOSSES',
      parameters: { count: 4 },
    });

    await expect(
      ctx.ruleDefinitions.create(accountA.id, {
        name: 'cross-account compound',
        ruleType: 'COMPOUND',
        parameters: { combinator: 'AND', component_rule_ids: [foreignRule.id, ownRule.id] },
      }),
    ).rejects.toThrow(/same account/i);
  });

  it('COMPOUND: rejects a component that is itself COMPOUND (no nesting)', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);

    const leaf1 = await ctx.ruleDefinitions.create(account.id, {
      name: 'leaf1',
      ruleType: 'DRAWDOWN',
      parameters: { threshold_pct: 0.03 },
    });
    const leaf2 = await ctx.ruleDefinitions.create(account.id, {
      name: 'leaf2',
      ruleType: 'CONSECUTIVE_LOSSES',
      parameters: { count: 4 },
    });
    const innerCompound = await ctx.ruleDefinitions.create(account.id, {
      name: 'inner',
      ruleType: 'COMPOUND',
      parameters: { combinator: 'AND', component_rule_ids: [leaf1.id, leaf2.id] },
    });

    await expect(
      ctx.ruleDefinitions.create(account.id, {
        name: 'nested compound',
        ruleType: 'COMPOUND',
        parameters: { combinator: 'OR', component_rule_ids: [innerCompound.id, leaf1.id] },
      }),
    ).rejects.toThrow(/COMPOUND/i);
  });

  it('COMPOUND: rejects a nonexistent component_rule_id', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const leaf = await ctx.ruleDefinitions.create(account.id, {
      name: 'leaf',
      ruleType: 'DRAWDOWN',
      parameters: { threshold_pct: 0.03 },
    });

    await expect(
      ctx.ruleDefinitions.create(account.id, {
        name: 'dangling compound',
        ruleType: 'COMPOUND',
        parameters: { combinator: 'AND', component_rule_ids: [leaf.id, '00000000-0000-4000-8000-000000000000'] },
      }),
    ).rejects.toThrow();
  });

  it('COMPOUND: rejects duplicate component_rule_ids', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const leaf = await ctx.ruleDefinitions.create(account.id, {
      name: 'leaf',
      ruleType: 'DRAWDOWN',
      parameters: { threshold_pct: 0.03 },
    });
    const leaf2 = await ctx.ruleDefinitions.create(account.id, {
      name: 'leaf2',
      ruleType: 'CONSECUTIVE_LOSSES',
      parameters: { count: 4 },
    });

    await expect(
      ctx.ruleDefinitions.create(account.id, {
        name: 'duplicate components',
        ruleType: 'COMPOUND',
        parameters: { combinator: 'AND', component_rule_ids: [leaf.id, leaf.id, leaf2.id] },
      }),
    ).rejects.toThrow(/duplicate/i);
  });

  it('accepts a valid COMPOUND rule whose components belong to the same account', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const leaf1 = await ctx.ruleDefinitions.create(account.id, {
      name: 'leaf1',
      ruleType: 'DRAWDOWN',
      parameters: { threshold_pct: 0.03 },
    });
    const leaf2 = await ctx.ruleDefinitions.create(account.id, {
      name: 'leaf2',
      ruleType: 'CONSECUTIVE_LOSSES',
      parameters: { count: 4 },
    });

    const compound = await ctx.ruleDefinitions.create(account.id, {
      name: 'compound',
      ruleType: 'COMPOUND',
      parameters: { combinator: 'AND', component_rule_ids: [leaf1.id, leaf2.id] },
    });
    expect(compound.id).toBeDefined();
  });

  it('rule configurations are account-specific — the same-named rule on two accounts has independent parameters', async () => {
    const user = await createUser(prisma);
    const accountA = await createTradingAccount(prisma, user.id);
    const accountB = await createTradingAccount(prisma, user.id);

    const ruleA = await ctx.ruleDefinitions.create(accountA.id, {
      name: 'daily loss',
      ruleType: 'DAILY_LOSS_LIMIT',
      parameters: { threshold_pct: 0.05 },
    });
    const ruleB = await ctx.ruleDefinitions.create(accountB.id, {
      name: 'daily loss',
      ruleType: 'DAILY_LOSS_LIMIT',
      parameters: { threshold_pct: 0.10 },
      cooldownSeconds: 60,
    });

    expect(ruleA.id).not.toBe(ruleB.id);
    expect((ruleA.parameters as any).threshold_pct).toBe(0.05);
    expect((ruleB.parameters as any).threshold_pct).toBe(0.1);
    expect(ruleB.cooldownSeconds).toBe(60);
    expect(ruleA.cooldownSeconds).toBeNull();

    const forA = await ctx.ruleDefinitions.findEnabledForAccount(accountA.id);
    const forB = await ctx.ruleDefinitions.findEnabledForAccount(accountB.id);
    expect(forA.map((r) => r.id)).toEqual([ruleA.id]);
    expect(forB.map((r) => r.id)).toEqual([ruleB.id]);
  });

  it('disabling a rule that was ACTIVE resets its rule_state to INACTIVE (protects COMPOUND rules from stale ACTIVE state)', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const rule = await ctx.ruleDefinitions.create(account.id, {
      name: 'drawdown',
      ruleType: 'DRAWDOWN',
      parameters: { threshold_pct: 0.03 },
    });

    await ctx.ruleStates.markActive(rule.id, account.id, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:30:00Z'));
    let state = await ctx.ruleStates.get(rule.id);
    expect(state?.state).toBe('ACTIVE');

    await ctx.ruleDefinitions.setEnabled(rule.id, false, new Date('2026-01-01T01:00:00Z'));

    state = await ctx.ruleStates.get(rule.id);
    expect(state?.state).toBe('INACTIVE');
    expect(state?.cooldownUntil).toBeNull();

    const updatedRule = await ctx.ruleDefinitions.getOrThrow(rule.id);
    expect(updatedRule.enabled).toBe(false);
  });

  it('a disabled rule is excluded from findEnabledForAccount', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const rule = await ctx.ruleDefinitions.create(account.id, {
      name: 'drawdown',
      ruleType: 'DRAWDOWN',
      parameters: { threshold_pct: 0.03 },
    });
    await ctx.ruleDefinitions.setEnabled(rule.id, false);

    const enabled = await ctx.ruleDefinitions.findEnabledForAccount(account.id);
    expect(enabled).toHaveLength(0);
  });

  describe('ICHIMOKU_BREAKOUT cooldown must outlast the breakout freshness window (reliability fix)', () => {
    it('rejects a cooldown shorter than or equal to the 900s freshness window', async () => {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id);

      await expect(
        ctx.ruleDefinitions.create(account.id, {
          name: 'too-short cooldown',
          ruleType: 'ICHIMOKU_BREAKOUT',
          parameters: {},
          cooldownSeconds: 900, // exactly the freshness window — must be strictly greater
        }),
      ).rejects.toThrow(/freshness window/);

      await expect(
        ctx.ruleDefinitions.create(account.id, {
          name: 'way too short',
          ruleType: 'ICHIMOKU_BREAKOUT',
          parameters: {},
          cooldownSeconds: 60,
        }),
      ).rejects.toThrow(/freshness window/);

      expect(await prisma.ruleDefinition.count({ where: { accountId: account.id } })).toBe(0);
    });

    it('accepts a cooldown longer than the freshness window, or null (defers to the system default, itself longer)', async () => {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id);

      await expect(
        ctx.ruleDefinitions.create(account.id, {
          name: 'ok cooldown',
          ruleType: 'ICHIMOKU_BREAKOUT',
          parameters: {},
          cooldownSeconds: 1800,
        }),
      ).resolves.toBeDefined();

      await expect(
        ctx.ruleDefinitions.create(account.id, {
          name: 'no explicit cooldown',
          ruleType: 'ICHIMOKU_BREAKOUT',
          parameters: {},
        }),
      ).resolves.toBeDefined();
    });

    it('other rule types are unaffected by this check even with a very short cooldown', async () => {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id);

      await expect(
        ctx.ruleDefinitions.create(account.id, {
          name: 'drawdown, short cooldown',
          ruleType: 'DRAWDOWN',
          parameters: { threshold_pct: 0.03 },
          cooldownSeconds: 10,
        }),
      ).resolves.toBeDefined();
    });

    it('also enforced on update — cannot shorten an existing rule below the freshness window', async () => {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id);
      const rule = await ctx.ruleDefinitions.create(account.id, {
        name: 'ichimoku',
        ruleType: 'ICHIMOKU_BREAKOUT',
        parameters: {},
        cooldownSeconds: 1800,
      });

      await expect(
        ctx.ruleDefinitions.update(rule.id, { cooldownSeconds: 300 }),
      ).rejects.toThrow(/freshness window/);
    });
  });
});
