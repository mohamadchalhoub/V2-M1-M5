/**
 * research/confirmed-retest-v2/spec — the FROZEN rule configuration for
 * `xauusd-h4-confirmed-retest-v2`.
 *
 * v2 is a GPT-authorized research REVISION of v1, not a faithful re-
 * statement of the friend's discretionary method. It replaces v1's
 * "second pivot at the EXACT same price" formation rule with a RETEST of
 * the original pivot price (§ formation below) — the level price L itself
 * never moves. v1 is untouched, frozen, and lives in its own directory
 * (`src/research/confirmed-retest/`); this file changes nothing about it.
 *
 * Every number the replay engine, paper simulation and statistics use is
 * read from `SPEC` below; nothing is tuned at run time. `SPEC_HASH` (SHA-256
 * of the canonical JSON of `SPEC`) is stamped on every output file, so a run
 * can always be tied to the exact rule set that produced it. Changing any
 * value here is a NEW version, never an in-place edit.
 *
 * All prices are integer broker price increments (XAUUSD: digits=2,
 * point=0.01, so 1 unit = $0.01 = one "cent"). No float equality anywhere.
 */
import { createHash } from 'node:crypto';

export const CONFIRMED_RETEST_V2_STRATEGY_VERSION = 'xauusd-h4-confirmed-retest-v2';

