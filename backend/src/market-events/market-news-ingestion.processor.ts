import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { MARKET_NEWS_JOB_ID, MARKET_NEWS_QUEUE, MARKET_NEWS_QUEUE_NAME } from '../jobs/jobs.constants';
import { createRedisConnection } from '../jobs/redis-connection';
import { MarketNewsIngestionService } from './market-news-ingestion.service';
import { MARKETAUX_CONFIG, MarketauxConfig } from './marketaux.config';

/**
 * The Marketaux half of the `market-events` module's polling — same shape
 * as MarketEventIngestionProcessor (FRED), on its own queue/schedule so a
 * slow or rate-limited Marketaux tick can never delay FRED's, or vice versa.
 * Off by default (MARKETAUX_ENABLED=false): no worker, no schedule, nothing
 * running.
 */
@Injectable()
export class MarketNewsIngestionProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketNewsIngestionProcessor.name);
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    @Inject(MARKET_NEWS_QUEUE) private readonly queue: Queue,
    @Inject(MARKETAUX_CONFIG) private readonly marketauxConfig: MarketauxConfig,
    private readonly ingestionService: MarketNewsIngestionService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.marketauxConfig.enabled) return;

    const workerConnection = createRedisConnection(this.config);
    this.worker = new Worker(MARKET_NEWS_QUEUE_NAME, () => this.ingestionService.ingest(this.marketauxConfig), {
      connection: workerConnection,
      concurrency: 1,
    });
    this.worker.on('error', (err) => {
      this.logger.error(`worker error: ${err instanceof Error ? err.message : err}`);
    });
    this.worker.on('failed', (_job, err) => {
      this.logger.error(`ingestion tick failed: ${err instanceof Error ? err.message : err}`);
    });

    // Run once immediately on boot, same reasoning as the FRED processor —
    // without this a freshly enabled deployment waits up to a full
    // pollIntervalSeconds before its first article shows up.
    await this.queue.add('ingest', {}, { jobId: `${MARKET_NEWS_JOB_ID}-initial` });
    await this.queue.upsertJobScheduler(
      MARKET_NEWS_JOB_ID,
      { every: this.marketauxConfig.pollIntervalSeconds * 1000 },
      { name: 'ingest' },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
