import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { CENTRAL_BANK_CALENDAR_JOB_ID, CENTRAL_BANK_CALENDAR_QUEUE, CENTRAL_BANK_CALENDAR_QUEUE_NAME } from '../jobs/jobs.constants';
import { createRedisConnection } from '../jobs/redis-connection';
import { CENTRAL_BANK_CALENDAR_CONFIG, CentralBankCalendarConfig } from './central-bank-calendar.config';
import { CentralBankCalendarIngestionService } from './central-bank-calendar-ingestion.service';

/**
 * Same shape as MarketEventIngestionProcessor (FRED) and
 * MarketNewsIngestionProcessor — a scheduled BullMQ job, off entirely
 * (no worker, no schedule registered) when disabled.
 */
@Injectable()
export class CentralBankCalendarIngestionProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CentralBankCalendarIngestionProcessor.name);
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    @Inject(CENTRAL_BANK_CALENDAR_QUEUE) private readonly queue: Queue,
    @Inject(CENTRAL_BANK_CALENDAR_CONFIG) private readonly calendarConfig: CentralBankCalendarConfig,
    private readonly ingestionService: CentralBankCalendarIngestionService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.calendarConfig.enabled) return;

    const workerConnection = createRedisConnection(this.config);
    this.worker = new Worker(CENTRAL_BANK_CALENDAR_QUEUE_NAME, () => this.ingestionService.ingest(), {
      connection: workerConnection,
      concurrency: 1,
    });
    this.worker.on('error', (err) => {
      this.logger.error(`worker error: ${err instanceof Error ? err.message : err}`);
    });
    this.worker.on('failed', (_job, err) => {
      this.logger.error(`ingestion tick failed: ${err instanceof Error ? err.message : err}`);
    });

    // Run once immediately on boot, same reasoning as MarketEventIngestionProcessor.
    await this.queue.add('ingest', {}, { jobId: `${CENTRAL_BANK_CALENDAR_JOB_ID}-initial` });
    await this.queue.upsertJobScheduler(
      CENTRAL_BANK_CALENDAR_JOB_ID,
      { every: this.calendarConfig.fetchIntervalSeconds * 1000 },
      { name: 'ingest' },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
