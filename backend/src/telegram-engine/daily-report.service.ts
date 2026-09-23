/**
 * Sends the combined daily report (both engines) once per Beirut calendar
 * day, for the day that just ended, on the first sweep after midnight.
 *
 * Exactly-once comes from the notifier's durable dedup key
 * (`daily-report:<account>:<date>`), not from a timer: a restart, a second
 * worker or a missed tick can neither skip nor duplicate a day. If the
 * process was down at midnight, the report goes out on its next sweep.
 *
 * Runs in the Engine B ingestion process only because that is the long-lived
 * process holding the alert sender. It reads broker deals; it touches neither
 * engine's trading path, and Engine A's own 24-hour report is left as it is.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { attributeDeal } from '../trading-data/engine-attribution';
import {
  buildDailyReport,
  dayBounds,
  localDate,
  previousDate,
  renderDailyReport,
  type ClosedPosition,
  type DailyReport,
} from '../trading-data/daily-report';
import { TelegramEngineNotificationService } from './notifications/notification.service';

@Injectable()
export class DailyReportService {
  private readonly logger = new Logger(DailyReportService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    private readonly notifier: TelegramEngineNotificationService,
  ) {}

  static dedupKey(accountId: string, date: string): string {
    return `daily-report:${accountId}:${date}`;
  }

  /** Sends yesterday's report if it has not been sent yet. Never throws. */
  async runOnce(accountId: string, nowMs: number): Promise<DailyReport | null> {
    try {
      const date = previousDate(localDate(nowMs));
      const key = DailyReportService.dedupKey(accountId, date);
      // Matches both a single-message report (`<key>#chat:…`) and a split one
      // (`<key>:part1#chat:…`).
      const already = await this.prisma.telegramEngineNotification.findFirst({
        where: { OR: [{ dedupKey: { startsWith: `${key}#` } }, { dedupKey: { startsWith: `${key}:part` } }] },
        select: { id: true },
      });
      if (already) return null;

      const report = await this.build(accountId, date);
      const parts = renderDailyReport(report);
      for (const [i, text] of parts.entries()) {
        await this.notifier.notify('DAILY_REPORT', parts.length === 1 ? key : `${key}:part${i + 1}`, text, 'TRADING');
      }
      this.logger.log(`daily report for ${date} sent: ${report.total.wins}W / ${report.total.losses}L`);
      return report;
    } catch (err) {
      this.logger.warn(`daily report failed: ${(err as Error).message}`);
      return null;
    }
  }

  async build(accountId: string, date: string): Promise<DailyReport> {
    const { startMs, endMs } = dayBounds(date);
    const account = await this.prisma.tradingAccount.findUnique({
      where: { id: accountId },
      select: { displayName: true, externalAccountId: true, currency: true },
    });

    // A position is counted on the day its closing deal happened.
    const closing = await this.prisma.trade.findMany({
      where: {
        accountId,
        dealEntry: { in: ['OUT', 'OUT_BY', 'INOUT'] },
        executedAt: { gte: new Date(startMs), lt: new Date(endMs) },
      },
      select: { id: true, positionId: true, profit: true, commission: true, swap: true, rawPayload: true },
    });

    const positionIds = [...new Set(closing.map((d) => d.positionId).filter((p): p is string => p !== null))];
    const allDeals = positionIds.length
      ? await this.prisma.trade.findMany({
          where: { accountId, positionId: { in: positionIds } },
          select: {
            positionId: true,
            dealEntry: true,
            side: true,
            volume: true,
            price: true,
            executedAt: true,
            profit: true,
            commission: true,
            swap: true,
            rawPayload: true,
          },
          orderBy: { executedAt: 'asc' },
        })
      : [];

    const net = (d: { profit: unknown; commission: unknown; swap: unknown }) =>
      Number(d.profit) + Number(d.commission) + Number(d.swap);

    const positions: ClosedPosition[] = [];
    for (const positionId of positionIds) {
      const deals = allDeals.filter((d) => d.positionId === positionId);
      const opening = deals.find((d) => d.dealEntry === 'IN');
      const closes = deals.filter((d) => d.dealEntry !== 'IN');
      const lastClose = closes[closes.length - 1];
      positions.push({
        attribution: attributeDeal(lastClose?.rawPayload ?? null, opening?.rawPayload ?? null),
        net: deals.reduce((s, d) => s + net(d), 0),
        // The position's direction is the opening deal's; a closing deal is
        // the opposite side.
        side: opening?.side ?? (lastClose ? (lastClose.side === 'BUY' ? 'SELL' : 'BUY') : null),
        volume: opening ? Number(opening.volume) : lastClose ? Number(lastClose.volume) : null,
        openPrice: opening ? Number(opening.price) : null,
        closePrice: lastClose ? Number(lastClose.price) : null,
        closedAtMs: lastClose ? lastClose.executedAt.getTime() : null,
      });
    }
    // Closing deals with no position id cannot be grouped; count each alone.
    for (const d of closing.filter((c) => c.positionId === null)) {
      positions.push({ attribution: attributeDeal(d.rawPayload, null), net: net(d) });
    }

    const label = account?.displayName || account?.externalAccountId || accountId;
    return buildDailyReport(date, label, account?.currency ?? '', positions);
  }
}
