/**
 * research/first-touch — PURE RESEARCH CODE, gold (XAUUSD) "first-touch"
 * hypothesis study.
 *
 * This module is deliberately isolated from every live trading strategy:
 * it has no import from, and no wiring to, `src/trend-breakout/` or
 * `src/autonomous/` (the one explicitly-approved exception is the pure
 * `getBeirutWallClock`/`BEIRUT_TIMEZONE` utility re-used from
 * `src/trend-breakout/schedule.ts` — see `engine.ts`). Nothing here reads
 * or writes the database; every function in this module operates only on
 * data explicitly passed in by the caller (synthetic fixtures in this
 * repo's tests, and — not yet implemented — real historical data in a
 * future study run). See `scripts/first-touch-study.ts`, which is a
 * deliberately-not-runnable stub until a level-selection method is
 * approved.
 */

// ---------------------------------------------------------------------------
// Candles / ticks — the engine's only price-data inputs.
// ---------------------------------------------------------------------------

/**
 * One OHLC candle of any timeframe. `closeTime` is required (not derived
 * from `openTime` + an assumed timeframe duration) because the no-look-ahead
 * invariant on `Level.establishedAt` (see below) must compare against the
 * ACTUAL close of the last confirming candle, not a guessed one.
 */
export interface Candle {
  openTime: Date; // UTC
  closeTime: Date; // UTC
  open: number;
  high: number;
  low: number;
  close: number;
}

/** A single price update, used only to resolve same-candle races and to see through data gaps — never fabricated by the engine itself. */
export interface Tick {
  timestamp: Date; // UTC
  bid: number;
  ask: number;
}

// ---------------------------------------------------------------------------
// Data coverage gaps — injected by the caller (eventually sourced from the
// BackfillInterval ledger elsewhere in this project; here, just a plain param).
// ---------------------------------------------------------------------------

/**
 * CONFIRMED_CLOSURE: independently verified the broker session was
 * genuinely shut for this entire window — no trading could have happened,
 * so nothing (a hidden touch, a hidden TP/SL crossing) can be concealed
 * inside it. UNCONFIRMED: candles are simply missing and the cause is not
 * established — the session could have been open with real price movement
 * this dataset never captured, so anything that could hide inside it must
 * still be treated as unknown.
 *
 * A calendar date (ordinary weekend, a known holiday) and a last-observed
 * tick/candle immediately before the gap are corroborating evidence for
 * CONFIRMED_CLOSURE, never sufficient alone — the caller building these
 * (the study's data adapter, not this engine) is responsible for only
 * setting CONFIRMED_CLOSURE when it actually has that corroboration (e.g.
 * cross-checked against the BackfillInterval ledger's own EMPTY_CONFIRMED
 * status, or a closure pattern independently repeating across multiple
 * unrelated years). This engine trusts whatever `kind` it's given; it does
 * not re-derive confirmation itself.
 */
export type DataGapKind = 'CONFIRMED_CLOSURE' | 'UNCONFIRMED';

export interface DataGap {
  symbol: string;
  /** UTC, inclusive. */
  start: Date;
  /** UTC, exclusive. */
  end: Date;
  kind: DataGapKind;
}

// ---------------------------------------------------------------------------
// Levels.
// ---------------------------------------------------------------------------

export type LevelRole = 'SUPPORT' | 'RESISTANCE';

export interface LevelZone {
  lower: number;
  upper: number;
}

/**
 * Break/replacement history entries. Only ever appended via an explicit,
 * externally-supplied `ReplacementRule` (see below) — the engine has no
 * default rule of its own that invents these.
 */
export interface LevelHistoryEntry {
  type: 'BROKEN' | 'REPLACED';
  at: Date; // UTC
  ruleId: string;
  /** Only present for REPLACED entries. */
  replacementLevelId?: string;
  note?: string;
}

export interface Level {
  id: string;
  role: LevelRole;
  /**
   * Exactly one of `price` / `zone` is set (enforced by `createLevel`).
   * `price` is sugar for a zero-width zone.
   */
  price?: number;
  zone?: LevelZone;
  /** The H4 (or whatever timeframe) candles this level's detection method used to confirm it — kept verbatim, not just referenced by time, so the no-look-ahead check has no other data to trust. */
  sourceCandles: Candle[];
  /**
   * UTC. No-look-ahead invariant (enforced in `createLevel`, not just
   * documented): must be >= the close of the LAST `sourceCandles` entry.
   */
  establishedAt: Date;
  methodVersion: string;
  /** Populated only via `applyReplacementRules` — empty by default, meaning "never replaced." */
  history: LevelHistoryEntry[];
}

/**
 * How a level may be marked broken/replaced. Purely a caller-supplied
 * description of an external event — the engine never invents one on its
 * own (see engine.ts's `applyReplacementRules`, whose no-argument behavior
 * is a no-op / "never replace a level").
 */
export type ReplacementRule =
  | { type: 'BROKEN'; id: string; levelId: string; at: Date; note?: string }
  | { type: 'REPLACED'; id: string; levelId: string; at: Date; replacementLevelId: string; note?: string };

