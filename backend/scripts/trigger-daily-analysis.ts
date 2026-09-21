/**
 * Manual convenience trigger for the Daily Market Analysis report — for
 * exactly the "the machine was off at 08:00, I want today's report now"
 * situation.
 *
 * Manually wires RuleEngineService and its dependencies (same convention as
 * manage-rules.ts) rather than a full Nest `createApplicationContext` boot
 * — that route was tried first and hit a NestJS global-module timing issue
 * (`ConfigService` resolving `undefined` inside some processors'
 * `onModuleInit`, e.g. MarketEventIngestionProcessor, only under
 * `createApplicationContext`, not the real HTTP `NestFactory.create` this
 * app normally uses); it would also start every background worker in the
 * app just to trigger one evaluation. Manual wiring sidesteps both — no
 * workers, no timing quirk, and it calls the exact same
 * `RuleEngineService.evaluateAccount(...)` the real cron and the startup
 * catch-up both call, so Alert creation, cooldown/dedup, AI analysis, and
 * Telegram delivery are all the real pipeline, unchanged. AI/Telegram
 * delivery are enqueued onto the normal shared Redis-backed queues — an
 * already-running `npm run dev` process's workers pick those jobs up
 * exactly as if the real cron had fired; this script does not need to stay
 * running to wait for them.
 *
 * Deliberately a CLI script, not a new HTTP endpoint (an admin API request
 * for this task offered both) — this app has no notion of an
 * "admin"/operator role or auth tier separate from the per-account
 * dashboard tokens, so a new unauthenticated route would be a real,
 * lingering attack surface on a long-lived dev server, not a throwaway
 * dev-only convenience. A CLI script run by hand carries none of that
 * risk and matches this app's own established pattern for one-off
 * operator actions (manage-rules.ts, send-account-summary.ts).
 *
 * Safe to run more than once — the rule's own cooldown (RULE_ENGINE_SPEC.md
 * §5) is the real dedup: if today's report already went out and its
 * cooldown hasn't expired, this is a documented no-op, not a double-send.
 *
 * Run: npm run trigger-daily-analysis
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, RuleType } from '@prisma/client';
import { Queue } from 'bullmq';
import { AccountsService } from '../src/accounts/accounts.service';
import { AlertLifecycleService } from '../src/alerts/alert-lifecycle.service';
import { RuleEngineService } from '../src/alerts/rule-engine.service';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { AI_ANALYSIS_QUEUE_NAME, TELEGRAM_DELIVERY_QUEUE_NAME } from '../src/jobs/jobs.constants';
import { createRedisConnection } from '../src/jobs/redis-connection';
import { MarketEventQueryService } from '../src/market-events/market-event-query.service';
import { HistoricalCandleService } from '../src/market-data/historical-candle.service';
import { RuleDefinitionsService } from '../src/rules/rule-definitions.service';
import { RuleStateService } from '../src/rules/rule-state.service';
import { loadTechnicalAnalysisConfig } from '../src/technical-analysis/technical-analysis.config';
import { TechnicalAnalysisReportService } from '../src/technical-analysis/technical-analysis-report.service';

// Reliability pass — a bare `new Queue(name, {connection})` with no
// `defaultJobOptions` gets BullMQ's own built-in default (attempts: 1, no
// retries) for any job enqueued through it, regardless of what the real
// app's jobs.module.ts configures for the SAME queue name — job options are
// fixed at `.add()` time by whichever Queue instance made the call, not by
// whatever Worker later processes it. Found live this session: a real
// Telegram delivery enqueued by this script hit a transient network error
// and went straight to DEAD after exactly 1 attempt, with none of the
// production path's real 5-attempt/5s-backoff retry budget. Duplicated
// here (not imported from jobs.module.ts) for the same reason
// rule-engine.service.ts duplicates dateKeyInTimezone rather than importing
// across a module boundary — this script wires everything manually and
// deliberately doesn't depend on JobsModule at all.
function readPositiveInt(config: ConfigService, key: string, fallback: number): number {
  const raw = config.get<string>(key);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const config = new ConfigService(process.env);

  // Own connections, closed in `finally` below — createRedisConnection()
  // returns a plain IORedis instance, and BullMQ's documented behavior for
  // a Queue given an externally-supplied connection (rather than connection
  // options) is to leave it open on queue.close(), since it assumes the
  // caller (here, this script) owns it and may still need it. Declared
  // outside the try so `finally` can reach them even if something in the
  // main body throws before they're otherwise used.
  const deliveryRedis = createRedisConnection(config);
  const aiAnalysisRedis = createRedisConnection(config);

  try {
    const rules = await prisma.ruleDefinition.findMany({
      where: { ruleType: RuleType.DAILY_MARKET_ANALYSIS, enabled: true },
      select: { accountId: true },
      distinct: ['accountId'],
    });

    if (rules.length === 0) {
      console.log('No account has DAILY_MARKET_ANALYSIS enabled — nothing to do.');
      return;
    }

    const accounts = new AccountsService(prisma as any);
    const ruleStates = new RuleStateService(prisma as any);
    const ruleDefinitions = new RuleDefinitionsService(prisma as any, accounts, ruleStates);
    const analytics = new AnalyticsService(prisma as any, config);
    const marketEventQuery = new MarketEventQueryService(prisma as any);
    const historicalCandles = new HistoricalCandleService(prisma as any);
    const technicalAnalysisConfig = loadTechnicalAnalysisConfig(config);
    const technicalAnalysis = new TechnicalAnalysisReportService(historicalCandles, technicalAnalysisConfig);

    const deliveryQueue = new Queue(TELEGRAM_DELIVERY_QUEUE_NAME, {
      connection: deliveryRedis,
      defaultJobOptions: {
        attempts: readPositiveInt(config, 'TELEGRAM_DELIVERY_MAX_ATTEMPTS', 5),
        backoff: { type: 'exponential', delay: readPositiveInt(config, 'TELEGRAM_DELIVERY_BACKOFF_MS', 5000) },
      },
    });
    const aiAnalysisQueue = new Queue(AI_ANALYSIS_QUEUE_NAME, {
      connection: aiAnalysisRedis,
      defaultJobOptions: {
        attempts: readPositiveInt(config, 'AI_ANALYSIS_MAX_ATTEMPTS', 2),
        backoff: { type: 'exponential', delay: readPositiveInt(config, 'AI_ANALYSIS_BACKOFF_MS', 3000) },
      },
    });
    const alertLifecycle = new AlertLifecycleService(prisma as any, config, ruleStates, deliveryQueue, aiAnalysisQueue);

    const ruleEngine = new RuleEngineService(
      analytics,
      ruleDefinitions,
      ruleStates,
      alertLifecycle,
      marketEventQuery,
      technicalAnalysis,
      prisma as any,
      technicalAnalysisConfig,
    );

    const now = new Date();
    for (const { accountId } of rules) {
      console.log(`Evaluating DAILY_MARKET_ANALYSIS for account=${accountId}...`);
      const results = await ruleEngine.evaluateAccount(accountId, now, { ruleTypeFilter: [RuleType.DAILY_MARKET_ANALYSIS] });
      for (const result of results) {
        console.log(`  status=${result.status} reasonCode=${result.reasonCode}`);
      }
      if (results.some((r) => r.status === 'TRIGGERED')) {
        console.log('  -> Alert created. AI analysis and Telegram delivery are queued (an already-running `npm run dev` will process them).');
      } else if (results.length === 0) {
        console.log('  -> No result — check the rule is actually enabled for this account.');
      } else {
        console.log('  -> Not triggered — likely still within the rule\'s cooldown from an earlier run today.');
      }
    }

    await deliveryQueue.close();
    await aiAnalysisQueue.close();
  } finally {
    // .quit() waits for in-flight commands and closes gracefully; if the
    // connection is already in a bad state, fall back to the immediate
    // .disconnect() rather than let a hung quit() keep the process alive —
    // exactly the failure mode this fix exists to eliminate.
    await deliveryRedis.quit().catch(() => deliveryRedis.disconnect());
    await aiAnalysisRedis.quit().catch(() => aiAnalysisRedis.disconnect());
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
