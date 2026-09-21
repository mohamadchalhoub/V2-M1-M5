import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { DATA_INTEGRITY_JOB_ID, DATA_INTEGRITY_QUEUE, DATA_INTEGRITY_QUEUE_NAME } from '../jobs/jobs.constants';
import { createRedisConnection } from '../jobs/redis-connection';
import { PrismaService } from '../prisma/prisma.service';
import { checkDataIntegrity } from './data-integrity-checks';
import { HealthStatusWriterService } from './health-status-writer.service';

const DEFAULT_INTERVAL_SECONDS = 604_800; // 7 days — Phase 0 §26: "a scheduled integrity-check job (weekly)"

function readPositiveInt(config: ConfigService, key: string, fallback: number): number {
  const raw = config.get<string>(key);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A weekly audit for drift that unique constraints and foreign keys don't
 * catch (HEALTH_SPEC.md's flagged gap, closed in Phase 11 — see
 * data-integrity-checks.ts). Reports through the DATA_INTEGRITY component
 * using the exact same Redis-then-Postgres write path and incident
 * open/close-on-change semantics as HealthCheckProcessor
 * (HealthStatusWriterService) — a separate queue and schedule, but the same
 * reporting contract, so `GET /health` and `/health/incidents` need no
 * special-casing for this component.
 */
@Injectable()
export class DataIntegrityProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DataIntegrityProcessor.name);
  private worker?: Worker;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(DATA_INTEGRITY_QUEUE) private readonly queue: Queue,
    private readonly statusWriter: HealthStatusWriterService,
  ) {}

  async onModuleInit(): Promise<void> {
    const workerConnection = createRedisConnection(this.config);
    this.worker = new Worker(DATA_INTEGRITY_QUEUE_NAME, () => this.runCheck(), {
      connection: workerConnection,
      concurrency: 1,
    });
    this.worker.on('error', (err) => {
      this.logger.error(`worker error: ${err instanceof Error ? err.message : err}`);
    });

    const intervalSeconds = readPositiveInt(
      this.config,
      'DATA_INTEGRITY_CHECK_INTERVAL_SECONDS',
      DEFAULT_INTERVAL_SECONDS,
    );
    await this.queue.upsertJobScheduler(DATA_INTEGRITY_JOB_ID, { every: intervalSeconds * 1000 }, { name: 'check' });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  /** Exposed so a test (or an operator script) can force one check cycle without waiting a week. */
  async runCheck(): Promise<void> {
    const checkedAt = new Date();
    let result;
    try {
      result = await checkDataIntegrity(this.prisma);
    } catch (err) {
      result = { status: 'DOWN' as const, detail: { error: err instanceof Error ? err.message : String(err) } };
    }
    await this.statusWriter.writeRedis('DATA_INTEGRITY', result, checkedAt);
    await this.statusWriter.persistAndDetectIncident('DATA_INTEGRITY', result, checkedAt);
  }
}
