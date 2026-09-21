import { PrismaClient } from '@prisma/client';
import { tradingDayBoundaryContaining } from '../trading-day';
import { TradingFrequencyMetrics } from '../types/analytics.types';
import { round2 } from '../util';

const CLOSING_ENTRIES = ['OUT', 'INOUT', 'OUT_BY'] as const;
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Loads every closing deal's `executedAt` for the account, ordered
 * deterministically. Bounded by trade count (not snapshot count) — see
 * ANALYTICS_SPEC.md §3 implementation note on why this is acceptable to load
 * whole, unlike the snapshot tables.
 */
async function orderedClosingDealTimestamps(prisma: PrismaClient, accountId: string): Promise<Date[]> {
  const rows = await prisma.trade.findMany({
    where: { accountId, dealEntry: { in: [...CLOSING_ENTRIES] } },
    select: { executedAt: true },
    orderBy: [{ executedAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((r) => r.executedAt);
}

export async function computeTradingFrequencyMetrics(
  prisma: PrismaClient,
  accountId: string,
  tz: string,
  resetHour: number,
  now: Date,
): Promise<TradingFrequencyMetrics> {
  const { start: tradingDayStart, end: tradingDayEnd } = tradingDayBoundaryContaining(now, tz, resetHour);
  const hourWindowStart = new Date(now.getTime() - ONE_HOUR_MS);

  const [tradesPerDay, tradesPerHour, timestamps] = await Promise.all([
    prisma.trade.count({
      where: {
        accountId,
        dealEntry: { in: [...CLOSING_ENTRIES] },
        executedAt: { gte: tradingDayStart, lt: tradingDayEnd },
      },
    }),
    prisma.trade.count({
      where: {
        accountId,
        dealEntry: { in: [...CLOSING_ENTRIES] },
        executedAt: { gte: hourWindowStart, lte: now },
      },
    }),
    orderedClosingDealTimestamps(prisma, accountId),
  ]);

  let averageTimeBetweenTrades: number | null = null;
  if (timestamps.length >= 2) {
    let totalGapMs = 0;
    for (let i = 1; i < timestamps.length; i++) {
      totalGapMs += timestamps[i].getTime() - timestamps[i - 1].getTime();
    }
    averageTimeBetweenTrades = round2(totalGapMs / (timestamps.length - 1) / 60_000);
  }

  let averageTradesPerSession: number | null = null;
  if (timestamps.length > 0) {
    const activeDays = new Set<number>();
    for (const t of timestamps) {
      activeDays.add(tradingDayBoundaryContaining(t, tz, resetHour).start.getTime());
    }
    averageTradesPerSession = round2(timestamps.length / activeDays.size);
  }

  return {
    tradesPerDay,
    tradesPerHour,
    averageTimeBetweenTrades,
    averageTradesPerSession,
  };
}

/**
 * Phase 4 addition (RULE_ENGINE_SPEC.md §12.12 decision 2) — count of closing
 * deals in the trailing `windowMinutes` ending at `now`. Generalizes
 * `tradesPerHour` above (a fixed 60-minute window) to an arbitrary window
 * length, which `TRADE_FREQUENCY_MULTIPLE` rules need since `window_minutes`
 * is a per-rule parameter. Not part of `TradingFrequencyMetrics` — that shape
 * is Phase 3's fixed set of "current" facts; this is a parametrized query the
 * rule engine calls directly, one extra `AnalyticsService` method, nothing
 * else in Phase 3 changes.
 */
export async function tradesInTrailingWindow(
  prisma: PrismaClient,
  accountId: string,
  windowMinutes: number,
  now: Date,
): Promise<number> {
  const windowStart = new Date(now.getTime() - windowMinutes * 60_000);
  return prisma.trade.count({
    where: {
      accountId,
      dealEntry: { in: [...CLOSING_ENTRIES] },
      executedAt: { gte: windowStart, lte: now },
    },
  });
}
