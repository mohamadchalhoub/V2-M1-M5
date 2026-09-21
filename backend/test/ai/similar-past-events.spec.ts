import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findSimilarPastEvents } from '../../src/ai/similar-past-events';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';

describe('findSimilarPastEvents', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  async function seedRuleAndAlerts(accountId: string, times: string[]) {
    const rule = await prisma.ruleDefinition.create({
      data: { accountId, name: 'r', ruleType: 'DRAWDOWN', parameters: { threshold_pct: 0.03 } },
    });
    const alerts = [];
    for (const t of times) {
      alerts.push(
        await prisma.alert.create({
          data: {
            ruleId: rule.id,
            accountId,
            triggeredAt: new Date(t),
            triggerValues: {},
            baselineSnapshot: {},
            ruleSnapshot: {},
          },
        }),
      );
    }
    return { rule, alerts };
  }

  it('returns the most recent past alerts for the same rule, excluding the current one', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const { alerts } = await seedRuleAndAlerts(account.id, [
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
      '2026-01-03T00:00:00Z',
      '2026-01-04T00:00:00Z',
    ]);
    const current = alerts[3];
    const rule = await prisma.ruleDefinition.findFirstOrThrow({ where: { accountId: account.id } });

    const events = await findSimilarPastEvents(prisma, rule.id, current.id, 3);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.alertId)).not.toContain(current.id);
    // Most recent first.
    expect(events[0].alertId).toBe(alerts[2].id);
  });

  it('derives briefOutcome from the gap to the next alert for that rule', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    // alerts[0] and alerts[1] are both "past"; alerts[2] is the current
    // alert being analyzed (excluded). alerts[0]'s outcome should measure
    // the gap to alerts[1] — never to the excluded current alert[2].
    const { alerts } = await seedRuleAndAlerts(account.id, [
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:40:00Z',
      '2026-01-02T00:00:00Z',
    ]);
    const rule = await prisma.ruleDefinition.findFirstOrThrow({ where: { accountId: account.id } });

    const events = await findSimilarPastEvents(prisma, rule.id, alerts[2].id, 3);
    expect(events).toHaveLength(2);
    const oldest = events.find((e) => e.alertId === alerts[0].id);
    expect(oldest?.briefOutcome).toMatch(/approximately 40 minute/);
  });

  it('says "no further alerts" for the most recent past event (no next alert exists)', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const { alerts } = await seedRuleAndAlerts(account.id, ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z']);
    const rule = await prisma.ruleDefinition.findFirstOrThrow({ where: { accountId: account.id } });

    const events = await findSimilarPastEvents(prisma, rule.id, alerts[1].id, 3);
    expect(events[0].briefOutcome).toMatch(/no further alerts/);
  });

  it('returns an empty array when there is no history for this rule', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const { alerts } = await seedRuleAndAlerts(account.id, ['2026-01-01T00:00:00Z']);
    const rule = await prisma.ruleDefinition.findFirstOrThrow({ where: { accountId: account.id } });

    const events = await findSimilarPastEvents(prisma, rule.id, alerts[0].id, 3);
    expect(events).toEqual([]);
  });

  it('never mixes in alerts from a different rule', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const { rule: ruleA, alerts: alertsA } = await seedRuleAndAlerts(account.id, ['2026-01-01T00:00:00Z']);
    const ruleB = await prisma.ruleDefinition.create({
      data: { accountId: account.id, name: 'other', ruleType: 'CONSECUTIVE_LOSSES', parameters: { count: 4 } },
    });
    await prisma.alert.create({
      data: {
        ruleId: ruleB.id,
        accountId: account.id,
        triggeredAt: new Date('2026-01-01T12:00:00Z'),
        triggerValues: {},
        baselineSnapshot: {},
        ruleSnapshot: {},
      },
    });

    const current = await prisma.alert.create({
      data: {
        ruleId: ruleA.id,
        accountId: account.id,
        triggeredAt: new Date('2026-01-02T00:00:00Z'),
        triggerValues: {},
        baselineSnapshot: {},
        ruleSnapshot: {},
      },
    });

    const events = await findSimilarPastEvents(prisma, ruleA.id, current.id, 3);
    expect(events).toHaveLength(1);
    expect(events[0].alertId).toBe(alertsA[0].id);
  });
});
