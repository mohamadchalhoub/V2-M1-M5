import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RuleType } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import { DAILY_MARKET_ANALYSIS_JOB_ID, DAILY_MARKET_ANALYSIS_QUEUE, DAILY_MARKET_ANALYSIS_QUEUE_NAME } from '../jobs/jobs.constants';
import { createRedisConnection } from '../jobs/redis-connection';
import { PrismaService } from '../prisma/prisma.service';
import { TECHNICAL_ANALYSIS_CONFIG, TechnicalAnalysisConfig } from '../technical-analysis/technical-analysis.config';
import { RuleEngineService } from './rule-engine.service';

/**
 * User's Rules 3+4 (the daily morning report) — the ONLY queue in this app
 * scheduled by wall-clock time-of-day (`DAILY_ANALYSIS_TIME`/
 * `DAILY_ANALYSIS_TIMEZONE`) rather than a fixed interval, using BullMQ's
 * own cron `pattern`+`tz` support (confirmed present in this app's
 * installed bullmq@6.3.2) — reusing the exact scheduled-job architecture
 * every other processor in this codebase already uses
 * (upsertJobScheduler), not a new scheduling mechanism.
 *
 * On each tick, evaluates `DAILY_MARKET_ANALYSIS` for every account that
 * has it enabled — reusing RuleEngineService/AlertLifecycleService in
 * full (Alert persistence, AI analysis, Telegram delivery), via the same
 * `ruleTypeFilter` seam the snapshot-driven path uses to exclude this rule
 * type from its own every-~10-second pass.
 *
 * Reliability fix (production hardening pass) — two gaps the user's own
 * audit questions raised directly ("can the daily job accidentally run
 * multiple times," "what happens if the backend is down at the scheduled
 * time"): `run()` now skips an account whose report already exists for
 * today (in `DAILY_ANALYSIS_TIMEZONE`) before evaluating it — belt-and-
 * braces alongside the rule's own cooldown, not a replacement for it — and
 * `onModuleInit` runs one catch-up pass on boot for any account whose
 * scheduled time has already passed today with no report yet, so a
 * restart shortly after 08:00 doesn't silently skip the whole day.
 */
