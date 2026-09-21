/**
 * research/confirmed-retest/spec — the FROZEN rule configuration for
 * `xauusd-h4-confirmed-retest-v1`.
 *
 * Every number the replay engine, paper simulation and statistics use is
 * read from `SPEC` below; nothing is tuned at run time. `SPEC_HASH` (SHA-256
 * of the canonical JSON of `SPEC`) is stamped on every output file and on
 * the watch-only state, so a run can always be tied to the exact rule set
 * that produced it. Changing any value here is a NEW version (new
 * `version` string), never an in-place edit — the prose specification and
 * rule provenance live in `XAUUSD_H4_CONFIRMED_RETEST_V1_SPEC.md`.
 *
 * All prices are integer broker price increments (XAUUSD: digits=2,
 * point=0.01, so 1 unit = $0.01 = one "cent"). No float equality anywhere.
 */
import { createHash } from 'node:crypto';

export const CONFIRMED_RETEST_STRATEGY_VERSION = 'xauusd-h4-confirmed-retest-v1';

export const SPEC = {
  version: CONFIRMED_RETEST_STRATEGY_VERSION,
  specRevision: 1,
  frozenOn: '2026-09-14',
  symbol: 'XAUUSD',
  executionMode: 'RESEARCH_REPLAY_AND_WATCH_ONLY__NO_ORDERS',

  data: {
    studyStartBeirutLocal: '2024-03-01T00:00:00',
    /** 2024-03-01 00:00 Asia/Beirut (UTC+2 on that date). */
    studyStartUtc: '2024-02-29T22:00:00.000Z',
    beirutTimezone: 'Asia/Beirut',
    /** Stored candle open_time values are MT5 broker-server wall-clock digits, not UTC (see spec doc §3.2 for the evidence). */
    storedCandleTimeBasis: 'BROKER_SERVER_WALL_CLOCK',
    brokerServerTimezone: 'EET',
    levelTimeframe: 'H4',
    eventTimeframe: 'M1',
    agreementTimeframe: 'D1',
    /** Finer broker-native series used only to fill/bridge M1 holes that are not confirmed closures. */
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
    /** Watch-only: an M1 bar is processed only once a bar at least this many minutes newer exists in storage. */
    watchSettleMarginMinutes: 3,
  },

  pivots: { leftBars: 2, rightBars: 2, strict: true },

  formation: {
    minPivotIndexDistance: 5,
    maxPivotIndexDistance: 120,
    rejectionMinCloseDistanceUnits: 1000,
    rejectionCloseWindow: 'BARS_AFTER_PIVOT_THROUGH_CONFIRMATION',
    bodyFilter: 'RESISTANCE_BODY_TOP_LE_LEVEL__SUPPORT_BODY_BOTTOM_GE_LEVEL__FIRST_PIVOT_THROUGH_SECOND_CONFIRMATION',
    partnerTieBreak: 'EARLIEST_VALID_FIRST_PIVOT',
  },

  lifecycle: {
    expiryH4BarsAfterActivation: 120,
    breakRule: 'COMPLETED_H4_CLOSE_STRICTLY_BEYOND_LEVEL',
    roleReversal: false,
    retiredKeyReactivation: 'ONLY_AFTER_SUBSEQUENT_CONFIRMED_BREAK_AND_TWO_NEW_PIVOTS_AFTER_THAT_BREAK',
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

  /** All ASSUMED — no historical ask, spread (M1 spread column is NULL for every row), commission, swap or slippage evidence exists. */
  costScenarios: [
    { id: 'IDEALIZED_GROSS', spreadUsdPerOz: 0, stopAndGapSlippageUsdPerOz: 0, commissionUsdPerLotRoundTrip: 0, swap: 'NONE', label: 'Idealized gross — NOT verified zero cost' },
    { id: 'ASSUMED_LOW', spreadUsdPerOz: 0.2, stopAndGapSlippageUsdPerOz: 0, commissionUsdPerLotRoundTrip: 0, swap: 'NONE', label: 'Assumed low cost' },
    { id: 'ASSUMED_BASE', spreadUsdPerOz: 0.35, stopAndGapSlippageUsdPerOz: 0.1, commissionUsdPerLotRoundTrip: 0, swap: 'CURRENT_BROKER_SWAP_AS_PROXY', label: 'Assumed base cost (current swap used only as a proxy, not as known history)' },
    { id: 'ASSUMED_STRESS', spreadUsdPerOz: 0.6, stopAndGapSlippageUsdPerOz: 0.25, commissionUsdPerLotRoundTrip: 7, swap: 'CURRENT_BROKER_SWAP_AS_PROXY', label: 'Assumed stress cost' },
  ],
  /** Broker symbol_metadata captured 2026-09-13 (points per lot per night, swap_mode=1 points, triple on Wednesday rollover). Proxy only. */
  swapProxy: { longPointsPerLotNight: -12.6, shortPointsPerLotNight: -4.6, pointUsd: 0.01, tripleRolloverWeekdayServer: 3 },

  statistics: {
    winRate: 'RESOLVED_W_OVER_W_PLUS_L',
    interval: 'WILSON_SCORE_95__ASSUMES_INDEPENDENCE',
    conservativeBounds: 'W_OVER_N_TO_N_MINUS_L_OVER_N',
    periods: ['FULL', 'CALENDAR_YEAR_BEIRUT', 'HALF_YEAR_BEIRUT'],
  },

  /**
   * Declared before any result was computed. Breakeven uses ASSUMED_BASE:
   * win nets $10 - $0.35, loss nets -($10 + $0.35 + $0.10 slippage), so
   * p* = 10.45 / 20.10. Swap is ignored in p* (it only lowers it further).
   */
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