// ---------------------------------------------------------------------------
// First-touch detection.
// ---------------------------------------------------------------------------

/**
 * Result of scanning a level's entire monitored lifetime for its one,
 * ever, first-touch event.
 *  - TOUCHED: a confirmed first touch was found, with no data gap that could
 *    have concealed an earlier one.
 *  - NOT_TOUCHED: no touch found anywhere in the scanned/active range, and
 *    that range has no unresolved data gap either.
 *  - UNKNOWN: a data gap overlaps the range that would need to be clean for
 *    either of the above conclusions to be trustworthy. Never conflate this
 *    with NOT_TOUCHED — see FIRST_TOUCH_SPEC note in engine.ts.
 */
export type FirstTouchDetectionStatus = 'TOUCHED' | 'NOT_TOUCHED' | 'UNKNOWN';

export interface TouchDetectionResult {
  status: FirstTouchDetectionStatus;
  /** The candle whose body reached the level, when status === 'TOUCHED' (or the tainted candidate when 'UNKNOWN' — still surfaced for inspection, just not trustworthy as "first"). */
  touchCandle: Candle | null;
  /** Why scanning stopped where it did. */
  scanEndReason: 'END_OF_DATA' | 'LEVEL_DEACTIVATED';
  /** UTC — how far the scan actually progressed (candle close time, or establishedAt if nothing was scanned). */
  scannedThroughUtc: Date;
  /** The gap responsible for an UNKNOWN verdict, if any. */
  concealingGap: DataGap | null;
}

export type ApproachDirection = 'FROM_ABOVE' | 'FROM_BELOW' | 'UNKNOWN';

export type EntryDirection = 'BUY' | 'SELL';

/**
 * A level's confirmed first-touch, already resolved against the eligible
 * Beirut window and the role/approach -> entry-direction rule. Only ever
 * built from a `TouchDetectionResult` with status 'TOUCHED' — see
 * `buildTouchEvent` in engine.ts, which returns null for 'NOT_TOUCHED' /
 * 'UNKNOWN' rather than fabricate one.
 */
export interface TouchEvent {
  id: string;
  levelId: string;
  symbol: string;
  touchTimestampUtc: Date; // touchCandle.openTime
  touchCandle: Candle;
  approachDirection: ApproachDirection;
  /** null when the approach direction doesn't match either of the two defined role/approach combinations (see deriveEntryDirection) — no trading hypothesis is defined for that geometry, so no OutcomeEvent can be built from it. */
  entryDirection: EntryDirection | null;
  beirutHour: number; // 0-23, Asia/Beirut, at touchTimestampUtc
  beirutYear: number;
  withinEligibleWindow: boolean; // 04:00:00 inclusive - 12:00:00 exclusive, Asia/Beirut
  /** P — the level's nominal price used for TP/SL math (level.price, or the zone midpoint). */
  idealEntryPrice: number;
  /** True when price jumped over the level/zone entirely rather than trading through it (see engine.ts `wasGappedThrough`). */
  gappedThrough: boolean;
  /** = idealEntryPrice unless gappedThrough, in which case the actual reachable price (touch candle's open, or a covering tick's ask/bid when available). */
  executableEntryPrice: number;
}

// ---------------------------------------------------------------------------
// Outcome resolution.
// ---------------------------------------------------------------------------

export type OutcomeStatus = 'WIN' | 'LOSS' | 'UNRESOLVED' | 'AMBIGUOUS' | 'INDETERMINATE';

export interface OutcomeResolution {
  status: OutcomeStatus;
  entryPrice: number;
  tp: number;
  sl: number;
  resolvedAtUtc: Date | null;
  resolutionPrice: number | null;
  /** Worst move against the position observed before resolution (or before the frozen-end/indeterminate point) — always >= 0, plain price units. */
  adverseExcursion: number;
  holdingDurationMs: number | null;
  /** Present only for an AMBIGUOUS result — the single candle where both TP and SL were in range with no covering ticks. */
  raceCandleUtc: Date | null;
  /** Present only for an INDETERMINATE result — the data gap responsible. */
  concealingGap: DataGap | null;
}

/** Optional, caller-supplied — spread shifts the EXECUTABLE entry price only (buy-at-ask/sell-at-bid); never applied unless supplied. Raw price units (e.g. USD/oz for XAUUSD), not broker "points". */
export interface ExecutionCosts {
  spreadPriceUnits?: number;
}

export interface OutcomeEvent {
  id: string;
  touchEventId: string;
  levelId: string;
  symbol: string;
  entryDirection: EntryDirection;
  /** Structurally separate from `executable` per the spec — never conflate the two into one number. */
  idealized: OutcomeResolution;
  executable: OutcomeResolution;
  /** Convenience copy of TouchEvent fields the statistics layer buckets by. */
  beirutHour: number;
  beirutYear: number;
  role: LevelRole;
  /** The time window this event occupies a hypothetical position — used by the overlap flagger. Runs from touch to resolution, or to the frozen-end timestamp if unresolved/indeterminate. */
  activeWindow: { startUtc: Date; endUtc: Date };
}