export const SPEC = {
  version: CONFIRMED_RETEST_V2_STRATEGY_VERSION,
  specRevision: 1,
  frozenOn: '2026-09-15',
  symbol: 'XAUUSD',
  executionMode: 'RESEARCH_REPLAY_AND_WATCH_ONLY__NO_ORDERS',
  provenance: 'GPT_AUTHORIZED_RESEARCH_REVISION_OF_V1__NOT_A_CLAIM_ABOUT_THE_FRIEND_METHOD',
  baseline: 'xauusd-h4-confirmed-retest-v1',

  // Unchanged from v1 (see XAUUSD_H4_CONFIRMED_RETEST_V1_SPEC.md for the
  // evidence backing the timestamp basis, closure-evidence thresholds, etc).
  data: {
    studyStartBeirutLocal: '2024-03-01T00:00:00',
    studyStartUtc: '2024-02-29T22:00:00.000Z',
    beirutTimezone: 'Asia/Beirut',
    storedCandleTimeBasis: 'BROKER_SERVER_WALL_CLOCK',
    brokerServerTimezone: 'EET',
    levelTimeframe: 'H4',
    eventTimeframe: 'M1',
    agreementTimeframe: 'D1',
    gapFillTimeframe: 'M5',
    priceUnitsPerDollar: 100,
    closureEvidence: {
      minClosureMinutes: 30,
      reopenRecurrenceMinDates: 20,
      reopenToleranceMinutes: 5,
      closeRecurrenceMinDates: 2,
      closeToleranceMinutes: 2,
      noFullyContainedFinerBarTimeframes: ['M5', 'M15', 'M30', 'H1'],
    },
    watchSettleMarginMinutes: 3,
  },

  pivots: { leftBars: 2, rightBars: 2, strict: true },

  /**
   * v2's change from v1. L is the original strict-pivot extreme (unchanged
   * detection: 2 candles each side, candidate only after the 2nd following
   * candle closes). v1's "second pivot at the exact same price" is REPLACED
   * by a retest of L itself:
   *   - R is the earliest H4 bar with index in [pivotIndex+5, pivotIndex+120]
   *     (inclusive both ends), after the pivot is confirmed, satisfying:
   *       RESISTANCE: R.high >= L, R.open <= L, R.close <= L
   *       SUPPORT:    R.low  <= L, R.open >= L, R.close >= L
   *     R's own extreme need NOT equal L — only the touch condition above.
   *   - Between the pivot bar (exclusive) and confirmation (inclusive), every
   *     H4 body must respect L on the breakout side (equality at a body edge
   *     allowed) — identical filter to v1's bodiesRespectLevel, just applied
   *     incrementally as bars arrive rather than retroactively over a pair span.
   *   - Confirmation: R itself, or one of the next two COMPLETED H4 candles
   *     after R, must close >= $10 favorably from L. Activation happens at
   *     the FIRST such close (never retroactively dated to R). If none of
   *     R/R+1/R+2 qualifies, the candidate is retired — no search for a
   *     later retest continues for that pivot.
   *   - Same-price/same-role dedup and the key retirement/generation state
   *     machine (ACTIVE / RETIRED_UNTIL_BREAK / BROKEN, break re-opens for a
   *     NEW pivot only) are preserved unchanged from v1.
   */
  formation: {
    minRetestIndexDistance: 5,
    maxRetestIndexDistance: 120,
    rejectionMinCloseDistanceUnits: 1000,
    rejectionQualificationWindow: 'THE_TWO_BARS_CONFIRMING_THE_PIVOT',
    retestCondition: 'RESISTANCE_HIGH_GE_L_OPEN_AND_CLOSE_LE_L__SUPPORT_LOW_LE_L_OPEN_AND_CLOSE_GE_L',
    retestSelection: 'EARLIEST_QUALIFYING_BAR_IN_WINDOW__SINGLE_ATTEMPT',
    bodyFilter: 'RESISTANCE_BODY_TOP_LE_L__SUPPORT_BODY_BOTTOM_GE_L__PIVOT_EXCLUSIVE_THROUGH_CONFIRMATION_INCLUSIVE',
    confirmationCloseWindow: 'R_THEN_NEXT_TWO_COMPLETED_H4_CANDLES__FIRST_QUALIFYING_CLOSE_ACTIVATES__ELSE_RETIRE',
  },

  // Unchanged from v1.
  lifecycle: {
    expiryH4BarsAfterActivation: 120,
    breakRule: 'COMPLETED_H4_CLOSE_STRICTLY_BEYOND_LEVEL',
    roleReversal: false,
    retiredKeyReactivation: 'ONLY_AFTER_SUBSEQUENT_CONFIRMED_BREAK_AND_A_NEW_PIVOT_AFTER_THAT_BREAK',
    cancelEnteredEventOnLaterBreak: false,
    sameInstantOrder: 'D1_THEN_H4__BREAK_BEFORE_EXPIRY',
  },

  d1Agreement: {
    enabled: true,
    isEntryRequirement: false,
    lookbackCompletedD1Bars: 120,
    leftBars: 2,
    rightBars: 2,
    knownRule: 'D1_PIVOT_CONFIRMATION_CLOSE_LE_ACTIVATION_TIME',
  },

  session: {
    entryWindowStartSecondsBeirut: 4 * 3600,
    entryWindowEndSecondsBeirutExclusive: 12 * 3600,
    trackOutsideWindow: true,
    outsideWindowFirstReturnConsumesLevel: true,
  },

  touch: {
    rule: 'M1_WICK_INTERSECTION_STRICTLY_AFTER_ACTIVATION',
    gapCross: 'CONSUME_NO_ENTRY_LOGGED_SEPARATELY',
    directions: { SUPPORT: 'BUY', RESISTANCE: 'SELL' },
  },

  exits: {
    takeProfitDistanceUnits: 1000,
    stopLossDistanceUnits: 1000,
    holdingDeadline: null,
    trailingStop: false,
    breakeven: false,
    partialExit: false,
  },

  outcome: {
    entryCandle: 'STATE_REACHABILITY_OVER_ALL_OHLC_COMPATIBLE_CONTINUOUS_PATHS',
    sameBarBothBoundaries: 'AMBIGUOUS_NEVER_CHOOSE',
    ticks: 'ONLY_IF_COMPLETENESS_ATTESTED_BY_SOURCE_AND_OHLC_RECONCILED',
    unconfirmedGap: 'INDETERMINATE_UNLESS_M5_BRIDGE_EXCLUDES_ALL_RELEVANT_PRICES',
    endOfData: 'UNRESOLVED_UPDATED_WHEN_DATA_ARRIVES',
    gapOpenExit: 'IDEALIZED_STATUS_AT_NOMINAL_BOUNDARY__OBSERVED_OPEN_PRICE_RECORDED_FOR_COSTED_PNL',
  },

  paper: {
    maxOpenPositions: 1,
    volumeLots: 0.01,
    contractSizeOz: 100,
    selection: 'NEAREST_ACTIVE_RESISTANCE_GE_AND_SUPPORT_LE_PREVIOUS_BAR_CLOSE__FROZEN_PER_MINUTE',
    startingBalances: [
      { id: 'ASSUMED_1000_PRIMARY', usd: 1000, label: 'Assumed $1,000 starting balance (no demo equity snapshot exists) — PRIMARY' },
      {
        id: 'ASSUMED_10000_SENSITIVITY',
        usd: 10000,
        label:
          'Assumed $10,000 SENSITIVITY ONLY — declared before results because 0.01 lot x $10 stop = $10 = 1% of $1,000, ' +
          'which mechanically breaches the 0.5% stop-risk cap; not actual equity, not the primary result',
      },
    ],
    maxStopRiskPctOfEquity: 0.5,
    maxCombinedRiskPctOfEquity: 1.0,
    dailyLossBlockPct: 2.0,
    drawdownBlockPct: 5.0,
    drawdownBlockAutoReset: false,
    dailyLossDay: 'BEIRUT_CALENDAR_DAY',
    reenterSameMinuteAsExit: false,
    uncertainOutcomes: 'FORK_SCENARIO_BRANCHES__HALT_BRANCH_ON_INDETERMINATE',
    branchCap: 512,
  },

  shadowQuotes: {
    maxQuoteAgeSeconds: 5,
    maxSpreadUsd: 1.0,
    maxExecutableDistanceFromLevelUsd: 1.0,
  },

  costScenarios: [
    { id: 'IDEALIZED_GROSS', spreadUsdPerOz: 0, stopAndGapSlippageUsdPerOz: 0, commissionUsdPerLotRoundTrip: 0, swap: 'NONE', label: 'Idealized gross — NOT verified zero cost' },
    { id: 'ASSUMED_LOW', spreadUsdPerOz: 0.2, stopAndGapSlippageUsdPerOz: 0, commissionUsdPerLotRoundTrip: 0, swap: 'NONE', label: 'Assumed low cost' },
    { id: 'ASSUMED_BASE', spreadUsdPerOz: 0.35, stopAndGapSlippageUsdPerOz: 0.1, commissionUsdPerLotRoundTrip: 0, swap: 'CURRENT_BROKER_SWAP_AS_PROXY', label: 'Assumed base cost (current swap used only as a proxy, not as known history)' },
    { id: 'ASSUMED_STRESS', spreadUsdPerOz: 0.6, stopAndGapSlippageUsdPerOz: 0.25, commissionUsdPerLotRoundTrip: 7, swap: 'CURRENT_BROKER_SWAP_AS_PROXY', label: 'Assumed stress cost' },
  ],
  swapProxy: { longPointsPerLotNight: -12.6, shortPointsPerLotNight: -4.6, pointUsd: 0.01, tripleRolloverWeekdayServer: 3 },

  statistics: {
    winRate: 'RESOLVED_W_OVER_W_PLUS_L',
    interval: 'WILSON_SCORE_95__ASSUMES_INDEPENDENCE',
    conservativeBounds: 'W_OVER_N_TO_N_MINUS_L_OVER_N',
    periods: ['FULL', 'CALENDAR_YEAR_BEIRUT', 'HALF_YEAR_BEIRUT'],
  },

  conclusionRule: {
    minResolvedEvents: 30,
    breakevenWinRateAssumedBase: 10.45 / 20.1,
    order: [
      'INSUFFICIENT_EVIDENCE if W+L < minResolvedEvents',
      'LOSING_UNDER_TESTED_ASSUMPTIONS if Wilson upper bound of W/(W+L) < breakeven',
      'PROMISING_BUT_UNPROVEN if Wilson lower bound > breakeven AND W/N > breakeven AND worst-branch net P&L of the ASSUMED_10000_SENSITIVITY x ASSUMED_BASE paper run > 0',
      'otherwise INSUFFICIENT_EVIDENCE (inconclusive)',
    ],
  },

  // v2-specific: timestamp interpretation status (task instruction — do not
  // claim all historical timestamps are verified; see TIME_EVIDENCE.md).
  timeEvidence: {
    supportedInterpretation: 'EET_EEST_IANA_BROKER_SERVER_TIMEZONE__SUMMER_2026_LIVE_VERIFIED',
    unverifiedInterpretation: 'WINTER_EET_UTC_PLUS_2__CONFIRMED_ONLY_BY_HISTORICAL_BREAK_ARITHMETIC_NOT_A_LIVE_MEASUREMENT',
    sessionFilteredResultsAreAssumptionDependentInWinterMonths: true,
  },
} as const;

export type Spec = typeof SPEC;

/** Canonical JSON: object keys sorted recursively, so the hash is independent of key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export const SPEC_HASH = createHash('sha256').update(canonicalJson(SPEC)).digest('hex');
