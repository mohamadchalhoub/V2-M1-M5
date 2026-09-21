/**
 * Machine-readable half of XAUUSD_M1_M5_RSI_THRESHOLD_V2_SPEC.md.
 *
 * Every number this strategy's decisions depend on lives here and nowhere
 * else, so there is exactly one place to read the rules from and exactly one
 * thing to hash. `SPEC_HASH` is derived from the frozen object below; a
 * persisted state file carries the hash it was written under and is REFUSED
 * (never silently migrated) if the rules have since changed — the same
 * posture the previous strategy established, for the same reason: mixing two
 * rule versions inside one state file produces decisions no audit can later
 * explain.
 *
 * Nothing here is tunable at runtime. These are not `.env` values on
 * purpose: the user's rules are not operator-adjustable, and an entry
 * threshold that could be edited without a spec re-freeze would make the
 * hash meaningless.
 */
import { createHash } from 'node:crypto';

export const XAUUSD_M1M5_STRATEGY_VERSION = 'xauusd-m1-m5-rsi-threshold-v2';

/**
 * The two independent execution paths. Everything in this strategy that can
 * hold state — RSI, crossing/rearming, occupancy, post-loss locks,
 * ownership, performance — is keyed by one of these and never shared.
 */
export const TIMEFRAMES = ['M1', 'M5'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const DIRECTIONS = ['SELL', 'BUY'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Bar duration of each timeframe, in ms. */
export const TIMEFRAME_BAR_MS: Readonly<Record<Timeframe, number>> = {
  M1: 60_000,
  M5: 300_000,
};

export const SPEC = {
  strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
  symbol: 'XAUUSD',
  /** USER RULE §3 — M1 and M5 only, run independently under the same rules. */
  timeframes: TIMEFRAMES,

  rsi: {
    /** USER RULE §3 — "Indicator: RSI(5), PRICE_CLOSE, Wilder smoothing." */
    period: 5,
    appliedPrice: 'CLOSE' as const,
    smoothing: 'WILDER' as const,
    /**
     * Closed bars required beyond the `period` seed before any signal may be
     * emitted. Wilder's recursive average carries its seeding transient for
     * many multiples of the period; 250 bars is a deliberately generous
     * margin, not a tuned value. Applied per timeframe against that
     * timeframe's own closed-bar count, so M5 warm-up needs 250 M5 bars —
     * it is not satisfied by M1 progress.
     */
    warmupBars: 250,
  },

  thresholds: {
    /**
     * USER RULE §3.1 — SELL when `previous RSI < 91 AND current RSI >= 91`.
     * The intrabar crossing itself is the signal: no peak, pullback, falling
     * candle, confirmation or retest is required.
     */
    sellCross: 91,
    /**
     * USER RULE §3.2 — BUY when `previous RSI > 8.9 AND current RSI <= 8.9`.
     * Likewise no trough, rebound, rising candle, confirmation or retest.
     */
    buyCross: 8.9,
  },

  /**
   * USER RULE §6 — post-loss directional unlock conditions.
   *
   * These four numbers are the ONLY remaining meaning of 98.5 and 1.5 in
   * this strategy. §3.4 removes standalone extreme entries entirely, so
   * 98.5/1.5 must never be presented anywhere as entry thresholds; they
   * unlock a direction that a realized loss locked, and unlocking is not an
   * entry (§6.3).
   */
  postLossUnlock: {
    /** A locked SELL direction unlocks when RSI <= 25 OR RSI >= 98.5. Equality counts. */
    sell: { rsiAtOrBelow: 25, rsiAtOrAbove: 98.5 },
    /** A locked BUY direction unlocks when RSI >= 75 OR RSI <= 1.5. Equality counts. */
    buy: { rsiAtOrAbove: 75, rsiAtOrBelow: 1.5 },
  },

  /**
   * USER RULE §4 — at most one active, pending or uncertain exposure per
   * timeframe, giving a maximum of two simultaneous strategy positions (one
   * M1, one M5). An M1 position does not occupy M5 and vice versa.
   */
  occupancy: {
    maxConcurrentEntriesPerTimeframe: 1,
    maxConcurrentEntriesTotal: 2,
  },

  brackets: {
    /**
     * USER RULE §7 — TP and SL are each a $5.00 move in quoted gold price.
     * A gold-PRICE distance, not broker points and not a promised
     * account-currency amount. SELL at 4450 → TP 4445, SL 4455.
     */
    takeProfitUsd: 5,
    stopLossUsd: 5,
  },

  schedule: {
    timeZone: 'Asia/Beirut',
    /**
     * USER RULE §9.1 — BOTH daily entry pauses apply, every day, to both
     * timeframes. Entries are blocked during either.
     *
     * The overnight pause wraps midnight (23:30 inclusive → 01:00 exclusive
     * the following day). The afternoon pause does not wrap: it is 14:00
     * inclusive → 19:00 exclusive on the SAME day. That same-day reading was
     * explicitly confirmed by the user; the earlier "the following day"
     * wording would have described a 29-hour interval that overlaps its own
     * next occurrence and blocks nearly every entry, and it is not what was
     * intended.
     *
     * The former 04:00–12:00 restriction remains removed.
     */
    overnightPauseStartSecondsBeirut: 23 * 3600 + 30 * 60,
    overnightPauseEndSecondsBeirutExclusive: 1 * 3600,
    afternoonPauseStartSecondsBeirut: 14 * 3600,
    afternoonPauseEndSecondsBeirutExclusive: 19 * 3600,

    /** USER RULE §9.2 — Friday entries allowed strictly before 23:00:00. */
    fridayEntryCutoffSecondsBeirut: 23 * 3600,
    /** USER RULE §9.3 — owned exposure must be broker-confirmed flat before 23:30. */
    fridayClosureDeadlineSecondsBeirut: 23 * 3600 + 30 * 60,
    /**
     * USER RULE §9.3 — "Begin liquidation at the Friday 23:00 cutoff." This
     * leaves half an hour of retry and reconciliation headroom before the
     * deadline rather than starting at 23:29.
     */
    fridayLiquidationStartSecondsBeirut: 23 * 3600,
  },

  observation: {
    /**
     * IMPLEMENTATION ASSUMPTION (§10) — a gap longer than this between two
     * consecutive accepted observations on a timeframe means the engine
     * cannot honestly claim to know what RSI did in between, so that
     * timeframe's crossing state is reset rather than carried across. No
     * crossing is ever invented through an unobserved interval (§3.3), and
     * a gap can never fabricate an unlock (§6.5).
     *
     * Scaled per timeframe: one full bar plus 50% margin.
     */
    maxContinuityGapMs: { M1: 90_000, M5: 450_000 } as Readonly<Record<Timeframe, number>>,
    /**
     * An observation whose own timestamp is older than this relative to the
     * server evaluation clock is not fresh enough to act on. Signals are not
     * emitted from stale data; continuity state still updates.
     */
    maxStalenessMs: 30_000,
    /** USER RULE §10 — one-second target observation cadence. */
    targetIntervalMs: 1_000,
  },
} as const;

export type XauusdM1M5Spec = typeof SPEC;

/**
 * Stable hash of the rules. `JSON.stringify` over this object is
 * deterministic because the object literal's key order is fixed at compile
 * time and never built dynamically.
 */
export const SPEC_HASH = createHash('sha256').update(JSON.stringify(SPEC)).digest('hex').slice(0, 16);

/** Continuity gap budget for a timeframe, in ms. */
export function continuityGapBudgetMs(timeframe: Timeframe): number {
  return SPEC.observation.maxContinuityGapMs[timeframe];
}
