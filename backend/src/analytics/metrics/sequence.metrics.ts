import { PrismaClient } from '@prisma/client';
import { BehavioralSequenceMetrics } from '../types/analytics.types';
import { netProfitOf } from '../util';

const CLOSING_ENTRIES = ['OUT', 'INOUT', 'OUT_BY'] as const;

type Outcome = 'WIN' | 'LOSS' | 'BREAKEVEN';

function outcomeOf(netProfit: number): Outcome {
  if (netProfit > 0) return 'WIN';
  if (netProfit < 0) return 'LOSS';
  return 'BREAKEVEN';
}

/**
 * Walks closing deals in execution order and computes win/loss streaks.
 * A breakeven deal breaks both streaks (ANALYTICS_SPEC.md §2.5) — it is not
 * skipped, since a streak is defined as an unbroken run of the same outcome.
 */
export async function computeBehavioralSequenceMetrics(
  prisma: PrismaClient,
  accountId: string,
): Promise<BehavioralSequenceMetrics> {
  const deals = await prisma.trade.findMany({
    where: { accountId, dealEntry: { in: [...CLOSING_ENTRIES] } },
    select: { profit: true, commission: true, swap: true },
    orderBy: [{ executedAt: 'asc' }, { id: 'asc' }],
  });

  let currentConsecutiveWins = 0;
  let currentConsecutiveLosses = 0;
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let runningWinStreak = 0;
  let runningLossStreak = 0;

  for (const deal of deals) {
    const outcome = outcomeOf(netProfitOf(deal));

    if (outcome === 'WIN') {
      runningWinStreak += 1;
      runningLossStreak = 0;
    } else if (outcome === 'LOSS') {
      runningLossStreak += 1;
      runningWinStreak = 0;
    } else {
      runningWinStreak = 0;
      runningLossStreak = 0;
    }

    maxConsecutiveWins = Math.max(maxConsecutiveWins, runningWinStreak);
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, runningLossStreak);
  }

  currentConsecutiveWins = runningWinStreak;
  currentConsecutiveLosses = runningLossStreak;

  return {
    currentConsecutiveWins,
    currentConsecutiveLosses,
    maxConsecutiveWins,
    maxConsecutiveLosses,
  };
}
