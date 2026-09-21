import { PrismaClient } from '@prisma/client';
import { TradingActivityMetrics } from '../types/analytics.types';
import { closingDealStats, commissionSwapTotals } from '../queries';
import { round2, round4 } from '../util';

/** All-time trading-activity totals (ANALYTICS_SPEC.md §2.2) — unwindowed. */
export async function computeTradingActivityMetrics(
  prisma: PrismaClient,
  accountId: string,
): Promise<TradingActivityMetrics> {
  const [deals, commissionSwap] = await Promise.all([
    closingDealStats(prisma, accountId),
    commissionSwapTotals(prisma, accountId),
  ]);

  const decided = deals.winningTrades + deals.losingTrades;

  return {
    totalTrades: deals.totalTrades,
    winningTrades: deals.winningTrades,
    losingTrades: deals.losingTrades,
    winRate: decided === 0 ? null : round4(deals.winningTrades / decided),
    averageWinningTrade: deals.averageWinningTrade === null ? null : round2(deals.averageWinningTrade),
    averageLosingTrade: deals.averageLosingTrade === null ? null : round2(deals.averageLosingTrade),
    largestWinningTrade: deals.largestWinningTrade === null ? null : round2(deals.largestWinningTrade),
    largestLosingTrade: deals.largestLosingTrade === null ? null : round2(deals.largestLosingTrade),
    totalRealizedPlGross: round2(deals.totalRealizedPlGross),
    totalRealizedPl: round2(deals.totalRealizedPl),
    totalCommission: round2(commissionSwap.totalCommission),
    totalSwap: round2(commissionSwap.totalSwap),
  };
}
