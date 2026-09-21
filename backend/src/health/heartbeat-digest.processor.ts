import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { HEARTBEAT_DIGEST_JOB_ID, HEARTBEAT_DIGEST_QUEUE, HEARTBEAT_DIGEST_QUEUE_NAME } from '../jobs/jobs.constants';
import { createRedisConnection } from '../jobs/redis-connection';
import { PrismaService } from '../prisma/prisma.service';
import { TELEGRAM_CONFIG, TelegramConfig } from '../telegram/telegram.config';
import { TelegramBotClient } from '../telegram/telegram-bot.client';
import { renderHeartbeatDigestMessage } from '../telegram/message-templates';

const DEFAULT_TIME = '21:00';
const DEFAULT_TIMEZONE = 'Asia/Beirut';

/**
 * Reliability pass — "let me know the system is alive even on a quiet day."
 * A once-a-day digest (default 21:00, so a full day's alert count is
 * meaningful), deliberately separate from `DailyMarketAnalysisProcessor`
 * despite the identical BullMQ cron pattern: this is ops/system content
 * (current HealthStatus + today's Alert count), not a trading signal, so it
 * reads `health`'s own tables directly and sends straight to
 * TELEGRAM_OPS_CHAT_IDS via TelegramBotClient — it does NOT go through the
 * Alert/AlertDelivery/`NotificationClass.SYSTEM_HEALTH` pipeline. That class
 * is reserved for a still-unbuilt, different feature (real-time incident
 * notifications sourced from `HealthIncident` rows); reusing it here would
 * conflate two different concepts and require a fabricated Alert row.
 * `health` still imports no `rules`/`alerts`/`analytics` service — the
 * Alert count below is a raw Prisma read of a shared table, the same
 * pattern `health-checks.ts`'s `checkXtbImport`/`checkTelegram` already use
 * against `ImportBatch`/`AlertDelivery`, not a dependency on trading logic.
 */
@Injectable()
export class HeartbeatDigestProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HeartbeatDigestProcessor.name);
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly telegramBotClient: TelegramBotClient,
    @Inject(TELEGRAM_CONFIG) private readonly telegramConfig: TelegramConfig,
    @Inject(HEARTBEAT_DIGEST_QUEUE) private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    const connection = createRedisConnection(this.config);
    this.worker = new Worker(HEARTBEAT_DIGEST_QUEUE_NAME, () => this.run(), {
      connection,
      concurrency: 1,
    });
    this.worker.on('error', (err) => {
      this.logger.error(`worker error: ${err instanceof Error ? err.message : err}`);
    });
    this.worker.on('failed', (_job, err) => {
      this.logger.error(`heartbeat digest tick failed: ${err instanceof Error ? err.message : err}`);
    });

    const time = this.config.get<string>('HEARTBEAT_DIGEST_TIME')?.trim() || DEFAULT_TIME;
    const timezone = this.config.get<string>('HEARTBEAT_DIGEST_TIMEZONE')?.trim() || DEFAULT_TIMEZONE;
    const { pattern, tz } = toCronPatternAndTimezone(time, timezone);
    await this.queue.upsertJobScheduler(HEARTBEAT_DIGEST_JOB_ID, { pattern, tz }, { name: 'run' });
    this.logger.log(`heartbeat digest scheduled: ${pattern} (${tz})`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async run(): Promise<void> {
    const timezone = this.config.get<string>('HEARTBEAT_DIGEST_TIMEZONE')?.trim() || DEFAULT_TIMEZONE;
    const now = new Date();

    const healthByComponent = (await this.prisma.healthStatus.findMany({ orderBy: { component: 'asc' } })).map(
      (row) => ({ component: row.component, status: row.status }),
    );

    const startOfToday = startOfTodayUtc(now, timezone);
    const alertsToday = await this.prisma.alert.findMany({
      where: { triggeredAt: { gte: startOfToday } },
      select: { ruleSnapshot: true },
    });

    const countByRuleName = new Map<string, number>();
    for (const { ruleSnapshot } of alertsToday) {
      const snapshot = (ruleSnapshot ?? {}) as Record<string, unknown>;
      const ruleName = typeof snapshot.name === 'string' ? snapshot.name : 'Unknown rule';
      countByRuleName.set(ruleName, (countByRuleName.get(ruleName) ?? 0) + 1);
    }

    const text = renderHeartbeatDigestMessage({
      generatedAt: now,
      healthByComponent,
      totalAlertsToday: alertsToday.length,
      alertsByRuleName: [...countByRuleName.entries()].map(([ruleName, count]) => ({ ruleName, count })),
    });

    if (this.telegramConfig.opsChatIds.length === 0) {
      this.logger.warn('heartbeat digest: no TELEGRAM_OPS_CHAT_IDS configured, nothing to send');
      return;
    }

    for (const chatId of this.telegramConfig.opsChatIds) {
      await this.telegramBotClient.sendMessage(chatId, text);
    }
    this.logger.log(`heartbeat digest sent: ${alertsToday.length} alert(s) today`);
  }
}

/** "21:00" -> { pattern: "0 21 * * *", tz: timezone } — same conversion as daily-market-analysis.processor.ts's own, duplicated (not imported) to keep `health` and `alerts` independent of each other, same posture as every other cross-module boundary in this codebase. */
export function toCronPatternAndTimezone(hhmm: string, timezone: string): { pattern: string; tz: string } {
  const [hour, minute] = hhmm.split(':').map(Number);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`HEARTBEAT_DIGEST_TIME must be HH:MM (24h), got "${hhmm}"`);
  }
  return { pattern: `${minute} ${hour} * * *`, tz: timezone };
}

/** Midnight of `now`'s calendar date in `timezone`, expressed as a UTC Date — same DST-correct technique as central-bank-calendar.provider.ts's zonedDateAndTimeToUtc, duplicated locally for the same module-independence reason as toCronPatternAndTimezone above. */
function startOfTodayUtc(now: Date, timezone: string): Date {
  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    now,
  );
  const [year, month, day] = todayKey.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12));
  const zonedHourAtNoonUtc = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit' })
      .formatToParts(noonUtc)
      .find((p) => p.type === 'hour')?.value,
  );
  const offsetHours = 12 - zonedHourAtNoonUtc;
  return new Date(Date.UTC(year, month - 1, day, offsetHours, 0));
}
