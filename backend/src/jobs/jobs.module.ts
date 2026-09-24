import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { createRedisConnection } from './redis-connection';
import {
  AI_ANALYSIS_QUEUE,
  AI_ANALYSIS_QUEUE_NAME,
  CENTRAL_BANK_CALENDAR_QUEUE,
  CENTRAL_BANK_CALENDAR_QUEUE_NAME,
  DAILY_MARKET_ANALYSIS_QUEUE,
  DAILY_MARKET_ANALYSIS_QUEUE_NAME,
  DATA_INTEGRITY_QUEUE,
  DATA_INTEGRITY_QUEUE_NAME,
  HEALTH_CHECK_QUEUE,
  HEALTH_CHECK_QUEUE_NAME,
  FINNHUB_NEWS_QUEUE,
  FINNHUB_NEWS_QUEUE_NAME,
  HEARTBEAT_DIGEST_QUEUE,
  HEARTBEAT_DIGEST_QUEUE_NAME,
  HISTORICAL_TICK_QUEUE,
  HISTORICAL_TICK_QUEUE_NAME,
  MARKET_EVENT_QUEUE,
  MARKET_EVENT_QUEUE_NAME,
  MARKET_NEWS_QUEUE,
  MARKET_NEWS_QUEUE_NAME,
  TELEGRAM_DELIVERY_QUEUE,
  TELEGRAM_DELIVERY_QUEUE_NAME,
} from './jobs.constants';

/**
 * Closes a queue (and its dedicated Redis connection) on module/app
 * shutdown — `Queue` is a third-party class, so it needs an explicit
 * `OnModuleDestroy` provider to hook into Nest's lifecycle; without this,
 * `app.close()` in tests would leave a live Redis connection behind and
 * vitest would never exit cleanly. One instance per queue.
 */
@Injectable()
class QueueLifecycle implements OnModuleDestroy {
  constructor(
    @Inject(TELEGRAM_DELIVERY_QUEUE) private readonly deliveryQueue: Queue,
    @Inject(AI_ANALYSIS_QUEUE) private readonly aiAnalysisQueue: Queue,
    @Inject(HEALTH_CHECK_QUEUE) private readonly healthCheckQueue: Queue,
    @Inject(DATA_INTEGRITY_QUEUE) private readonly dataIntegrityQueue: Queue,
    @Inject(MARKET_EVENT_QUEUE) private readonly marketEventQueue: Queue,
    @Inject(MARKET_NEWS_QUEUE) private readonly marketNewsQueue: Queue,
    @Inject(CENTRAL_BANK_CALENDAR_QUEUE) private readonly centralBankCalendarQueue: Queue,
    @Inject(DAILY_MARKET_ANALYSIS_QUEUE) private readonly dailyMarketAnalysisQueue: Queue,
    @Inject(HEARTBEAT_DIGEST_QUEUE) private readonly heartbeatDigestQueue: Queue,
    @Inject(FINNHUB_NEWS_QUEUE) private readonly finnhubNewsQueue: Queue,
    @Inject(HISTORICAL_TICK_QUEUE) private readonly historicalTickQueue: Queue,
  ) {}

  async onModuleDestroy() {
    await Promise.all([
      this.deliveryQueue.close(),
      this.aiAnalysisQueue.close(),
      this.healthCheckQueue.close(),
      this.dataIntegrityQueue.close(),
      this.marketEventQueue.close(),
      this.marketNewsQueue.close(),
      this.centralBankCalendarQueue.close(),
      this.dailyMarketAnalysisQueue.close(),
      this.heartbeatDigestQueue.close(),
      this.finnhubNewsQueue.close(),
      this.historicalTickQueue.close(),
    ]);
  }
}

/**
 * BullMQ registration only (Phase 0 §15: `jobs` owns queue/connection setup,
 * nothing message-shaped). `@Global()` matches `PrismaModule`'s precedent —
 * every module that needs to enqueue or process a delivery job needs this,
 * and there's exactly one queue in the whole system.
 */
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 5000;

