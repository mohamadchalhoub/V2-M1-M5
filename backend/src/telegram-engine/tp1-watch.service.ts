/**
 * Watching price so that "TP1 was already reached" is a fact about what the
 * market did, not about what the market happens to be doing at the instant a
 * leg is evaluated.
 *
 * ## Why a watcher is needed at all
 *
 * The rule has to survive a gap. Between a signal being published and its
 * second leg reaching the broker, price can trade through the first target
 * and come back — and a check made only at evaluation time would see the
 * retraced price and open the leg. The scenario is not hypothetical: it is
 * what a fast move into a target and an immediate bounce looks like, which is
 * exactly when a copied signal is most likely to be stale.
 *
 * So this samples the same quote streams the execution path uses and latches
 * the touch the moment it happens. `planLegs` then reads the latch rather
 * than the current price.
 *
 * ## What it watches, and for how long
 *
 * Only signals that could still produce a leg: published recently enough to
 * matter, not already spent, and with at least one leg that has not been
 * submitted. A signal whose legs are all live at the broker needs no watching
 * — the broker owns those positions and closes them at their own targets.
 *
 * The window is deliberately longer than the execution lifetime
 * (`TELEGRAM_SPEC.maxSignalAgeMs`). A signal that is still within its
 * lifetime must still be watched — a stale watch window that stopped short
 * of the lifetime would let a signal trade through TP1 and back unobserved,
 * then execute on the retraced price the latch exists to prevent. A signal
 * whose lifetime has expired is already dead, but latching its touch anyway
 * costs nothing and keeps the dashboard honest about what happened to it.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveQuote } from '../xauusd-m1m5/quote';
import { readQuoteCandidates } from '../xauusd-m1m5/quote-sources';
import { reachesFirstTarget } from './tp1';
import { TELEGRAM_SPEC, type Direction } from './spec';

/**
 * How far back a signal stays under observation. Kept a fixed 15 minutes
 * past the execution lifetime itself, so this scales automatically if that
 * lifetime is ever changed again rather than silently falling behind it.
 */
export const TP1_WATCH_WINDOW_MS = TELEGRAM_SPEC.maxSignalAgeMs + 15 * 60_000;

export interface Tp1SweepResult {
  readonly examined: number;
  readonly latched: number;
  readonly detail: string;
}

@Injectable()
export class TelegramTp1WatchService {
  private readonly logger = new Logger(TelegramTp1WatchService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  /**
   * One sweep. Called on a fast cadence by the ingestion process — fast
   * because the thing being detected is a price touch that can last one tick.
   *
   * Returns rather than throws on a missing quote: a sweep that cannot see
   * price latches nothing, which leaves the existing latches untouched. That
   * is the safe direction, since a latch is only ever set, never cleared.
   */
  async sweep(accountId: string, nowMs: number): Promise<Tp1SweepResult> {
    const candidates = await readQuoteCandidates(this.prisma);
    const resolved = resolveQuote(candidates, nowMs);
    if (!resolved.quote) {
      return { examined: 0, latched: 0, detail: `no usable quote: ${resolved.detail}` };
    }
    // `resolveQuote` returns a stale quote FLAGGED rather than withheld, so
    // that continuity tracking can continue during a gap. Latching from one
    // would be a different matter entirely: the latch is permanent, and
    // cancelling a live signal on a price that is minutes old would destroy a
    // valid trade on evidence that no longer describes the market. Freshness
    // is therefore required here, not merely noted.
    if (!resolved.quote.fresh) {
      return {
        examined: 0,
        latched: 0,
        detail:
          `quote is ${resolved.quote.ageSeconds.toFixed(1)}s old and is not used for latching: a permanent ` +
          'cancellation must not be decided from a stale price.',
      };
    }
    const { bid, ask } = resolved.quote;

    const watched = await this.prisma.telegramSignal.findMany({
      where: {
        accountId,
        tp1Touched: false,
        tp1: { not: null },
        direction: { not: null },
        publishedAt: { gte: new Date(nowMs - TP1_WATCH_WINDOW_MS) },
      },
      select: { id: true, direction: true, tp1: true },
    });

    let latched = 0;
    for (const signal of watched) {
      const direction = signal.direction as Direction | null;
      if (direction === null || signal.tp1 === null) continue;
      // A SELL's target triggers on the ask (it is closed by buying); a BUY's
      // on the bid. Using the wrong side latches a spread early and cancels
      // signals that were still live.
      const closingPrice = direction === 'SELL' ? ask : bid;
      if (!reachesFirstTarget(direction, Number(signal.tp1), closingPrice)) continue;

      // `tp1Touched: false` in the WHERE clause makes this a compare-and-set:
      // a concurrent sweep that latched first leaves this one updating
      // nothing, so the recorded touch instant is the FIRST one observed
      // rather than the last, which is what "already reached" should mean.
      const updated = await this.prisma.telegramSignal.updateMany({
        where: { id: signal.id, tp1Touched: false },
        data: { tp1Touched: true, tp1TouchedAt: new Date(nowMs), tp1TouchPrice: closingPrice },
      });
      if (updated.count > 0) {
        latched += 1;
        this.logger.log(
          `telegram signal ${signal.id}: first target ${signal.tp1} reached at ${closingPrice}. No further leg ` +
            'will be opened from it, and the latch is permanent even if price retraces.',
        );
      }
    }

    return {
      examined: watched.length,
      latched,
      detail: `examined ${watched.length} unspent signal(s) against bid=${bid} ask=${ask}; latched ${latched}.`,
    };
  }
}
