import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { MARKET_EVENT_JOB_ID, MARKET_EVENT_QUEUE, MARKET_EVENT_QUEUE_NAME } from '../jobs/jobs.constants';
import { createRedisConnection } from '../jobs/redis-connection';
import { MarketEventIngestionService } from './market-event-ingestion.service';
import { MARKET_EVENTS_CONFIG, MarketEventsConfig } from './market-events.config';

/**
 * The `market-events` module's only worker — same shape as
 * DataIntegrityProcessor (health/data-integrity.processor.ts): a scheduled
 * BullMQ job, not a `setInterval`, so the schedule survives a restart and
 * multiple instances of this process would never double-run it. When
 * disabled (the default), no worker is created and no schedule is
 * registered at all — not merely a no-op tick, genuinely nothing running.
 */
@Injectable()
export class MarketEventIngestionProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketEventIngestionProcessor.name);
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    @Inject(MARKET_EVENT_QUEUE) private readonly queue: Queue,
    @Inject(MARKET_EVENTS_CONFIG) private readonly marketEventsConfig: MarketEventsConfig,
    private readonly ingestionService: MarketEventIngestionService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.marketEventsConfig.enabled) return;

    const workerConnection = createRedisConnection(this.config);
    this.worker = new Worker(MARKET_EVENT_QUEUE_NAME, () => this.ingestionService.ingest(this.marketEventsConfig), {
      connection: workerConnection,
      concurrency: 1,
    });
    this.worker.on('error', (err) => {
      this.logger.error(`worker error: ${err instanceof Error ? err.message : err}`);
    });
    this.worker.on('failed', (_job, err) => {
      this.logger.error(`ingestion tick failed: ${err instanceof Error ? err.message : err}`);
    });

    // Run once immediately on boot (in addition to the schedule) — without
    // this, a freshly enabled deployment would show an empty MarketEvent
    // table for up to a full fetchIntervalSeconds before its first tick.
    await this.queue.add('ingest', {}, { jobId: `${MARKET_EVENT_JOB_ID}-initial` });
    await this.queue.upsertJobScheduler(
      MARKET_EVENT_JOB_ID,
      { every: this.marketEventsConfig.fetchIntervalSeconds * 1000 },
      { name: 'ingest' },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