function readPositiveInt(config: ConfigService, key: string, fallback: number): number {
  const raw = config.get<string>(key);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

@Global()
@Module({
  providers: [
    {
      provide: TELEGRAM_DELIVERY_QUEUE,
      // Retry/backoff policy (PHASE5_DELIVERY_SPEC.md §5) lives here, as
      // queue-level `defaultJobOptions`, not duplicated into `telegram`'s
      // config — every `.add()` call (AlertLifecycleService's enqueue, the
      // reconciliation sweep's re-enqueue) inherits it automatically, and
      // `job.opts.attempts` at processing time reflects the resolved value.
      useFactory: (config: ConfigService) => {
        const connection = createRedisConnection(config);
        return new Queue(TELEGRAM_DELIVERY_QUEUE_NAME, {
          connection,
          defaultJobOptions: {
            attempts: readPositiveInt(config, 'TELEGRAM_DELIVERY_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS),
            backoff: {
              type: 'exponential',
              delay: readPositiveInt(config, 'TELEGRAM_DELIVERY_BACKOFF_MS', DEFAULT_BACKOFF_MS),
            },
            removeOnComplete: { age: 86_400 }, // keep 24h for observability, then GC
            removeOnFail: false, // DEAD/failed jobs stay visible until handled
          },
        });
      },
      inject: [ConfigService],
    },
    {
      provide: AI_ANALYSIS_QUEUE,
      // Smaller retry budget than delivery (AI_INTEGRATION_SPEC.md §7) — a
      // missed narrative isn't operationally urgent the way a missed alert
      // would be, so 2 attempts by default rather than 5.
      useFactory: (config: ConfigService) => {
        const connection = createRedisConnection(config);
        return new Queue(AI_ANALYSIS_QUEUE_NAME, {
          connection,
          defaultJobOptions: {
            attempts: readPositiveInt(config, 'AI_ANALYSIS_MAX_ATTEMPTS', 2),
            backoff: {
              type: 'exponential',
              delay: readPositiveInt(config, 'AI_ANALYSIS_BACKOFF_MS', 3000),
            },
            removeOnComplete: { age: 86_400 },
            removeOnFail: false,
          },
        });
      },
      inject: [ConfigService],
    },
    {
      provide: HEALTH_CHECK_QUEUE,
      // No retries — a health check is idempotent and re-runs on its own
      // schedule anyway (HEALTH_CHECK_INTERVAL_SECONDS); retrying a failed
      // check would just delay the NEXT tick's more current answer.
      useFactory: (config: ConfigService) => {
        const connection = createRedisConnection(config);
        return new Queue(HEALTH_CHECK_QUEUE_NAME, {
          connection,
          defaultJobOptions: { attempts: 1, removeOnComplete: { age: 3600 }, removeOnFail: { age: 3600 } },
        });
      },
      inject: [ConfigService],
    },
    {
      provide: DATA_INTEGRITY_QUEUE,
      // No retries, same reasoning as HEALTH_CHECK_QUEUE — idempotent,
      // re-runs on its own weekly schedule regardless.
      useFactory: (config: ConfigService) => {
        const connection = createRedisConnection(config);
        return new Queue(DATA_INTEGRITY_QUEUE_NAME, {
          connection,
          defaultJobOptions: { attempts: 1, removeOnComplete: { age: 3600 }, removeOnFail: { age: 3600 } },
        });
      },
      inject: [ConfigService],
    },
    {
      provide: MARKET_EVENT_QUEUE,
      // Small retry budget (unlike HEALTH_CHECK_QUEUE/DATA_INTEGRITY_QUEUE's
      // attempts: 1) — this one calls a real external HTTP API (FRED) that
      // can transiently fail, and a missed tick otherwise just waits a full
      // day for the next scheduled one.
      useFactory: (config: ConfigService) => {
        const connection = createRedisConnection(config);
        return new Queue(MARKET_EVENT_QUEUE_NAME, {
          connection,
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: { age: 604_800 }, // a week — this only ticks ~daily
            removeOnFail: { age: 604_800 },
          },
        });
      },
      inject: [ConfigService],
    },
    {
      provide: MARKET_NEWS_QUEUE,
      // Small retry budget like MARKET_EVENT_QUEUE, but slower/smaller —
      // Marketaux's free tier is 100 requests/day (vs. FRED, which has no
      // documented tight daily ceiling), so a failed tick must not burn
      // through the budget retrying. A missed tick otherwise just waits for
      // the next scheduled poll (MARKETAUX_POLL_INTERVAL_SECONDS).
      useFactory: (config: ConfigService) => {
        const connection = createRedisConnection(config);
        return new Queue(MARKET_NEWS_QUEUE_NAME, {
          connection,
          defaultJobOptions: {
            attempts: 2,
            backoff: { type: 'exponential', delay: 10 * 60_000 },
            removeOnComplete: { age: 604_800 },
            removeOnFail: { age: 604_800 },
          },
        });
      },
      inject: [ConfigService],
    },
    {
      provide: CENTRAL_BANK_CALENDAR_QUEUE,
      // No retries, same reasoning as DATA_INTEGRITY_QUEUE — no external
      // call to fail transiently, idempotent, re-runs on its own daily
      // schedule regardless.
      useFactory: (config: ConfigService) => {
        const connection = createRedisConnection(config);
        return new Queue(CENTRAL_BANK_CALENDAR_QUEUE_NAME, {
          connection,
          defaultJobOptions: { attempts: 1, removeOnComplete: { age: 604_800 }, removeOnFail: { age: 604_800 } },
        });
      },
      inject: [ConfigService],
    },
    {
      provide: DAILY_MARKET_ANALYSIS_QUEUE,
      // No retries, same reasoning as CENTRAL_BANK_CALENDAR_QUEUE — no
      // external call, idempotent (re-computing the same day's analysis
      // twice is harmless), re-runs on its own daily schedule regardless.
      useFactory: (config: ConfigService) => {
        const connection = createRedisConnection(config);
        return new Queue(DAILY_MARKET_ANALYSIS_QUEUE_NAME, {
          connection,
          defaultJobOptions: { attempts: 1, removeOnComplete: { age: 604_800 }, removeOnFail: { age: 604_800 } },
        });
      },
      inject: [ConfigService],
    },
    {
      provide: HEARTBEAT_DIGEST_QUEUE,
      // Small retry budget, same reasoning as MARKET_EVENT_QUEUE — this job
      // makes a real external call (Telegram) that can transiently fail,
      // unlike DAILY_MARKET_ANALYSIS_QUEUE. A missed tick just waits for
      // tomorrow's, so this is not the aggressive TELEGRAM_DELIVERY_QUEUE
      // retry budget (5 attempts) — a missed daily "I'm alive" ping is not
      // operationally urgent the way a missed trading alert would be.
      useFactory: (config: ConfigService) => {
        const connection = createRedisConnection(config);
        return new Queue(HEARTBEAT_DIGEST_QUEUE_NAME, {
          connection,
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: { age: 604_800 },
            removeOnFail: { age: 604_800 },
          },
        });
      },
      inject: [ConfigService],
    },
    {
      provide: FINNHUB_NEWS_QUEUE,
      // Small retry budget, same shape as MARKET_NEWS_QUEUE — but Finnhub's
      // free tier (60 requests/minute) is far looser than Marketaux's
      // (100/day), so a shorter backoff is safe here.
      useFactory: (config: ConfigService) => {
        const connection = createRedisConnection(config);
        return new Queue(FINNHUB_NEWS_QUEUE_NAME, {
          connection,
          defaultJobOptions: {
            attempts: 2,
            backoff: { type: 'exponential', delay: 2 * 60_000 },
            removeOnComplete: { age: 604_800 },
            removeOnFail: { age: 604_800 },
          },
        });
      },
      inject: [ConfigService],
    },
    {
      provide: HISTORICAL_TICK_QUEUE,
      // No retries (attempts: 1) and Worker-side maxStalledCount: 0 (set in
      // historical-tick.processor.ts) -- a lost/stalled batch during a
      // Postgres outage must never turn into a retry storm on top of an
      // already-degraded backlog. Idempotent (ON CONFLICT DO NOTHING) means
      // a genuinely-lost batch is simply gone, never silently reprocessed.
      // Small retention: this queue's volume is far higher than any other
      // queue in this module, so 24h-style retention (TELEGRAM_DELIVERY_QUEUE)
      // would itself become a memory concern.
      useFactory: (config: ConfigService) => {
        const connection = createRedisConnection(config);
        return new Queue(HISTORICAL_TICK_QUEUE_NAME, {
          connection,
          defaultJobOptions: {
            attempts: 1,
            removeOnComplete: { age: 3600, count: 1000 },
            removeOnFail: { age: 86_400, count: 500 },
          },
        });
      },
      inject: [ConfigService],
    },
    QueueLifecycle,
  ],
  exports: [
    TELEGRAM_DELIVERY_QUEUE,
    AI_ANALYSIS_QUEUE,
    HEALTH_CHECK_QUEUE,
    DATA_INTEGRITY_QUEUE,
    MARKET_EVENT_QUEUE,
    MARKET_NEWS_QUEUE,
    CENTRAL_BANK_CALENDAR_QUEUE,
    DAILY_MARKET_ANALYSIS_QUEUE,
    HEARTBEAT_DIGEST_QUEUE,
    FINNHUB_NEWS_QUEUE,
    HISTORICAL_TICK_QUEUE,
  ],
})
export class JobsModule {}
