/**
 * The first target, and the rule that the trade is over once price has
 * reached it.
 *
 * ## Why TP1 is computed rather than taken as "the first one listed"
 *
 * The channel usually publishes its targets nearest-first, but nothing
 * guarantees it, and the consequence of getting this wrong is not cosmetic:
 * TP1 is what decides whether an unexecuted signal is still worth taking. For
 * a SELL, the nearest target is the HIGHEST of the targets (the first price
 * a falling market reaches); for a BUY it is the LOWEST. Publication order is
 * preserved separately, for the audit trail and for leg numbering, and is
 * never used for this.
 *
 * ## Why a touch is permanent
 *
 * The signal's premise is "enter around here, before it moves". Once price
 * has already traded through the first target, that move has happened — the
 * opportunity the message described is spent. Price retracing afterwards does
 * not restore it; it just offers a worse version of a trade nobody published.
 *
 * So `tp1Touched` is a latch. It is computed from observed prices, written to
 * the database, and once true it is never recomputed back to false. A rule
 * that re-read only the CURRENT price would let a signal come back to life
 * every time the market wobbled back across the level, which is precisely the
 * behaviour this exists to prevent.
 */
import type { Direction } from './spec';

/**
 * The nearest valid target in the direction of the trade.
 *
 * SELL 4338 with targets 4329 and 4300 -> 4329.
 * BUY  4331 with targets 4338 and 4350 -> 4338.
 */
export function firstTarget(direction: Direction, takeProfits: readonly number[]): number {
  if (takeProfits.length === 0) throw new Error('a signal with no take profit has no first target');
  return direction === 'SELL' ? Math.max(...takeProfits) : Math.min(...takeProfits);
}

/**
 * Has the market reached the first target?
 *
 * Inclusive of the level itself: "TP1 4329" being touched means price traded
 * AT 4329, not merely through it. A strict inequality would let a signal
 * execute at the exact moment its target printed.
 */
export function reachesFirstTarget(direction: Direction, tp1: number, price: number): boolean {
  return direction === 'SELL' ? price <= tp1 : price >= tp1;
}

export interface Tp1State {
  readonly tp1: number;
  /** Latched. Once true for a signal, it never returns to false. */
  readonly touched: boolean;
  readonly touchedAtMs: number | null;
  readonly touchPrice: number | null;
}

export interface Tp1Observation {
  /** The best and worst prices seen since the signal was published. */
  readonly bid: number;
  readonly ask: number;
  readonly atMs: number;
}

/**
 * Folds one price observation into the latch.
 *
 * The side checked is the side the trade would be CLOSED at, because that is
 * the side a take profit actually triggers on: a SELL is closed by buying, at
 * the ask. Checking the bid for a SELL would declare the target reached a
 * spread early, cancelling signals that were still live.
 */
export function observeTp1(state: Tp1State, direction: Direction, observation: Tp1Observation): Tp1State {
  if (state.touched) return state;
  const closingPrice = direction === 'SELL' ? observation.ask : observation.bid;
  if (!reachesFirstTarget(direction, state.tp1, closingPrice)) return state;
  return { tp1: state.tp1, touched: true, touchedAtMs: observation.atMs, touchPrice: closingPrice };
}

export function initialTp1State(direction: Direction, takeProfits: readonly number[]): Tp1State {
  return { tp1: firstTarget(direction, takeProfits), touched: false, touchedAtMs: null, touchPrice: null };
}

/**
 * Direction-aware entry protection.
 *
 * The rule this replaces was a symmetric absolute deviation, and it was
 * wrong in a way worth stating plainly: for a SELL published at 4338, a
 * market at 4330 is EIGHT DOLLARS BETTER than the signal asked for — it is
 * eight dollars nearer the target, entered at a better price, with the same
 * stop. Rejecting it as "deviation" refuses the best version of the trade.
 *
 * Only ADVERSE movement is bounded:
 *
 *   SELL — executing BELOW the published entry is favourable (toward TP1);
 *          executing ABOVE it is adverse and is bounded.
 *   BUY  — executing ABOVE the published entry is favourable;
 *          executing BELOW it is adverse and is bounded.
 *
 * Favourable movement is still not unlimited in practice — it is bounded by
 * TP1 itself, since a market that has run all the way to the first target
 * cancels the signal outright (`reachesFirstTarget`). Those two rules
 * together are what replaces the symmetric band: one end is "not too much
 * worse than published", the other is "not already finished".
 */
export interface DeviationVerdict {
  readonly acceptable: boolean;
  /** Signed: positive is adverse, negative is favourable. */
  readonly adverseUsd: number;
  readonly favourable: boolean;
  readonly detail: string;
}

export function evaluateEntryDeviation(
  direction: Direction,
  publishedEntry: number,
  executablePrice: number,
  maxAdverseUsd: number,
): DeviationVerdict {
  // Positive when the market is WORSE than published, for either direction.
  const adverseUsd =
    direction === 'SELL' ? executablePrice - publishedEntry : publishedEntry - executablePrice;
  const favourable = adverseUsd <= 0;

  if (favourable) {
    return {
      acceptable: true,
      adverseUsd,
      favourable: true,
      detail:
        `The executable price ${executablePrice} is $${Math.abs(adverseUsd).toFixed(2)} BETTER than the published ` +
        `entry ${publishedEntry} for a ${direction} — movement toward the target. Accepted: this is the same ` +
        'trade at a better price, not a different one.',
    };
  }
  if (adverseUsd > maxAdverseUsd) {
    return {
      acceptable: false,
      adverseUsd,
      favourable: false,
      detail:
        `The executable price ${executablePrice} is $${adverseUsd.toFixed(2)} WORSE than the published entry ` +
        `${publishedEntry} for a ${direction}, beyond the $${maxAdverseUsd.toFixed(2)} adverse limit. The entry ` +
        'is not chased: a copy taken materially worse than published carries more risk to the same stop.',
    };
  }
  return {
    acceptable: true,
    adverseUsd,
    favourable: false,
    detail: `The executable price is $${adverseUsd.toFixed(2)} worse than published, within the $${maxAdverseUsd.toFixed(2)} adverse limit.`,
  };
}
