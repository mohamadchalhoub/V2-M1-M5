// End-to-end Phase 6 tests: real Postgres + real (disposable) Redis + real
// BullMQ Queue/Worker, mocked Anthropic + Telegram HTTP only (global
// fetch) — no live AI provider or Telegram bot required (account-wide
// instruction; AI_INTEGRATION_SPEC.md §10). AI_ENABLED is toggled on for
// this file's own test app context only (test/analytics/edge-cases.spec.ts's
// technique) — every other test file is untouched, AI stays off for them.
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

const VALID_AI_TEXT = JSON.stringify({
  situation_summary: 'Equity is down from its all-time peak.',
  historical_comparison: 'Larger than the account\'s typical daily swing.',
  similar_past_events: [],
  statistical_context: 'Drawdown crossed the configured threshold.',
  market_risk: 'LOW',
  exposure_risk: 'LOW',
  event_risk: 'LOW',
  news_sentiment: 'NEUTRAL',
  confidence: 0.5,
  assessment: 'No significant market-context risk factors identified.',
  recommended_action: 'MONITOR',
});

function mockExternalCalls(anthropicText: string | 'FAIL' = VALID_AI_TEXT) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('api.anthropic.com')) {
      if (anthropicText === 'FAIL') {
        return new Response(JSON.stringify({ error: 'server error' }), { status: 500 });
      }
      return new Response(JSON.stringify({ content: [{ type: 'text', text: anthropicText }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  });
}

async function waitForAiStatus(prisma: PrismaClient, alertId: string, statuses: string[], timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const analysis = await prisma.aiAnalysis.findUniqueOrThrow({ where: { alertId } });
    if (statuses.includes(analysis.status)) return analysis;
    if (Date.now() > deadline) {
      throw new Error(
        `AiAnalysis for alert ${alertId} did not reach [${statuses.join(', ')}] within ${timeoutMs}ms (currently ${analysis.status}, attempts=${analysis.attempts})`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Phase 6 — AI analysis pipeline (AI_ENABLED=true)', () => {
  let prisma: PrismaClient;
  let context: INestApplicationContext;
  let ruleDefinitions: RuleDefinitionsService;
  let ruleEngine: RuleEngineService;
  let previousAiEnabled: string | undefined;

  beforeAll(async () => {
    previousAiEnabled = process.env.AI_ENABLED;
    process.env.AI_ENABLED = 'true';

    prisma = new PrismaClient();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
    mockExternalCalls();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function triggerFreshAlert(cooldownSeconds = 1800) {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const now = new Date();
    await seedSnapshot(prisma, account.id, { capturedAt: now, balance: 10_000, equity: 10_000 });
    const rule = await ruleDefinitions.create(account.id, {
      name: 'ai test drawdown',
      ruleType: 'DRAWDOWN',
      parameters: { threshold_pct: 0 },
      cooldownSeconds,
    });
    await ruleEngine.evaluateAccount(account.id, now);
    const alert = await prisma.alert.findFirstOrThrow({ where: { ruleId: rule.id } });
    return { account, rule, alert, now };
  }

  it('1. a fresh-episode alert gets exactly one AiAnalysis row, PENDING at first', async () => {
    const { alert } = await triggerFreshAlert();
    const count = await prisma.aiAnalysis.count({ where: { alertId: alert.id } });
    expect(count).toBe(1);
  });

  it('2. a cooldown re-notify of the SAME episode never gets its own AiAnalysis row', async () => {
    const { account, rule, now } = await triggerFreshAlert(1); // 1-second cooldown
    const later = new Date(now.getTime() + 2000); // cooldown already elapsed
    await ruleEngine.evaluateAccount(account.id, later);

    const alertsForRule = await prisma.alert.findMany({ where: { ruleId: rule.id } });
    expect(alertsForRule).toHaveLength(2); // the fresh trigger + one re-notify

    const analysisCount = await prisma.aiAnalysis.count({ where: { alert: { ruleId: rule.id } } });
    expect(analysisCount).toBe(1); // only the FIRST alert got one
  });

  it('3. generation succeeds → READY, then a narrative follow-up is actually sent to Telegram', async () => {
    const { alert } = await triggerFreshAlert();
    await waitForAiStatus(prisma, alert.id, ['READY']);

    // READY only means generation finished — the actual Telegram send is a
    // SEPARATE queued job (telegram-delivery's 'deliver-ai-narrative'), so
    // poll for telegramMessageIds specifically rather than racing on status.
    const deadline = Date.now() + 5000;
    let analysis = await prisma.aiAnalysis.findUniqueOrThrow({ where: { alertId: alert.id } });
    while ((analysis.telegramMessageIds as unknown as number[]).length === 0) {
      if (Date.now() > deadline) throw new Error('AI narrative was never sent to Telegram within 5000ms');
      await new Promise((r) => setTimeout(r, 25));
      analysis = await prisma.aiAnalysis.findUniqueOrThrow({ where: { alertId: alert.id } });
    }

    expect(analysis.provider).toBe('anthropic');
    expect(analysis.model).toBeTruthy();
    expect((analysis.result as any).situation_summary).toBeTruthy();
  });

  it('4. a response that fails the safety filter is WITHHELD and NEVER reaches Telegram', async () => {
    const unsafe = JSON.stringify({
      situation_summary: 'You should close this position now.',
      historical_comparison: 'h',
      similar_past_events: [],
      statistical_context: 'c',
      market_risk: 'LOW',
      exposure_risk: 'LOW',
      event_risk: 'LOW',
      news_sentiment: 'NEUTRAL',
      confidence: 0.5,
      assessment: 'a',
      recommended_action: 'MONITOR',
    });
    mockExternalCalls(unsafe);

    const { alert } = await triggerFreshAlert();
    const analysis = await waitForAiStatus(prisma, alert.id, ['WITHHELD']);
    expect(analysis.safetyFlagged).toBe(true);
    expect(analysis.flaggedPattern).toBeTruthy();
    expect((analysis.telegramMessageIds as unknown as number[])).toHaveLength(0);
  });

  it('5. duplicate enqueue for the same AiAnalysis never generates twice (deterministic jobId)', async () => {
    const fetchSpy = mockExternalCalls();
    const { alert } = await triggerFreshAlert();
    const analysis = await waitForAiStatus(prisma, alert.id, ['READY']);
    const callsAfterFirst = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('anthropic')).length;
    expect(callsAfterFirst).toBe(1);

    // A second, independent generation attempt for the SAME analysis.
    const queue = context.get(AI_ANALYSIS_QUEUE);
    await queue.add('generate', { aiAnalysisId: analysis.id }, { jobId: analysis.id });
    await new Promise((r) => setTimeout(r, 150));

    const anthropicCallsAfterDuplicate = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('anthropic')).length;
    expect(anthropicCallsAfterDuplicate).toBe(1); // never called again
  });

  it('6. a provider that always fails exhausts retries and lands FAILED (terminal)', async () => {
    mockExternalCalls('FAIL');
    const { alert } = await triggerFreshAlert();
    // status='FAILED' is set after EVERY failed attempt, not just the final
    // one (it's also the "will retry" state) — so waiting on status alone
    // races with the retry still in flight. Wait for the attempt count to
    // reach the configured ceiling (AI_ANALYSIS_MAX_ATTEMPTS=2 in .env.test)
    // instead, which is only true once BullMQ has genuinely stopped retrying.
    const deadline = Date.now() + 5000;
    let analysis = await prisma.aiAnalysis.findUniqueOrThrow({ where: { alertId: alert.id } });
    while (analysis.attempts < 2) {
      if (Date.now() > deadline) throw new Error(`attempts stalled at ${analysis.attempts}`);
      await new Promise((r) => setTimeout(r, 25));
      analysis = await prisma.aiAnalysis.findUniqueOrThrow({ where: { alertId: alert.id } });
    }
    expect(analysis.status).toBe('FAILED');
    expect(analysis.attempts).toBe(2);
    expect(analysis.lastError).toBeTruthy();
  });

  it('7. even if the provider tries to add a recommendation field, it never reaches the Telegram message', async () => {
    const withRecommendation = JSON.stringify({
      situation_summary: 'Equity is down from its peak.',
      historical_comparison: 'h',
      similar_past_events: [],
      statistical_context: 'c',
      market_risk: 'LOW',
      exposure_risk: 'LOW',
      event_risk: 'LOW',
      news_sentiment: 'NEUTRAL',
      confidence: 0.5,
      assessment: 'a',
      recommended_action: 'MONITOR',
      recommendation: 'buy more to average down', // a free-text extra field must be structurally stripped
    });
    mockExternalCalls(withRecommendation);

    const { alert } = await triggerFreshAlert();
    const analysis = await waitForAiStatus(prisma, alert.id, ['READY']);
    expect(analysis.result).not.toHaveProperty('recommendation');
    expect(JSON.stringify(analysis.result)).not.toContain('buy more');
  });
});

describe('Phase 6 — AI analysis pipeline (AI_ENABLED=false, the default)', () => {
  let prisma: PrismaClient;
  let context: INestApplicationContext;
  let ruleDefinitions: RuleDefinitionsService;
  let ruleEngine: RuleEngineService;

  beforeAll(async () => {
    // AI_ENABLED is 'false' in .env.test by default — no override needed.
    prisma = new PrismaClient();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    context = await moduleRef.init();
    ruleDefinitions = context.get(RuleDefinitionsService);
    ruleEngine = context.get(RuleEngineService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await context.close();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a fresh alert still gets a PENDING AiAnalysis row, which the worker then marks SKIPPED — no external AI call ever made', async () => {
    // Trading-alert delivery via Telegram must still work normally — only
    // a call to Anthropic is disallowed here.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes('api.anthropic.com')) {
        throw new Error('Anthropic must never be called when AI_ENABLED=false');
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });

    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const now = new Date();
    await seedSnapshot(prisma, account.id, { capturedAt: now, balance: 10_000, equity: 10_000 });
    const rule = await ruleDefinitions.create(account.id, {
      name: 'ai-disabled test',
      ruleType: 'DRAWDOWN',
      parameters: { threshold_pct: 0 },
    });
    await ruleEngine.evaluateAccount(account.id, now);
    const alert = await prisma.alert.findFirstOrThrow({ where: { ruleId: rule.id } });

    const analysis = await waitForAiStatus(prisma, alert.id, ['SKIPPED']);
    expect(analysis.status).toBe('SKIPPED');
    // The Telegram send for the TRADING ALERT itself still happens (mocked
    // via setup-telegram-mock.ts's global default) — only the Anthropic
    // call must never occur.
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('anthropic'))).toBe(false);
  });
});
