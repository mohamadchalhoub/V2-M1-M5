import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { AiAnalysisResult } from '../ai/ai-provider.interface';
import { RECONCILIATION_SWEEP_JOB_ID, TELEGRAM_DELIVERY_QUEUE, TELEGRAM_DELIVERY_QUEUE_NAME, deliveryJobId } from '../jobs/jobs.constants';
import { createRedisConnection } from '../jobs/redis-connection';
import { PrismaService } from '../prisma/prisma.service';
import { renderAiNarrativeMessage, renderMessage } from './message-templates';
import { TelegramBotClient } from './telegram-bot.client';
import { TELEGRAM_CONFIG, TelegramConfig } from './telegram.config';
import { redactToken } from '../common/redact';
import { TelegramPermanentError } from './telegram.errors';

interface DeliverJobData {
  alertDeliveryId: string;
}

interface DeliverAiNarrativeJobData {
  aiAnalysisId: string;
}

/**
 * The BullMQ Worker for the `telegram-delivery` queue, handling both job
 * kinds: `deliver` (send one AlertDelivery) and `sweep` (the reconciliation
 * pass, §7). One queue, one worker, dispatched by `job.name` — Phase 0 §24's
 * "don't introduce unnecessary infrastructure" applied to not needing a
 * second queue/worker pair for the sweep.
 */
