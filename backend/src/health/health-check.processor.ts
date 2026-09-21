import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthComponent } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { AI_CONFIG, AiConfig } from '../ai/ai.config';
import { HEALTH_CHECK_JOB_ID, HEALTH_CHECK_QUEUE, HEALTH_CHECK_QUEUE_NAME } from '../jobs/jobs.constants';
import { createRedisConnection } from '../jobs/redis-connection';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramBotClient } from '../telegram/telegram-bot.client';
import {
  ComponentCheckResult,
  checkAiProvider,
  checkCollectorAndMt5,
  checkDatabase,
  checkRedis,
  checkTelegram,
  checkXtbImport,
} from './health-checks';
import { HealthStatusWriterService } from './health-status-writer.service';

const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_STALE_THRESHOLD_SECONDS = 300;

function readPositiveInt(config: ConfigService, key: string, fallback: number): number {
  const raw = config.get<string>(key);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The `health` module's only worker (Phase 0 §13). Every component check is
 * wrapped in its own try/catch (§21: "one failing check must never prevent
 * the others from being evaluated or reported") — a check that throws is
 * itself recorded as DOWN for that component, not skipped. Live status is
 * written to Redis FIRST, Postgres second — a database outage is one of the
 * seven things this exists to detect, so it must not depend on the database
 * being up to report that (HEALTH_SPEC.md §2).
 */
@Injectable()
export class HealthCheckProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthCheckProcessor.name);
  private worker?: Worker;
  private redis?: IORedis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(HEALTH_CHECK_QUEUE) private readonly queue: Queue,
    private readonly telegramBotClient: TelegramBotClient,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
    private readonly statusWriter: HealthStatusWriterService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.redis = createRedisConnection(this.config);
    const workerConnection = createRedisConnection(this.config);
    this.worker = new Worker(HEALTH_CHECK_QUEUE_NAME, () => this.runChecks(), {
      connection: workerConnection,
      concurrency: 1,
    });
    this.worker.on('error', (err) => {
      this.logger.error(`worker error: ${err instanceof Error ? err.message : err}`);
    });

    const intervalSeconds = readPositiveInt(this.config, 'HEALTH_CHECK_INTERVAL_SECONDS', DEFAULT_INTERVAL_SECONDS);
    await this.queue.upsertJobScheduler(
      HEALTH_CHECK_JOB_ID,
      { every: intervalSeconds * 1000 },
      { name: 'check' },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.redis?.quit();
  }

  /** Exposed so a test (or an operator script) can force one check cycle without waiting for the schedule. */
  async runChecks(): Promise<void> {
    const staleThresholdSeconds = readPositiveInt(
      this.config,
      'HEARTBEAT_STALE_THRESHOLD_SECONDS',
      DEFAULT_STALE_THRESHOLD_SECONDS,
    );
    const checkedAt = new Date();

    const results = new Map<HealthComponent, ComponentCheckResult>();

    const [collectorResult, mt5Result] = await this.safePairCheck(() =>
      checkCollectorAndMt5(this.prisma, staleThresholdSeconds),
    );
    results.set('COLLECTOR', collectorResult);
    results.set('MT5_TERMINAL', mt5Result);

    results.set('DATABASE', await this.safeCheck(() => checkDatabase(this.prisma)));
    results.set('REDIS', await this.safeCheck(() => checkRedis(this.redis!)));
    results.set('TELEGRAM', await this.safeCheck(() => checkTelegram(this.telegramBotClient, this.prisma)));
    results.set('AI_PROVIDER', await this.safeCheck(() => checkAiProvider(this.prisma, this.aiConfig)));
    results.set('XTB_IMPORT', await this.safeCheck(() => checkXtbImport(this.prisma)));

    for (const [component, result] of results) {
      await this.statusWriter.writeRedis(component, result, checkedAt);
      await this.statusWriter.persistAndDetectIncident(component, result, checkedAt);
    }
  }

  private async safeCheck(fn: () => Promise<ComponentCheckResult>): Promise<ComponentCheckResult> {
    try {
      return await fn();
    } catch (err) {
      return { status: 'DOWN', detail: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  private async safePairCheck(
    fn: () => Promise<{ collector: ComponentCheckResult; mt5: ComponentCheckResult }>,
  ): Promise<[ComponentCheckResult, ComponentCheckResult]> {
    try {
      const { collector, mt5 } = await fn();
      return [collector, mt5];
    } catch (err) {
      const detail = { error: err instanceof Error ? err.message : String(err) };
      return [
        { status: 'DOWN', detail },
        { status: 'DOWN', detail },
      ];
    }
  }
}
