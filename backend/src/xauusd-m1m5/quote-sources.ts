/**
 * Reading the two price streams the observation loop chooses between.
 *
 * Lives here rather than in the scheduler script so it can be tested against
 * a real database -- which is where both of its bugs so far would have been
 * visible, and no mock would have shown them.
 *
 *   live_ticks        the latest quote, riding on the collector's account
 *                     snapshot every ~10s. Stored as TRUE UTC.
 *   historical_ticks  every tick from the collector's one-second stream.
 *                     Stored as BROKER WALL CLOCK labelled UTC, and so
 *                     corrected here. See tick-time.ts.
 *
 * `resolveQuote` then takes the newest valid candidate, so the one-second
 * stream wins whenever it is fresher -- which is only true once its timestamps
 * are on the same timeline as the other stream.
 */
import type { PrismaClient } from '@prisma/client';
import type { QuoteCandidate } from './quote';
import { SPEC } from './spec';
import { storedBrokerTimeToUtcMs } from './tick-time';

export async function readQuoteCandidates(prisma: PrismaClient): Promise<QuoteCandidate[]> {
  const candidates: QuoteCandidate[] = [];

  const live = await prisma.liveTick.findFirst({ where: { symbol: SPEC.symbol } });
  if (live) {
    candidates.push({
      bid: Number(live.bid),
      ask: Number(live.ask),
      // Already true UTC on the way in; normalised exactly once, upstream.
      tickAtMs: live.tickAt.getTime(),
      source: 'live_ticks',
    });
  }

  const historical = await prisma.historicalTick.findFirst({
    where: { symbol: SPEC.symbol },
    orderBy: { timestamp: 'desc' },
  });
  if (historical && historical.bid !== null && historical.ask !== null) {
    // Broker wall clock, NOT UTC. Uncorrected it reads three hours in the
    // future and is rejected, which silently disables the one-second stream.
    const tickAtMs = storedBrokerTimeToUtcMs(historical.timestamp.getTime());
    if (tickAtMs !== null) {
      candidates.push({
        bid: Number(historical.bid),
        ask: Number(historical.ask),
        tickAtMs,
        source: 'historical_ticks',
      });
    }
  }

  return candidates;
}
