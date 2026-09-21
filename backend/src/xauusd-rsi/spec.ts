/**
 * Machine-readable half of XAUUSD_M1_RSI_RETEST_EXTREMES_V1_SPEC.md.
 *
 * Every number the strategy's decisions depend on lives here and nowhere
 * else, so there is exactly one place to read the rules from and exactly
 * one thing to hash. `SPEC_HASH` is derived from the frozen object below;
 * a persisted pattern-state file carries the hash it was written under and
 * is REFUSED (never silently migrated) if the rules have since changed —
 * the same posture `research/confirmed-retest-v2/spec.ts` established, for
 * the same reason: mixing two rule versions inside one state file produces
 * decisions no audit can later explain.
 *
 * Nothing here is tunable at runtime. These are not `.env` values on
 * purpose: the user's rules are not operator-adjustable, and an entry
 * threshold that could be edited without a spec re-freeze would make the
 * hash meaningless.
 */
import { createHash } from 'node:crypto';

export const XAUUSD_RSI_STRATEGY_VERSION = 'xauusd-m1-rsi-retest-extremes-v1';

export const SPEC = {
  strategyVersion: XAUUSD_RSI_STRATEGY_VERSION,
  symbol: 'XAUUSD',
  timeframe: 'M1',

  rsi: {
    /** USER RULE — "RSI period: 5, as displayed in the screenshots." */
    period: 5,
    /**
     * VERIFIED against the terminal (spec §8.1), no longer an assumption:
     * an MQL5 script exported `iRSI(XAUUSD, PERIOD_M1, 5, PRICE_CLOSE)` and
     * this implementation reproduces it to 5e-11 across 5,000 live M1 bars.
     */
    appliedPrice: 'CLOSE' as const,
    /** Wilder smoothing, matching MT5's RSI implementation. */
    smoothing: 'WILDER' as const,
    /**
     * Closed M1 bars required beyond the `period` seed before any signal
     * may be emitted (spec §8.5). Wilder's recursive average carries its
     * seeding transient for many multiples of the period; 250 bars is a
     * deliberately generous margin, not a tuned value.
     */
    warmupBars: 250,
  },

  thresholds: {
    /** USER RULE — "Sell 2 | 91". Entering above this arms the SELL peak-retest setup. */
    sell2: 91,
    /** USER RULE — "Sell 1 | 82". Falling below this invalidates an armed SELL pattern. */
    sell1: 82,
    /** USER RULE — "Buy 1 is explicitly 18, replacing the 14 shown in the images." */
    buy1: 18,
    /** USER RULE — "Buy 2 = 8.9 is taken from the screenshot". */
    buy2: 8.9,

    /**
     * USER RULE — extreme SELL is 98.5, used consistently for triggering,
     * rearming, configuration, the dashboard, the specification and the
     * tests. An earlier revision fired at 98 because the user's original
     * text stated 98.5 as the threshold while its crossing and rearm
     * examples said 98; the user has since confirmed those 98 references
     * were stale, so a single value is now used everywhere.
     */
    extremeSellCross: 98.5,

    /** USER RULE — extreme BUY is 1.5, likewise used everywhere. */
    extremeBuyCross: 1.5,
  },

  /**
   * USER RULE — the two independent execution slots.
   *
   * The four setups group into two rule FAMILIES, and each family may hold
   * at most one active, pending or uncertain entry of its own. A retest
   * position and an extreme position may therefore be open at the same
   * time, giving this strategy a maximum concurrency of two.
   *
   * This is deliberately NOT one slot per directional setup: SELL and BUY
   * retests share the RETEST slot, and both extremes share the EXTREME slot.
   */
  ruleFamilies: {
    RETEST: {
      setups: ['SELL_PEAK_RETEST', 'BUY_TROUGH_RETEST'] as const,
      maxConcurrentEntries: 1,
    },
    EXTREME: {
      setups: ['EXTREME_SELL', 'EXTREME_BUY'] as const,
      maxConcurrentEntries: 1,
    },
  },

  brackets: {
    /**
     * USER RULE — "TP distance: 5.00 USD in quoted gold price" and the same
     * for SL. A gold-PRICE distance, not broker points and not a promised
     * account-currency amount.
     */
    takeProfitUsd: 5,
    stopLossUsd: 5,
  },

  schedule: {
    timeZone: 'Asia/Beirut',
    /** USER RULE §5.1 — daily entry pause, 23:30 inclusive to 01:00 exclusive. */
    dailyPauseStartSecondsBeirut: 23 * 3600 + 30 * 60,
    dailyPauseEndSecondsBeirutExclusive: 1 * 3600,
    /** USER RULE §5.2 — Friday entries allowed strictly before 23:00:00. */
    fridayEntryCutoffSecondsBeirut: 23 * 3600,
    /** USER RULE §5.3 — owned exposure must be flat before Friday 23:30. */
    fridayClosureDeadlineSecondsBeirut: 23 * 3600 + 30 * 60,
    /**
     * IMPLEMENTATION ASSUMPTION (spec §9.3) — liquidation starts at the
     * 23:00 cutoff rather than waiting for 23:29, so there is half an hour
     * of retry/reconciliation headroom before the deadline.
     */
    fridayLiquidationStartSecondsBeirut: 23 * 3600,
  },

  observation: {
    /**
     * IMPLEMENTATION ASSUMPTION (spec §8.6). A gap longer than this between
     * two consecutive accepted observations means the engine cannot honestly
     * claim to know what RSI did in between, so pattern state is reset
     * rather than carried across. 90s spans one full M1 bar plus margin.
     */
    maxContinuityGapMs: 90_000,
    /**
     * An observation whose own timestamp is older than this relative to
     * wall clock is not fresh enough to act on. Signals are not emitted
     * from stale data; state still updates so continuity is tracked.
     */
    maxStalenessMs: 30_000,
  },
} as const;

export type XauusdRsiSpec = typeof SPEC;

/**
 * Stable hash of the rules. `JSON.stringify` over this object is
 * deterministic because the object literal's key order is fixed at compile
 * time and never built dynamically.
 */
export const SPEC_HASH = createHash('sha256').update(JSON.stringify(SPEC)).digest('hex').slice(0, 16);
