import { PrismaClient } from '@prisma/client';
import {
  previousTradingDayBoundaryStart,
  tradingDayBoundariesInRange,
  tradingDayBoundaryContaining,
} from '../trading-day';
import { HistoricalBaselines } from '../types/analytics.types';
import {
  anchorEquitiesAtBoundaries,
  averagePositionDurationMinutes,
  closingDealStats,
  firstDataInstant,
  inDealVolumeStats,
} from '../queries';
import { round2 } from '../util';

/**
 * Historical baselines over a trailing, configurable window
 * (ANALYTICS_SPEC.md §3). The window always ends at the start of the
 * CURRENT trading day — "today" is never included in its own baseline — and
 * is clipped to the account's actual data history if the account is younger
 * than `windowDays`.
 */
export async function computeHistoricalBaselines(
  prisma: PrismaClient,
  accountId: string,
  tz: string,
  resetHour: number,
  now: Date,
  windowDays: number,
): Promise<HistoricalBaselines> {
  const windowEnd = tradingDayBoundaryContaining(now, tz, resetHour).start;

  let uncappedWindowStart = windowEnd;
  for (let i = 0; i < windowDays; i++) {
    uncappedWindowStart = previousTradingDayBoundaryStart(uncappedWindowStart, tz, resetHour);
  }

  const { firstSnapshotAt, firstTradeAt } = await firstDataInstant(prisma, accountId);
  const candidates = [firstSnapshotAt, firstTradeAt].filter((d): d is Date => d !== null);
  const earliestData = candidates.length === 0 ? null : new Date(Math.min(...candidates.map((d) => d.getTime())));

  // No snapshot and no trade ever recorded for this account: there is no
  // basis for a baseline at all, not even "zero activity for N days" — that
  // would assert knowledge of a history that doesn't exist. The window
  // collapses to empty (windowStart = windowEnd) rather than falling back to
  // the full uncapped window.
  const windowStart =
    earliestData === null
      ? windowEnd
      : new Date(
          Math.max(
            uncappedWindowStart.getTime(),
            tradingDayBoundaryContaining(earliestData, tz, resetHour).start.getTime(),
          ),
        );

  const dayBoundaries = tradingDayBoundariesInRange(windowStart, windowEnd, tz, resetHour);
  const windowCompleteDays = dayBoundaries.length;

  const range = { start: windowStart, end: windowEnd };

  const [dealStats, volumeStats, durationMinutes, dailyPlSeries] = await Promise.all([
    closingDealStats(prisma, accountId, range),
    inDealVolumeStats(prisma, accountId, range),
    averagePositionDurationMinutes(prisma, accountId, range),
    computeDailyPlSeries(prisma, accountId, dayBoundaries, windowEnd),
  ]);

  const averageDailyPl =
    dailyPlSeries.length === 0
      ? null
      : round2(dailyPlSeries.reduce((sum, v) => sum + v, 0) / dailyPlSeries.length);

  const losingDays = dailyPlSeries.filter((v) => v < 0);
  const averageDailyLoss =
    losingDays.length === 0
      ? null
      : round2(losingDays.reduce((sum, v) => sum + -v, 0) / losingDays.length);

  const averageTradesPerDay =
    windowCompleteDays === 0 ? null : round2(dealStats.totalTrades / windowCompleteDays);
  const averageTradesPerHour =
    windowCompleteDays === 0 ? null : round2(dealStats.totalTrades / (windowCompleteDays * 24));

  return {
    windowDays,
    windowStart,
    windowEnd,
    averageDailyPl,
    averageDailyLoss,
    averageTradesPerDay,
    averagePositionVolume: volumeStats.average === null ? null : round2(volumeStats.average),
    maximumNormalPositionVolume: volumeStats.max === null ? null : round2(volumeStats.max),
    averageTradeDuration: durationMinutes === null ? null : round2(durationMinutes),
    averageLosingTrade: dealStats.averageLosingTrade === null ? null : round2(dealStats.averageLosingTrade),
    averageWinningTrade: dealStats.averageWinningTrade === null ? null : round2(dealStats.averageWinningTrade),
    averageTradesPerHour,
  };
}

/**
 * One realized-equity delta per complete trading day in the window: for each
 * consecutive pair of day boundaries, `equity(dayEnd) - equity(dayStart)`,
 * where both anchors come from the single batched query in
 * `anchorEquitiesAtBoundaries`. A day missing either anchor (no snapshot
 * data yet at that point in the account's history) contributes nothing to
 * the series — it is excluded, not treated as a zero P/L day.
 */
async function computeDailyPlSeries(
  prisma: PrismaClient,
  accountId: string,
  dayBoundaries: Date[],
  windowEnd: Date,
): Promise<number[]> {
  if (dayBoundaries.length === 0) return [];

  const allBoundaries = [...dayBoundaries, windowEnd];
  const anchors = await anchorEquitiesAtBoundaries(prisma, accountId, allBoundaries);

  const series: number[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const dayStart = anchors[i].equity;
    const dayEnd = anchors[i + 1].equity;
    if (dayStart !== null && dayEnd !== null) {
      series.push(dayEnd - dayStart);
    }
  }
  return series;
}