@Injectable()
export class TelegramDeliveryProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramDeliveryProcessor.name);
  private worker?: Worker;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(TELEGRAM_CONFIG) private readonly telegramConfig: TelegramConfig,
    private readonly botClient: TelegramBotClient,
    @Inject(TELEGRAM_DELIVERY_QUEUE) private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    // Dedicated connection for the Worker (BullMQ's documented
    // recommendation — see jobs/redis-connection.ts's doc comment).
    const connection = createRedisConnection(this.config);
    this.worker = new Worker(TELEGRAM_DELIVERY_QUEUE_NAME, (job) => this.process(job), {
      connection,
      concurrency: 5,
    });
    this.worker.on('error', (err) => {
      this.logger.error(`worker error: ${err instanceof Error ? err.message : err}`);
    });
    this.worker.on('failed', (job, err) => {
      this.handleFailed(job, err).catch((handlerErr) =>
        this.logger.error(`handleFailed itself threw: ${handlerErr instanceof Error ? handlerErr.message : handlerErr}`),
      );
    });

    // Repeatable sweep (BullMQ v6's job-scheduler API) — re-registering the
    // same schedule on every boot is idempotent, keyed by schedulerId.
    await this.queue.upsertJobScheduler(
      RECONCILIATION_SWEEP_JOB_ID,
      { every: this.telegramConfig.reconciliationIntervalMs },
      { name: 'sweep', data: {} },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job): Promise<void> {
    if (job.name === 'sweep') {
      return this.runReconciliationSweep();
    }
    if (job.name === 'deliver-ai-narrative') {
      return this.deliverAiNarrative(job as Job<DeliverAiNarrativeJobData>);
    }
    return this.deliver(job as Job<DeliverJobData>);
  }

  // Phase 6 — message #2 (AI_INTEGRATION_SPEC.md §1). Only ever enqueued by
  // `ai`'s AiAnalysisProcessor, and only once a result reached READY
  // (schema-valid AND passed the safety filter) — this method trusts that
  // but re-checks status defensively before sending anything.
  private async deliverAiNarrative(job: Job<DeliverAiNarrativeJobData>): Promise<void> {
    const { aiAnalysisId } = job.data;
    const analysis = await this.prisma.aiAnalysis.findUnique({
      where: { id: aiAnalysisId },
      include: { alert: { include: { account: { select: { displayName: true, externalAccountId: true } } } } },
    });

    if (!analysis) {
      throw new UnrecoverableError(`AiAnalysis ${aiAnalysisId} does not exist`);
    }
    if (analysis.status !== 'READY') {
      // Never send a WITHHELD/FAILED/PENDING/SKIPPED analysis — defensive,
      // shouldn't be reachable since only READY ever gets this job enqueued.
      return;
    }
    if ((analysis.telegramMessageIds as unknown as number[]).length > 0) {
      return; // idempotent no-op — already sent
    }

    const text = renderAiNarrativeMessage(analysis.result as unknown as AiAnalysisResult, analysis.alert);
    const chatIds = this.telegramConfig.tradingChatIds;

    const messageIds: number[] = [];
    try {
      for (const chatId of chatIds) {
        messageIds.push(await this.botClient.sendMessage(chatId, text));
      }
    } catch (err) {
      if (err instanceof TelegramPermanentError) {
        // Fail fast — the generated narrative already exists (status stays
        // READY, kept for audit); there's no DEAD-equivalent state to set
        // here (a missed narrative is not a missed alert, §7 of the spec).
        throw new UnrecoverableError(err.message);
      }
      throw err; // transient — BullMQ retries with backoff
    }

    await this.prisma.aiAnalysis.update({
      where: { id: analysis.id },
      data: { telegramMessageIds: messageIds },
    });
  }

  private async deliver(job: Job<DeliverJobData>): Promise<void> {
    const { alertDeliveryId } = job.data;
    const delivery = await this.prisma.alertDelivery.findUnique({
      where: { id: alertDeliveryId },
      include: { alert: { include: { account: { select: { displayName: true, externalAccountId: true } } } } },
    });

    if (!delivery) {
      // Should be structurally impossible (Alert/AlertDelivery are created
      // together, onDelete: Cascade) — never retry forever on a bad job.
      throw new UnrecoverableError(`AlertDelivery ${alertDeliveryId} does not exist`);
    }
    // §6 — idempotent no-op: a prior attempt already succeeded (e.g. the
    // worker crashed after sendMessage but before this update landed, and
    // BullMQ's stalled-job recovery re-ran it).
    if (delivery.status === 'SENT') {
      return;
    }

    const chatIds =
      delivery.class === 'TRADING_ALERT' ? this.telegramConfig.tradingChatIds : this.telegramConfig.opsChatIds;
    if (chatIds.length === 0) {
      const message = `no chat ids configured for class ${delivery.class}`;
      await this.markDead(delivery.id, message);
      throw new UnrecoverableError(message);
    }

    let text: string;
    try {
      text = renderMessage(delivery.class, delivery.alert);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.markDead(delivery.id, message);
      throw new UnrecoverableError(message);
    }

    const messageIds: number[] = [];
    try {
      for (const chatId of chatIds) {
        messageIds.push(await this.botClient.sendMessage(chatId, text));
      }
    } catch (err) {
      const message = redactToken(err instanceof Error ? err.message : String(err), this.telegramConfig.botToken).slice(
        0,
        500,
      );
      await this.prisma.alertDelivery.update({
        where: { id: delivery.id },
        data: { attempts: { increment: 1 }, lastError: message, status: 'FAILED' },
      });

      if (err instanceof TelegramPermanentError) {
        // §5/§8 — permanent error: fail fast, don't waste 4 more doomed
        // attempts.
        await this.markDead(delivery.id, message);
        throw new UnrecoverableError(message);
      }
      throw err; // transient — BullMQ retries with backoff
    }

    await this.prisma.alertDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        telegramMessageIds: messageIds,
        attempts: { increment: 1 },
      },
    });
  }

  // §7 — recovers AlertDelivery rows committed to Postgres whose Redis
  // enqueue was interrupted (or lost, if Redis itself lost data) — the
  // transactional-outbox pattern's whole point. Re-adds with the SAME
  // deterministic jobId, so this can never create a duplicate send even if
  // a live job for the same delivery already exists.
  private async runReconciliationSweep(): Promise<void> {
    const staleCutoff = new Date(Date.now() - this.telegramConfig.staleThresholdMs);
    const stale = await this.prisma.alertDelivery.findMany({
      where: { status: { in: ['PENDING', 'FAILED'] }, updatedAt: { lt: staleCutoff } },
      select: { id: true },
    });

    for (const { id } of stale) {
      await this.queue.add('deliver', { alertDeliveryId: id }, { jobId: deliveryJobId(id) });
    }

    if (stale.length > 0) {
      this.logger.log(`reconciliation sweep re-enqueued ${stale.length} stale delivery(ies)`);
    }
  }

  private async markDead(id: string, error: string): Promise<void> {
    await this.prisma.alertDelivery.update({
      where: { id },
      data: { status: 'DEAD', lastError: error.slice(0, 500) },
    });
  }

  // §5 — the dead-letter transition for a TRANSIENT error that has now
  // exhausted every retry (a permanent error already marks DEAD directly
  // in `deliver`, before this ever sees it — attemptsMade won't reach the
  // ceiling there). `job.opts.attempts` reflects the queue's
  // defaultJobOptions merged in at enqueue time (jobs.module.ts).
  private async handleFailed(job: Job | undefined, err: Error): Promise<void> {
    if (!job || job.name !== 'deliver') return;

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      const { alertDeliveryId } = job.data as DeliverJobData;
      const current = await this.prisma.alertDelivery.findUnique({ where: { id: alertDeliveryId } });
      if (current && current.status !== 'DEAD' && current.status !== 'SENT') {
        await this.markDead(alertDeliveryId, redactToken(err.message, this.telegramConfig.botToken));
        this.logger.error(`delivery ${alertDeliveryId} exhausted ${job.attemptsMade} attempt(s), marked DEAD`);
      }
    }
  }
}