@Injectable()
export class DailyMarketAnalysisProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DailyMarketAnalysisProcessor.name);
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly ruleEngine: RuleEngineService,
    @Inject(DAILY_MARKET_ANALYSIS_QUEUE) private readonly queue: Queue,
    @Inject(TECHNICAL_ANALYSIS_CONFIG) private readonly technicalAnalysisConfig: TechnicalAnalysisConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    const connection = createRedisConnection(this.config);
    this.worker = new Worker(DAILY_MARKET_ANALYSIS_QUEUE_NAME, () => this.run(), {
      connection,
      concurrency: 1,
    });
    this.worker.on('error', (err) => {
      this.logger.error(`worker error: ${err instanceof Error ? err.message : err}`);
    });
    this.worker.on('failed', (_job, err) => {
      this.logger.error(`daily market analysis tick failed: ${err instanceof Error ? err.message : err}`);
    });

    const { pattern, tz } = toCronPatternAndTimezone(this.technicalAnalysisConfig.dailyAnalysisTime, this.technicalAnalysisConfig.dailyAnalysisTimezone);
    await this.queue.upsertJobScheduler(DAILY_MARKET_ANALYSIS_JOB_ID, { pattern, tz }, { name: 'run' });
    this.logger.log(`daily market analysis scheduled: ${pattern} (${tz})`);

    await this.catchUpIfMissedToday();
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async run(): Promise<void> {
    await this.runForEnabledAccounts(new Date(), 'scheduled tick');
  }

  /**
   * Runs once on every boot — if today's scheduled time has already passed
   * and an account's report hasn't run yet today, generate it now instead
   * of waiting for tomorrow's cron fire. A no-op on a normal boot before
   * the scheduled time, and a no-op if today's report already exists.
   */
  private async catchUpIfMissedToday(): Promise<void> {
    const now = new Date();
    if (!this.hasScheduledTimePassedToday(now)) return;
    await this.runForEnabledAccounts(now, 'startup catch-up — scheduled time already passed today');
  }

  private async runForEnabledAccounts(now: Date, context: string): Promise<void> {
    const rules = await this.prisma.ruleDefinition.findMany({
      where: { ruleType: RuleType.DAILY_MARKET_ANALYSIS, enabled: true },
      select: { id: true, accountId: true },
    });

    if (rules.length === 0) {
      this.logger.log(`daily market analysis (${context}): no account has this rule type enabled — nothing to do`);
      return;
    }

    for (const { id: ruleId, accountId } of rules) {
      try {
        if (await this.alreadyRanToday(ruleId, now)) {
          this.logger.log(`daily market analysis (${context}): already ran today for account=${accountId}, skipping`);
          continue;
        }
        this.logger.log(`daily market analysis (${context}): running for account=${accountId}`);
        await this.ruleEngine.evaluateAccount(accountId, now, { ruleTypeFilter: [RuleType.DAILY_MARKET_ANALYSIS] });
      } catch (err) {
        // One account's failure must never block the others — same
        // isolation posture every other per-account loop in this codebase
        // already has (e.g. collector heartbeat/data-integrity sweeps).
        this.logger.error(`daily market analysis failed for account=${accountId}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private async alreadyRanToday(ruleId: string, now: Date): Promise<boolean> {
    const lastAlert = await this.prisma.alert.findFirst({
      where: { ruleId },
      orderBy: { triggeredAt: 'desc' },
      select: { triggeredAt: true },
    });
    if (!lastAlert) return false;
    const tz = this.technicalAnalysisConfig.dailyAnalysisTimezone;
    return dateKeyInTimezone(lastAlert.triggeredAt, tz) === dateKeyInTimezone(now, tz);
  }

  private hasScheduledTimePassedToday(now: Date): boolean {
    const { dailyAnalysisTime, dailyAnalysisTimezone } = this.technicalAnalysisConfig;
    const [hour, minute] = dailyAnalysisTime.split(':').map(Number);
    const todayKey = dateKeyInTimezone(now, dailyAnalysisTimezone);
    const scheduledUtc = zonedDateAndTimeToUtc(todayKey, hour, minute, dailyAnalysisTimezone);
    return now.getTime() >= scheduledUtc.getTime();
  }
}

/** "08:00" -> { pattern: "0 8 * * *", tz: dailyAnalysisTimezone } — validated upstream by technical-analysis.config.ts's own HH:MM/IANA-timezone checks, so parsing here never fails. */
export function toCronPatternAndTimezone(hhmm: string, timezone: string): { pattern: string; tz: string } {
  const [hour, minute] = hhmm.split(':').map(Number);
  return { pattern: `${minute} ${hour} * * *`, tz: timezone };
}

/** The calendar date (YYYY-MM-DD) `date` falls on in `timezone` — used to compare "same day" across timezone-naive UTC timestamps. */
export function dateKeyInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/**
 * Converts a local calendar date + time in the given IANA timezone to UTC,
 * correct across that timezone's own DST boundary — same technique
 * central-bank-calendar.provider.ts's own zonedDateAndTimeToUtc already
 * uses, duplicated here (not imported) to keep `alerts` and `market-events`
 * independent of each other, same posture as every other cross-module
 * boundary in this codebase.
 */
function zonedDateAndTimeToUtc(dateStr: string, hour: number, minute: number, timeZone: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12));
  const zonedHourAtNoonUtc = Number(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit' })
      .formatToParts(noonUtc)
      .find((p) => p.type === 'hour')?.value,
  );
  const offsetHours = 12 - zonedHourAtNoonUtc;
  return new Date(Date.UTC(year, month - 1, day, hour + offsetHours, minute));
}
