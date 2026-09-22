/**
 * `telegram-sfxauusd1-copy-v1` — ENGINE B.
 *
 * This is a SECOND, INDEPENDENT strategy engine living in the same
 * application as `xauusd-m1-m5-rsi-threshold-v2` (Engine A). The two share an
 * MT5 account and therefore share account-level safety; they share nothing
 * else, and this file exists to make that separation a compile-time fact
 * rather than a convention someone has to remember.
 *
 * ## What Engine B is
 *
 * It copies structured trade signals published by one Telegram channel. It
 * has no indicator, no rearming, no post-loss locks and — the point most
 * easily got wrong — **no time-of-day entry pause**.
 *
 * ## What Engine B deliberately does NOT import
 *
 * `../xauusd-m1m5/schedule`. Engine A pauses new entries 14:00–19:00 and
 * 23:30–01:00 Beirut and stops entering on Friday at 23:00. Those are Engine
 * A STRATEGY rules, not account-level safety, and inheriting them here would
 * silently discard most of a day's Telegram signals for a reason that has
 * nothing to do with this engine. A signal published at 16:00 Beirut is
 * executed at 16:00 Beirut.
 *
 * The only timing restriction Engine B has of its own is the hard 60-second
 * lifetime below, plus whether the broker will actually accept an order at
 * all (see `availability.ts`). Those are different things: the first is a
 * strategy rule, the second is physics.
 *
 * Engine B also does not import Engine A's `locks`, `crossing`, `rsi`,
 * `occupancy.service`, `brackets` or `liquidation`. Every one of those
 * encodes a rule that belongs to Engine A alone.
 */

export const TELEGRAM_ENGINE_VERSION = 'telegram-sfxauusd1-copy-v1';

export type Direction = 'BUY' | 'SELL';

export const TELEGRAM_SPEC = {
  /** The ONLY source this engine will act on. Anything else is discarded. */
  sourceChannelUsername: 'SFxauusd1',

  symbol: 'XAUUSD',

  /**
   * Hard publication-to-submission lifetime.
   *
   * Measured from the ORIGINAL Telegram publication timestamp to the instant
   * each individual leg is handed to the broker — not to the instant the
   * message was received, and not once per signal. A two-leg signal whose
   * first leg is submitted at 58s and whose second would land at 61s submits
   * the first and refuses the second. See `freshness.ts`.
   */
  maxSignalAgeMs: 60_000,

  /**
   * Clock skew tolerance for a publication timestamp dated in the future.
   *
   * `age <= limit` accepts every negative age, so without an explicit bound a
   * future-dated message would pass the lifetime check unconditionally and
   * forever. Beyond this tolerance a negative age is a wrong clock or a wrong
   * conversion, not a very fresh signal.
   */
  futurePublicationToleranceMs: 2_000,

  /** One independent position per take-profit, at this size each. */
  lotsPerTakeProfit: 0.01,

  /**
   * Upper bound on legs from a single message. A parse that produced more
   * take-profits than this is far more likely to be a misparse of a
   * commentary post than a genuine 12-leg trade, and opening twelve positions
   * on that basis is not recoverable.
   */
  maxTakeProfits: 6,

  /**
   * Entry protection is ADVERSE-ONLY and lives in `tp1.ts`, bounded by
   * `TELEGRAM_MAX_ADVERSE_ENTRY_DEVIATION_USD` (see `controls.ts`).
   *
   * There is deliberately no symmetric deviation constant here any more. One
   * was tried and was wrong: for a SELL published at 4338, a market at 4330
   * is eight dollars NEARER the target at the same stop — the best available
   * version of the trade — and a symmetric band refused exactly that. The two
   * bounds that replaced it are "not materially worse than published" at one
   * end and "TP1 not already reached" at the other.
   */

  /**
   * Window within which a semantically identical trade published under a
   * DIFFERENT message id is treated as a duplicate rather than a new signal.
   *
   * Channels repost. A repost of "sell 4338, SL 4348, TP 4329/4300" ninety
   * seconds later is the same trade said twice, not two trades.
   */
  semanticDuplicateWindowMs: 30 * 60_000,
} as const;
