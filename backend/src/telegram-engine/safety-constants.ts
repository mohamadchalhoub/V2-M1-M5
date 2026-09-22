/**
 * Engine B's own non-negotiable bounds.
 *
 * Separate from Engine A's `xauusd-m1m5/safety-constants.ts` for the same
 * reason that file is separate from the strategy before it: two strategies
 * must never share a magic number, so that every broker position is
 * attributable to exactly one owner and an accidental code-path reuse fails a
 * magic-number check loudly instead of operating on another engine's
 * position.
 *
 * That property is what makes Engine A's Friday liquidation safe in the
 * presence of Engine B. Engine A liquidates by selecting its OWN magic
 * numbers (see `xauusd-m1m5/liquidation.ts`), so a Telegram position is
 * excluded from it structurally — not because a condition was remembered.
 */

/**
 * THE Telegram engine magic number.
 *
 * Clear of every number in use on this broker account:
 *
 *   262610180  legacy EURUSD autonomous strategy
 *   262610181  H4 confirmed-retest gold (archived)
 *   262610190  xauusd-m1-rsi-retest-extremes-v1, RETEST slot   <- still live
 *   262610191  xauusd-m1-rsi-retest-extremes-v1, EXTREME slot  <- still live
 *   262610200  Engine A, M1 path
 *   262610201  Engine A, M5 path
 *   262610210  THIS engine
 *
 * One magic for all Telegram legs rather than one per leg: the legs of a
 * signal are not different execution paths competing for a slot the way
 * Engine A's M1 and M5 are — they are deliberately simultaneous parts of one
 * trade. They are told apart by ticket and by their stored leg index, and
 * what the magic number has to answer is only ever "may this application
 * touch this position, and as which engine".
 */
export const TELEGRAM_MAGIC = 262610210;

/**
 * Magic numbers known to belong to something OTHER than Engine B, including
 * Engine A. A denylist for self-checking at startup — never a list of things
 * this engine may act on. Everything here is foreign to Engine B and is never
 * closed, modified, adopted or relabelled by it.
 */
export const TELEGRAM_FOREIGN_MAGIC_NUMBERS: readonly number[] = [
  262610180, 262610181, 262610190, 262610191, 262610200, 262610201,
];

/**
 * How old the broker quote used for the entry-deviation check may be.
 *
 * Tighter than the signal lifetime on purpose: a stale quote cannot show that
 * price has run away from the published entry, which is the single thing that
 * check exists to catch.
 */
export const TELEGRAM_QUOTE_MAX_STALENESS_MS = 5_000;

/** Broker volume envelope Engine B validates against, never rounds into. */
export const TELEGRAM_MIN_LOTS = 0.01;
export const TELEGRAM_MAX_LOTS = 100;
export const TELEGRAM_LOT_STEP = 0.01;
