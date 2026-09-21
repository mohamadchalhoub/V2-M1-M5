import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { FINNHUB_NEWS_JOB_ID, FINNHUB_NEWS_QUEUE, FINNHUB_NEWS_QUEUE_NAME } from '../jobs/jobs.constants';
import { createRedisConnection } from '../jobs/redis-connection';
import { FinnhubConfig, FINNHUB_CONFIG } from './finnhub.config';
import { FinnhubNewsIngestionService } from './finnhub-news-ingestion.service';

/**
 * The Finnhub half of the `market-events` module's polling — same shape as
 * MarketNewsIngestionProcessor (Marketaux), on its own queue/schedule so a
 * slow or rate-limited Finnhub tick can never delay any other provider's,
 * or vice versa. Off by default (FINNHUB_ENABLED=false): no worker, no
 * schedule, nothing running.
 */
@Injectable()
export class FinnhubNewsIngestionProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FinnhubNewsIngestionProcessor.name);
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    @Inject(FINNHUB_NEWS_QUEUE) private readonly queue: Queue,
    @Inject(FINNHUB_CONFIG) private readonly finnhubConfig: FinnhubConfig,
    private readonly ingestionService: FinnhubNewsIngestionService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.finnhubConfig.enabled) return;

    const workerConnection = createRedisConnection(this.config);
    this.worker = new Worker(FINNHUB_NEWS_QUEUE_NAME, () => this.ingestionService.ingest(this.finnhubConfig), {
      connection: workerConnection,
      concurrency: 1,
    });
    this.worker.on('error', (err) => {
      this.logger.error(`worker error: ${err instanceof Error ? err.message : err}`);
    });
    this.worker.on('failed', (_job, err) => {
      this.logger.error(`ingestion tick failed: ${err instanceof Error ? err.message : err}`);
    });

    // Run once immediately on boot, same reasoning as the Marketaux
    // processor — without this a freshly enabled deployment waits up to a
    // full pollIntervalSeconds before its first article shows up.
    await this.queue.add('ingest', {}, { jobId: `${FINNHUB_NEWS_JOB_ID}-initial` });
    await this.queue.upsertJobScheduler(
      FINNHUB_NEWS_JOB_ID,
      { every: this.finnhubConfig.pollIntervalSeconds * 1000 },
      { name: 'ingest' },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
