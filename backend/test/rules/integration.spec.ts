// The end-to-end integration test required by Phase 4's Definition of Done:
//
//   MT5-shaped data ingested over HTTP (as the real collector would send it)
//     → AnalyticsService → RuleEngineService → a deterministic Alert row,
//   with trigger_values/baseline_snapshot/rule_snapshot all populated.
//
// Deliberately goes through the same /collector/snapshot HTTP endpoint the
// real Python collector calls (test/helpers/http.ts's Fastify .inject()) —
// not a direct service call — so this proves the wiring in
// CollectorIngressController (RULE_ENGINE_SPEC.md §12.12 decision 4a)
// actually works, not just the RuleEngineService in isolation (covered
// already by rule-engine.spec.ts). No live MT5 involved — the collector's
// HTTP payload shape is reproduced directly, per RULE_ENGINE_SPEC.md §11.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { setupAccountWithToken, validPositionPayload, validSnapshotPayload } from '../helpers/factories';
import { request } from '../helpers/http';
import { RuleDefinitionsService } from '../../src/rules/rule-definitions.service';

describe('Integration: ingestion → analytics → rule engine → alert', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;
  let ruleDefinitions: RuleDefinitionsService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = new PrismaClient();
    ruleDefinitions = app.get(RuleDefinitionsService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('a real snapshot push that crosses a DRAWDOWN threshold produces a deterministic Alert with full trigger-time context', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const rule = await ruleDefinitions.create(account.id, {
      name: 'drawdown guard',
      ruleType: 'DRAWDOWN',
      parameters: { threshold_pct: 0.03 },
      cooldownSeconds: 1800,
    });

    // First push, exactly as the collector's 30s snapshot loop would send it
    // (RULE_ENGINE_SPEC.md §11 — this is HTTP ingestion shaped like the real
    // collector, not a live MT5 connection): establishes the all-time peak.
    const t0 = new Date();
    const peakPush = await request(app, {
      method: 'POST',
      url: '/collector/snapshot',
      headers: { authorization: `Bearer ${token}` },
      payload: validSnapshotPayload(account.id, {
        capturedAt: t0.toISOString(),
        balance: 10_000,
        equity: 10_000,
      }),
    });
    expect(peakPush.statusCode).toBe(201);

    // At this point the rule has been evaluated once already (synchronously,
    // as part of ingestion) — drawdown is 0 against its own peak, so no
    // alert yet.
    expect(await prisma.alert.count({ where: { ruleId: rule.id } })).toBe(0);

    // Second push, a moment later, down 4% from that peak — crosses the 3% threshold.
    const t1 = new Date(t0.getTime() + 1000);
    const drawdownPush = await request(app, {
      method: 'POST',
      url: '/collector/snapshot',
      headers: { authorization: `Bearer ${token}` },
      payload: validSnapshotPayload(account.id, {
        capturedAt: t1.toISOString(),
        balance: 9_600,
        equity: 9_600,
      }),
    });
    expect(drawdownPush.statusCode).toBe(201);

    // The alert must exist WITHOUT any separate "evaluate rules" call from
    // the test — ingestion alone drives it (RULE_ENGINE_SPEC.md §12.12
    // decision 4a; Phase 4 decision #4: "the dashboard must never be
    // required for rules to evaluate").
    const alerts = await prisma.alert.findMany({ where: { ruleId: rule.id } });
    expect(alerts).toHaveLength(1);

    const alert = alerts[0];
    expect(alert.accountId).toBe(account.id);
    expect((alert.triggerValues as any).drawdown).toBeCloseTo(0.04, 4);
    expect(alert.baselineSnapshot).toEqual({}); // DRAWDOWN has no baseline dependency
    expect((alert.ruleSnapshot as any).parameters.threshold_pct).toBe(0.03);
    expect((alert.ruleSnapshot as any).id).toBe(rule.id);
    expect((alert.ruleSnapshot as any).cooldownSeconds).toBe(1800);

    const state = await prisma.ruleState.findUnique({ where: { ruleId: rule.id } });
    expect(state?.state).toBe('ACTIVE');
    expect(state?.accountId).toBe(account.id);

    // A third push, still within cooldown and still breaching — deduplicated,
    // no second alert (RULE_ENGINE_SPEC.md §5).
    const t2 = new Date(t1.getTime() + 1000);
    await request(app, {
      method: 'POST',
      url: '/collector/snapshot',
      headers: { authorization: `Bearer ${token}` },
      payload: validSnapshotPayload(account.id, { capturedAt: t2.toISOString(), balance: 9_500, equity: 9_500 }),
    });
    expect(await prisma.alert.count({ where: { ruleId: rule.id } })).toBe(1);
  });

  it('market intelligence phase 5: a real upcoming HIGH-impact MarketEvent + real open-position exposure produces a HIGH_IMPACT_EVENT_EXPOSURE alert', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const rule = await ruleDefinitions.create(account.id, {
      name: 'event exposure guard',
      ruleType: 'HIGH_IMPACT_EVENT_EXPOSURE',
      parameters: { minutes_before: 60, minimum_exposure_volume: 1 },
      cooldownSeconds: 1800,
    });

    // A real MarketEvent row, exactly as MarketEventIngestionService (FRED)
    // would have written it — scheduled 30 minutes from now, inside the
    // rule's 60-minute lookahead window.
    await prisma.marketEvent.create({
      data: {
        source: 'FRED',
        externalId: '50',
        category: 'ECONOMIC_EVENT',
        title: 'Employment Situation (Nonfarm Payrolls)',
        scheduleType: 'EXPECTED',
        impact: 'HIGH',
        sentiment: 'UNCERTAIN',
        affectedCurrencies: ['USD'],
        scheduledAt: new Date(Date.now() + 30 * 60_000),
        rawPayload: {},
      },
    });

    const push = await request(app, {
      method: 'POST',
      url: '/collector/snapshot',
      headers: { authorization: `Bearer ${token}` },
      payload: validSnapshotPayload(account.id, {
        positions: [validPositionPayload({ symbol: 'EURUSD', volume: 2 })],
      }),
    });
    expect(push.statusCode).toBe(201);

    const alerts = await prisma.alert.findMany({ where: { ruleId: rule.id } });
    expect(alerts).toHaveLength(1);
    const exposures = (alerts[0].triggerValues as any).exposures;
    expect(exposures).toEqual([
      expect.objectContaining({ currency: 'USD', volume: 2 }),
    ]);
    // Risk context only — never a buy/sell instruction.
    expect(JSON.stringify(alerts[0].triggerValues).toLowerCase()).not.toMatch(/\bbuy\b|\bsell\b/);
  });

  it('ingestion still succeeds even for an account with no rules configured (rule evaluation is optional, never required)', async () => {
    const { account, token } = await setupAccountWithToken(prisma);

    const res = await request(app, {
      method: 'POST',
      url: '/collector/snapshot',
      headers: { authorization: `Bearer ${token}` },
      payload: validSnapshotPayload(account.id),
    });

    expect(res.statusCode).toBe(201);
    expect(await prisma.accountSnapshot.count({ where: { accountId: account.id } })).toBe(1);
  });
});
