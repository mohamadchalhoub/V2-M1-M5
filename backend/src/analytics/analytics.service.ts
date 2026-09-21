import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { computeAccountSessionMetrics } from './metrics/account.metrics';
import { computeTradingActivityMetrics } from './metrics/trading-activity.metrics';
import { computePositionBehaviorMetrics } from './metrics/position.metrics';
import { computeTradingFrequencyMetrics } from './metrics/frequency.metrics';
import { computeBehavioralSequenceMetrics } from './metrics/sequence.metrics';
import { computeHistoricalBaselines } from './baselines/baselines';
import { tradesInTrailingWindow } from './metrics/frequency.metrics';
import { CurrentMetrics, HistoricalBaselines } from './types/analytics.types';

const DEFAULT_BASELINE_WINDOW_DAYS = 90;

/**
 * Public entry point for analytics (Phase 3). Everything here is a read plus
 * arithmetic — no decision-making, no alerting, no AI, no writes. Phase 4's
 * rule engine is expected to call this in-process; there is deliberately no
 * HTTP controller in this module (ANALYTICS_SPEC.md §0).
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private defaultWindowDays(): number {
    const raw = this.config.get<string>('ANALYTICS_BASELINE_WINDOW_DAYS');
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BASELINE_WINDOW_DAYS;
  }

  async getCurrentMetrics(accountId: string, now: Date = new Date()): Promise<CurrentMetrics> {
    const account = await this.prisma.tradingAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { tradingDayTimezone: true, tradingDayResetHour: true },
    });
    const tz = account.tradingDayTimezone;
    const resetHour = account.tradingDayResetHour;

    const [accountSession, activity, position, frequency, sequences] = await Promise.all([
      computeAccountSessionMetrics(this.prisma, accountId, tz, resetHour, now),
      computeTradingActivityMetrics(this.prisma, accountId),
      computePositionBehaviorMetrics(this.prisma, accountId),
      computeTradingFrequencyMetrics(this.prisma, accountId, tz, resetHour, now),
      computeBehavioralSequenceMetrics(this.prisma, accountId),
    ]);

    return { account: accountSession, activity, position, frequency, sequences };
  }

  async getHistoricalBaselines(
    accountId: string,
    options: { now?: Date; windowDays?: number } = {},
  ): Promise<HistoricalBaselines> {
    const now = options.now ?? new Date();
    const windowDays = options.windowDays ?? this.defaultWindowDays();

    const account = await this.prisma.tradingAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { tradingDayTimezone: true, tradingDayResetHour: true },
    });

    return computeHistoricalBaselines(
      this.prisma,
      accountId,
      account.tradingDayTimezone,
      account.tradingDayResetHour,
      now,
      windowDays,
    );
  }

  /**
   * Phase 4 addition for `TRADE_FREQUENCY_MULTIPLE` (ANALYTICS_SPEC.md §2.6).
   * The account existence check is deliberately skipped here (unlike
   * `getCurrentMetrics`/`getHistoricalBaselines`) — the rule engine always
   * calls this only after already loading the account's current metrics in
   * the same evaluation pass, so a nonexistent account would already have
   * thrown earlier.
   */
  async getTradesInTrailingWindow(
    accountId: string,
    windowMinutes: number,
    now: Date = new Date(),
  ): Promise<number> {
    return tradesInTrailingWindow(this.prisma, accountId, windowMinutes, now);
  }
}
