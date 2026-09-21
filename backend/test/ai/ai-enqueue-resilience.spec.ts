// AI_INTEGRATION_SPEC.md §0/§7: AI is a pure enrichment — a Redis/queue
// failure enqueueing AI generation must never affect the Alert/AlertDelivery
// outcome that already committed. Same pattern as
// test/rules/ingestion-resilience.spec.ts (Phase 4) and
// test/telegram/... (Phase 5) — override the queue with one that always
// throws, prove the primary pipeline is unaffected.
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../src/app.module';
import { RuleEngineService } from '../../src/alerts/rule-engine.service';
import { AI_ANALYSIS_QUEUE } from '../../src/jobs/jobs.constants';
import { RuleDefinitionsService } from '../../src/rules/rule-definitions.service';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';
import { seedSnapshot } from '../rules/seed';

describe('AI analysis enqueue failure isolation', () => {
  let prisma: PrismaClient;
  let context: INestApplicationContext;
  let ruleDefinitions: RuleDefinitionsService;
  let ruleEngine: RuleEngineService;
  let previousAiEnabled: string | undefined;

  beforeAll(async () => {
    previousAiEnabled = process.env.AI_ENABLED;
    process.env.AI_ENABLED = 'true';

    prisma = new PrismaClient();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AI_ANALYSIS_QUEUE)
      .useValue({
        add: async () => {
          throw new Error('simulated Redis outage for the AI analysis queue');
        },
        close: async () => {}, // QueueLifecycle (jobs.module.ts) calls this on teardown
      })
      .compile();
    context = await moduleRef.init();
    ruleDefinitions = context.get(RuleDefinitionsService);
    ruleEngine = context.get(RuleEngineService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await context.close();
    if (previousAiEnabled === undefined) delete process.env.AI_ENABLED;
    else process.env.AI_ENABLED = previousAiEnabled;
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a throwing AI_ANALYSIS_QUEUE never prevents the Alert/AlertDelivery from being created and delivered', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const now = new Date();
    await seedSnapshot(prisma, account.id, { capturedAt: now, balance: 10_000, equity: 10_000 });
    const rule = await ruleDefinitions.create(account.id, {
      name: 'resilience test',
      ruleType: 'DRAWDOWN',
      parameters: { threshold_pct: 0 },
    });

    // Must not throw despite the AI queue being completely broken.
    await expect(ruleEngine.evaluateAccount(account.id, now)).resolves.toBeDefined();

    const alert = await prisma.alert.findFirstOrThrow({ where: { ruleId: rule.id } });
    const delivery = await prisma.alertDelivery.findUniqueOrThrow({ where: { alertId: alert.id } });
    expect(delivery.status === 'PENDING' || delivery.status === 'SENT').toBe(true);

    // The AiAnalysis row still exists (created transactionally with the
    // Alert, independent of the enqueue) — it just never got picked up,
    // which is the correct, honest degradation (§7: a missed narrative,
    // never a missed alert).
    const analysis = await prisma.aiAnalysis.findUnique({ where: { alertId: alert.id } });
    expect(analysis).not.toBeNull();
    expect(analysis?.status).toBe('PENDING');
  });
});
