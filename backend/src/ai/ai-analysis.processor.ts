import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { AI_ANALYSIS_QUEUE_NAME, TELEGRAM_DELIVERY_QUEUE } from '../jobs/jobs.constants';
import { createRedisConnection } from '../jobs/redis-connection';
import { PrismaService } from '../prisma/prisma.service';
import { redactToken } from '../common/redact';
import { AI_PROVIDER } from './ai-provider.token';
import { AiProvider } from './ai-provider.interface';
import { AI_CONFIG, AiConfig } from './ai.config';
import { HistoricalPatternSummaryService } from './historical-pattern-summary.service';
import { MarketContextBuilderService } from './market-context-builder.service';
import { checkSafety } from './safety-filter';
import { findSimilarPastEvents } from './similar-past-events';
import { validateAiAnalysisResult } from './validate-ai-result';

interface GenerateJobData {
  aiAnalysisId: string;
}

/**
 * The `ai` module's only worker — consumes `AI_ANALYSIS_QUEUE`
 * (AI_INTEGRATION_SPEC.md §7). Never calls Telegram directly; on a READY
 * result it enqueues a 'deliver-ai-narrative' job on
 * TELEGRAM_DELIVERY_QUEUE instead, so `telegram` remains the only module
 * that ever calls the Bot API (§1) — this module only reads Alert data via
 * the global PrismaService and never imports `telegram` or `alerts`.
 */
@Injectable()
export class AiAnalysisProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiAnalysisProcessor.name);
  private worker?: Worker;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    @Inject(TELEGRAM_DELIVERY_QUEUE) private readonly deliveryQueue: Queue,
    private readonly marketContextBuilder: MarketContextBuilderService,
    private readonly historicalPatternSummary: HistoricalPatternSummaryService,
  ) {}

  async onModuleInit(): Promise<void> {
    const connection = createRedisConnection(this.config);
    this.worker = new Worker(AI_ANALYSIS_QUEUE_NAME, (job) => this.generate(job as Job<GenerateJobData>), {
      connection,
      concurrency: 3,
    });
    this.worker.on('error', (err) => {
      this.logger.error(`worker error: ${err instanceof Error ? err.message : err}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async generate(job: Job<GenerateJobData>): Promise<void> {
    const { aiAnalysisId } = job.data;
    const analysis = await this.prisma.aiAnalysis.findUnique({
      where: { id: aiAnalysisId },
      include: { alert: { include: { rule: true } } },
    });

    if (!analysis) {
      throw new UnrecoverableError(`AiAnalysis ${aiAnalysisId} does not exist`);
    }
    // Idempotent no-op — but ONLY for a genuinely terminal state. FAILED is
    // NOT terminal (it's set after every failed attempt, including ones
    // BullMQ is about to retry) — treating it as terminal here would make a
    // retry silently no-op instead of trying again, since it would see
    // "already handled" and return without ever calling the provider or
    // incrementing attempts a second time. Only PENDING and FAILED reach
    // this point at all; READY/WITHHELD/SKIPPED are the true terminal set.
    if (analysis.status === 'READY' || analysis.status === 'WITHHELD' || analysis.status === 'SKIPPED') {
      return;
    }

    if (!this.aiConfig.enabled) {
      // Defensive — alerts always enqueues on a fresh episode regardless of
      // whether AI is enabled (AI_INTEGRATION_SPEC.md §11 point 3's
      // resolution: keep `alerts` ignorant of AI config entirely). This is
      // the expected path whenever AI_ENABLED=false, not an error.
      await this.prisma.aiAnalysis.update({ where: { id: analysis.id }, data: { status: 'SKIPPED' } });
      return;
    }

    const similarPastEvents = await findSimilarPastEvents(
      this.prisma as any,
      analysis.alert.ruleId,
      analysis.alertId,
    );
    const marketContext = await this.marketContextBuilder.build(analysis.alert.accountId);
    const historicalPatternContext = await this.historicalPatternSummary.build();

    let result;
    const startedAt = Date.now();
    this.logger.log(`AI request started: alertId=${analysis.alertId} provider=${this.aiConfig.provider}`);
    try {
      result = await this.provider.analyze({
        alertId: analysis.alertId,
        ruleType: analysis.alert.rule.ruleType,
        ruleName: analysis.alert.rule.name,
        triggerValues: analysis.alert.triggerValues as Record<string, unknown>,
        baselineSnapshot: analysis.alert.baselineSnapshot as Record<string, unknown>,
        triggeredAt: analysis.alert.triggeredAt,
        similarPastEvents,
        marketContext,
        historicalPatternContext,
      });
      // Belt-and-braces: the provider already validates its own output
      // (anthropic-provider.ts), but re-validating here means ANY future
      // AiProvider implementation gets this guarantee for free, not just
      // ones that remember to call it themselves.
      result = validateAiAnalysisResult(result);
      this.logger.log(`AI request succeeded: alertId=${analysis.alertId} latencyMs=${Date.now() - startedAt}`);
    } catch (err) {
      const message = redactToken(err instanceof Error ? err.message : String(err), this.aiConfig.apiKey).slice(0, 500);
      this.logger.error(`AI request failed: alertId=${analysis.alertId} latencyMs=${Date.now() - startedAt}: ${message}`);
      await this.prisma.aiAnalysis.update({
        where: { id: analysis.id },
        data: { attempts: { increment: 1 }, lastError: message, status: 'FAILED' },
      });
      throw err; // BullMQ retries per AI_ANALYSIS_MAX_ATTEMPTS/_BACKOFF_MS
    }

    const safety = checkSafety(result);
    if (safety.flagged) {
      // §4 — a hard withhold. The AI text is kept in Postgres for audit
      // (result is still written) but no Telegram job is ever enqueued for it.
      await this.prisma.aiAnalysis.update({
        where: { id: analysis.id },
        data: {
          status: 'WITHHELD',
          safetyFlagged: true,
          flaggedPattern: safety.pattern,
          result: result as unknown as Prisma.InputJsonValue,
          attempts: { increment: 1 },
          provider: this.aiConfig.provider,
          model: this.aiConfig.model,
        },
      });
      this.logger.warn(`AI analysis ${analysis.id} withheld by safety filter (pattern: ${safety.pattern})`);
      return;
    }

    await this.prisma.aiAnalysis.update({
      where: { id: analysis.id },
      data: {
        status: 'READY',
        result: result as unknown as Prisma.InputJsonValue,
        attempts: { increment: 1 },
        provider: this.aiConfig.provider,
        model: this.aiConfig.model,
      },
    });

    // No prefix on the job id (same reasoning as deliveryJobId in
    // jobs.constants.ts — BullMQ v6 rejects ':' in custom job ids); this
    // job lives on TELEGRAM_DELIVERY_QUEUE alongside 'deliver' jobs keyed
    // by AlertDelivery id, but AiAnalysis ids are a distinct UUID pool so
    // there is no collision risk sharing the same queue's id space.
    await this.deliveryQueue.add('deliver-ai-narrative', { aiAnalysisId: analysis.id }, { jobId: analysis.id });
  }
}
