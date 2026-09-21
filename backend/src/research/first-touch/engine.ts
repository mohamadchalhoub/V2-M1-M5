/**
 * research/first-touch/engine — pure functions only. No Prisma/DB import,
 * no NestJS decorator, no import from `src/trend-breakout/` or
 * `src/autonomous/` other than the one explicitly-approved read-only
 * utility below. Every function takes its price data as an explicit
 * argument and returns a plain value — safe to call twice with the same
 * input and get the same output (required for re-evaluating UNRESOLVED
 * events later with more data — see test scenario 7).
 *
 * The ONLY cross-module import in this file:
 */
import { getBeirutWallClock } from '../../trend-breakout/schedule';
import type {
  ApproachDirection,
  Candle,
  DataGap,
  EntryDirection,
  ExecutionCosts,
  Level,
  LevelHistoryEntry,
  LevelRole,
  LevelZone,
  OutcomeEvent,
  OutcomeResolution,
  ReplacementRule,
  Tick,
  TouchDetectionResult,
  TouchEvent,
} from './types';

// ---------------------------------------------------------------------------
// Eligible window — 04:00:00 inclusive .. 12:00:00 exclusive, Asia/Beirut.
// Deliberately NOT the trend-breakout strategy's own 03:00-12:00 window
// (`ENTRY_WINDOW_START_SECONDS` in schedule.ts) — this study has its own,
// different window per its spec, so it is defined here, independently,
// using the wall-clock hour/minute/second `getBeirutWallClock` returns
// (never a hand-rolled UTC offset).
// ---------------------------------------------------------------------------
const FIRST_TOUCH_WINDOW_START_SECONDS = 4 * 3600;
const FIRST_TOUCH_WINDOW_END_SECONDS = 12 * 3600;

export function isWithinFirstTouchWindow(utcInstant: Date): boolean {
  const { hour, minute, second } = getBeirutWallClock(utcInstant);
  const secondsOfDay = hour * 3600 + minute * 60 + second;
  return secondsOfDay >= FIRST_TOUCH_WINDOW_START_SECONDS && secondsOfDay < FIRST_TOUCH_WINDOW_END_SECONDS;
}

// ---------------------------------------------------------------------------
// Level construction — no-look-ahead invariant enforced here, as code, not
// just as a comment.
// ---------------------------------------------------------------------------

/** Thrown by `createLevel` when `establishedAt` predates the close of its own last confirming candle. Deliberately a REJECT, not a silent clamp — see the throw site for why. */
export class LookAheadViolationError extends Error {}

export interface CreateLevelInput {
  id: string;
  role: LevelRole;
  /** Exactly one of price/zone. */
  price?: number;
  zone?: LevelZone;
  sourceCandles: Candle[];
  establishedAt: Date;
  methodVersion: string;
}

export function createLevel(input: CreateLevelInput): Level {
  const hasPrice = input.price !== undefined;
  const hasZone = input.zone !== undefined;
  if (hasPrice === hasZone) {
    throw new Error(`Level ${input.id}: exactly one of price/zone must be supplied (got ${hasPrice ? 'price' : ''}${hasZone ? 'zone' : ''}${!hasPrice && !hasZone ? 'neither' : ''}).`);
  }
  if (input.sourceCandles.length === 0) {
    throw new Error(`Level ${input.id}: sourceCandles must be non-empty — a level must be confirmed by at least one candle.`);
  }

  const lastConfirmingCloseMs = input.sourceCandles.reduce(
    (max, c) => Math.max(max, c.closeTime.getTime()),
    -Infinity,
  );

  // No-look-ahead invariant: if the detection method needed candles closing
  // AFTER the pivot bar to confirm it, `establishedAt` must be no earlier
  // than the close of the LAST candle the method used. Rejecting (rather
  // than clamping establishedAt forward) is the deliberate choice here:
  // this engine exists to catch exactly this class of bug in whatever
  // level-selection method eventually gets approved, and a silent clamp
  // would hide a caller's off-by-one instead of surfacing it.
  if (input.establishedAt.getTime() < lastConfirmingCloseMs) {
    throw new LookAheadViolationError(
      `Level ${input.id}: establishedAt (${input.establishedAt.toISOString()}) predates the close of its own ` +
        `last confirming candle (${new Date(lastConfirmingCloseMs).toISOString()}) — look-ahead is not allowed.`,
    );
  }

  return {
    id: input.id,
    role: input.role,
    price: input.price,
    zone: input.zone,
    sourceCandles: input.sourceCandles,
    establishedAt: input.establishedAt,
    methodVersion: input.methodVersion,
    history: [],
  };
}

export function getLevelZone(level: Level): LevelZone {
  if (level.zone) return level.zone;
  return { lower: level.price as number, upper: level.price as number };
}

/** "P" — the ideal entry price used for TP/SL math: the level's own price, or its zone's midpoint. */
export function getLevelNominalPrice(level: Level): number {
  if (level.price !== undefined) return level.price;
  const zone = level.zone as LevelZone;
  return (zone.lower + zone.upper) / 2;
}

// ---------------------------------------------------------------------------
// Break/replacement — the engine has NO default rule of its own. Calling
// `applyReplacementRules(level)` with no rules (or none matching this
// level) returns the level unchanged, with empty history — i.e. "never
// replaced" is the default/no-argument behavior, as required.
// ---------------------------------------------------------------------------

export function applyReplacementRules(level: Level, rules: ReplacementRule[] = []): Level {
  const relevant = rules
    .filter((r) => r.levelId === level.id)
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const history: LevelHistoryEntry[] = relevant.map((r) =>
    r.type === 'BROKEN'
      ? { type: 'BROKEN', at: r.at, ruleId: r.id, note: r.note }
      : { type: 'REPLACED', at: r.at, ruleId: r.id, replacementLevelId: r.replacementLevelId, note: r.note },
  );

  return { ...level, history };
}

/** A level with no BROKEN/REPLACED history entry at or before `atUtc` is active. Both entry types end the level's identity — a "replaced" level is just as inactive for further touches of the OLD level as a "broken" one. */
export function isLevelActiveAt(level: Level, atUtc: Date): boolean {
  return !level.history.some((h) => h.at.getTime() <= atUtc.getTime());
}

// ---------------------------------------------------------------------------
// First-touch detection.
// ---------------------------------------------------------------------------

/**
 * Corrected 2026-09-13 — first-touch detection now uses the candle's WICK
 * (high/low), not its body. It was previously body-only, which produced a
 * real, user-caught discrepancy: XAUUSD SUPPORT 2326.17 on 2024-04-29, the
 * 04:00 UTC M1 candle (O=2332.03 H=2332.03 L=2324.11 C=2327.81) prints a low
 * of 2324.11 — through the level — but its body [2327.81, 2332.03] never
 * reaches 2326.17, so the old body-only check silently skipped it and
 * reported the 04:15 candle as "the" first touch instead, 15 minutes late.
 * That is inconsistent with two other facts already true elsewhere in this
 * pipeline: (1) `PROPOSED_SWING_DETECTOR` itself derives a level's PRICE
 * from a wick extreme (`pivot.high`/`pivot.low`), never a body extreme; (2)
 * `resolvePriceRace` below fills TP/SL off wicks specifically because "a
 * real TP/SL order fills the instant price reaches it, it does not wait for
 * a candle to close beyond it" — the identical logic applies to a resting
 * limit/stop entry order sitting at a support/resistance price: it fills
 * the instant the wick reaches it, not when some later candle's body does.
 * Body-only touch detection had no comparable justification in this
 * codebase; wick-based is the consistent choice across level construction,
 * entry, and exit.
 */
function wickRange(candle: Candle): { low: number; high: number } {
  return { low: candle.low, high: candle.high };
}

function wickIntersectsZone(candle: Candle, zone: LevelZone): boolean {
  const { low, high } = wickRange(candle);
  return high >= zone.lower && low <= zone.upper;
}

function findOverlappingGap(gaps: DataGap[], symbol: string, rangeStartUtc: Date, rangeEndUtc: Date): DataGap | null {
  const startMs = rangeStartUtc.getTime();
  const endMs = rangeEndUtc.getTime();
  return (
    gaps.find((g) => g.symbol === symbol && g.start.getTime() < endMs && g.end.getTime() > startMs) ?? null
  );
}

/**
 * Scans a level's ENTIRE monitored lifetime (never reset daily, never reset
 * at 04:00 Beirut) for its one, ever, first-touch event. `candles` should be
 * every candle available for this symbol from `level.establishedAt` onward,
 * in any order (sorted defensively here) — this function does not care
 * whether they fall inside or outside the eligible window; that check
 * happens later, in `buildTouchEvent`, because an outside-window touch
 * still consumes the level's one first-touch event.
 */
export function findFirstTouch(params: {
  level: Level;
  candles: Candle[];
  gaps: DataGap[];
  symbol: string;
}): TouchDetectionResult {
  const { level, gaps, symbol } = params;
  const zone = getLevelZone(level);
  const sourceOpenTimes = new Set(level.sourceCandles.map((c) => c.openTime.getTime()));

  const sorted = [...params.candles].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  // The level's own establishing/confirming candles are never counted as a
  // touch of the level they created, and nothing before establishedAt is
  // eligible either way (no-look-ahead).
  const eligible = sorted.filter(
    (c) => c.openTime.getTime() >= level.establishedAt.getTime() && !sourceOpenTimes.has(c.openTime.getTime()),
  );

  let candidate: Candle | null = null;
  let scanEndReason: 'END_OF_DATA' | 'LEVEL_DEACTIVATED' = 'END_OF_DATA';
  let scannedThroughUtc = level.establishedAt;

  for (const candle of eligible) {
    if (!isLevelActiveAt(level, candle.openTime)) {
      scanEndReason = 'LEVEL_DEACTIVATED';
      break;
    }
    if (wickIntersectsZone(candle, zone)) {
      candidate = candle;
      break;
    }
    scannedThroughUtc = candle.closeTime;
  }

  const rangeEnd = candidate ? candidate.openTime : scannedThroughUtc;
  const overlappingGap = findOverlappingGap(gaps, symbol, level.establishedAt, rangeEnd);
  // A CONFIRMED_CLOSURE gap conceals nothing — the session was verified
  // shut, so no touch could have happened invisibly inside it, and
  // scanning safely continues through the reopen candle on its own visible
  // data (that candle's body-intersects-zone check above already handles
  // a gapped-through reopen correctly: a body that skips the zone entirely
  // is correctly not a touch). Only an UNCONFIRMED gap — cause unknown,
  // session might have been open — must still force UNKNOWN.
  const concealingGap = overlappingGap && overlappingGap.kind === 'UNCONFIRMED' ? overlappingGap : null;

  if (concealingGap) {
    return { status: 'UNKNOWN', touchCandle: candidate, scanEndReason, scannedThroughUtc, concealingGap };
  }
  if (candidate) {
    return { status: 'TOUCHED', touchCandle: candidate, scanEndReason, scannedThroughUtc, concealingGap: null };
  }
  return { status: 'NOT_TOUCHED', touchCandle: null, scanEndReason, scannedThroughUtc, concealingGap: null };
}

/** Walks backward from just before `touchIndex` to find the approach direction — the first candle CLOSE strictly outside the zone. UNKNOWN if every earlier candle's close is already inside the zone (or there is none). */
function determineApproachDirection(sorted: Candle[], touchIndex: number, zone: LevelZone): ApproachDirection {
  for (let i = touchIndex - 1; i >= 0; i--) {
    const close = sorted[i].close;
    if (close > zone.upper) return 'FROM_ABOVE';
    if (close < zone.lower) return 'FROM_BELOW';
  }
  return 'UNKNOWN';
}

/**
 * Entry-direction rule, derived mechanically from (role, approach) — never
 * hardcoded per example. Only the two classical "bounce" geometries have a
 * defined hypothesis: support tested from above (buy the bounce) and
 * resistance tested from below (sell the bounce). The other two geometries
 * (a level breached from the "wrong" side) have no defined trade in this
 * study and correctly yield null — such a TouchEvent is still recorded
 * (the first-touch event itself is real), it simply produces no
 * OutcomeEvent.
 */
export function deriveEntryDirection(role: LevelRole, approach: ApproachDirection): EntryDirection | null {
  if (role === 'SUPPORT' && approach === 'FROM_ABOVE') return 'BUY';
  if (role === 'RESISTANCE' && approach === 'FROM_BELOW') return 'SELL';
  return null;
}

/** True when the touch candle's OPEN already lies beyond the far side of the zone from its approach direction — i.e. price jumped clean over the level rather than trading through it. */
function wasGappedThrough(candle: Candle, zone: LevelZone, approach: ApproachDirection): boolean {
  if (approach === 'FROM_ABOVE') return candle.open < zone.lower;
  if (approach === 'FROM_BELOW') return candle.open > zone.upper;
  return false; // can't reason about a gap without a known approach side
}

/**
 * Packages a confirmed ('TOUCHED') detection into a TouchEvent — resolving
 * the eligible-window check and the role/approach -> entry-direction rule.
 * Returns null for 'NOT_TOUCHED'/'UNKNOWN' rather than fabricate an event
 * from an unconfirmed touch.
 */
export function buildTouchEvent(params: {
  level: Level;
  detection: TouchDetectionResult;
  candles: Candle[];
  symbol: string;
}): TouchEvent | null {
  const { level, detection, symbol } = params;
  if (detection.status !== 'TOUCHED' || !detection.touchCandle) return null;
  const touchCandle = detection.touchCandle;

  const sorted = [...params.candles].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  const index = sorted.findIndex((c) => c.openTime.getTime() === touchCandle.openTime.getTime());
  const zone = getLevelZone(level);

  const approachDirection = determineApproachDirection(sorted, index, zone);
  const entryDirection = deriveEntryDirection(level.role, approachDirection);
  const wallClock = getBeirutWallClock(touchCandle.openTime);
  const withinEligibleWindow = isWithinFirstTouchWindow(touchCandle.openTime);
  const idealEntryPrice = getLevelNominalPrice(level);
  const gappedThrough = wasGappedThrough(touchCandle, zone, approachDirection);
  const executableEntryPrice = gappedThrough ? touchCandle.open : idealEntryPrice;

  return {
    id: `touch:${level.id}`,
    levelId: level.id,
    symbol,
    touchTimestampUtc: touchCandle.openTime,
    touchCandle,
    approachDirection,
    entryDirection,
    beirutHour: wallClock.hour,
    beirutYear: wallClock.year,
    withinEligibleWindow,
    idealEntryPrice,
    gappedThrough,
    executableEntryPrice,
  };
}

// ---------------------------------------------------------------------------
// Outcome resolution.
// ---------------------------------------------------------------------------

/** null = ticks covered the segment but showed no crossing; otherwise the resolved WIN/LOSS/AMBIGUOUS. */
function scanTicksForCrossing(
  ticks: Tick[],
  direction: EntryDirection,
  tp: number,
  sl: number,
): { status: 'WIN' | 'LOSS'; atUtc: Date; price: number } | null {
  const sorted = [...ticks].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  for (const tick of sorted) {
    // BUY exits trigger off bid (you'd sell to close), SELL exits off ask (you'd buy to close) — standard MT4/5 convention, matching this project's own broker model.
    const price = direction === 'BUY' ? tick.bid : tick.ask;
    const tpHit = direction === 'BUY' ? price >= tp : price <= tp;
    const slHit = direction === 'BUY' ? price <= sl : price >= sl;
    if (tpHit) return { status: 'WIN', atUtc: tick.timestamp, price };
    if (slHit) return { status: 'LOSS', atUtc: tick.timestamp, price };
  }
  return null;
}

function ticksWithin(ticks: Tick[], startUtc: Date, endUtc: Date): Tick[] {
  return ticks.filter((t) => t.timestamp.getTime() >= startUtc.getTime() && t.timestamp.getTime() < endUtc.getTime());
}

/**
 * "Ticks cover the candle" must mean genuinely verified, near-continuous
 * sequence coverage from `from` through either a found crossing or `to` —
 * not merely "at least one tick exists somewhere in this window." A
 * sparse/partial sample can conceal a crossing inside its own gaps just as
 * easily as OHLC can, and must never be trusted to override an
 * OHLC-established AMBIGUOUS result. MAX_TICK_GAP_MS is a disclosed,
 * adjustable heuristic, not a proof of coverage — this project has already
 * confirmed gold tick retrieval for its own demo account is unreliable
 * elsewhere in this repo, so this deliberately assumes sparse rather than
 * dense by default. Returns 'INSUFFICIENT' when coverage doesn't meet
 * that bar (caller must fall back to the OHLC inference), null when
 * coverage IS sufficient and genuinely shows no crossing, or the resolved
 * crossing itself.
 */
const MAX_TICK_GAP_MS = 5_000;

function verifiedTickCrossing(
  ticks: Tick[],
  from: Date,
  to: Date,
  direction: EntryDirection,
  tp: number,
  sl: number,
): { status: 'WIN' | 'LOSS'; atUtc: Date; price: number } | null | 'INSUFFICIENT' {
  const sorted = [...ticks].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  if (sorted.length === 0) return 'INSUFFICIENT';
  if (sorted[0].timestamp.getTime() - from.getTime() > MAX_TICK_GAP_MS) return 'INSUFFICIENT';

  let cursor = from.getTime();
  for (const t of sorted) {
    if (t.timestamp.getTime() - cursor > MAX_TICK_GAP_MS) return 'INSUFFICIENT';
    cursor = t.timestamp.getTime();
    const price = direction === 'BUY' ? t.bid : t.ask;
    const tpHit = direction === 'BUY' ? price >= tp : price <= tp;
    const slHit = direction === 'BUY' ? price <= sl : price >= sl;
    if (tpHit) return { status: 'WIN', atUtc: t.timestamp, price };
    if (slHit) return { status: 'LOSS', atUtc: t.timestamp, price };
  }
  // No crossing found — only trustworthy as genuine "verified clean" if
  // coverage also extends without a gap all the way to `to`.
  if (to.getTime() - cursor > MAX_TICK_GAP_MS) return 'INSUFFICIENT';
  return null;
}

export interface ResolvePriceRaceParams {
  direction: EntryDirection;
  entryPrice: number;
  /** The touch candle's open time — the race looks only at candles/ticks strictly AFTER this instant (the touch candle's own remaining path isn't modeled at intra-candle precision; a deliberate M1-granularity simplification). */
  entryTimeUtc: Date;
  /** Chronological candles (any granularity — M1 is what the study spec calls for) from entry onward. */
  candles: Candle[];
  /** Optional tick coverage, used only to resolve same-candle races and post-entry data gaps. */
  ticks: Tick[];
  gaps: DataGap[];
  symbol: string;
  frozenEndUtc: Date;
  /**
   * Only ever true on the EXECUTABLE call from `resolveOutcome` — see that
   * function. When a candle's own OPEN print already lies beyond a
   * boundary (a gap straight through it, whether or not a `DataGap`
   * precedes this candle), the realistic fill for a real order is the
   * actual print it gapped to, not the nominal TP/SL level it never
   * traded at. false (default) keeps the idealized convention: always
   * resolve at the exact nominal TP/SL price, mirroring how
   * `idealEntryPrice` is used on the entry side regardless of
   * `gappedThrough`.
   */
  realisticGapFills?: boolean;
}

/**
 * What a single candle's OHLC actually establishes about a TP/SL race,
 * given no tick coverage — used for the entry/touch candle (where the
 * "entry" happens mid-candle, at `touchPrice`, not at the candle's own
 * open) and, in principle, any other single candle once entry is behind it
 * (`touchPrice: null` — the candle's own open is already past entry).
 *
 * OHLC alone never records whether a candle's high or low happened first,
 * so this evaluates BOTH standard hypotheses independently — open then
 * high then low then close, and open then low then high then close — each
 * one locating the touch (the first point along that hypothesis' path that
 * reaches `touchPrice`, or immediately at the candle's own open when
 * `touchPrice` is null) and then checking only what happens AFTER that
 * point for a TP/SL crossing. A boundary already decided at the touch
 * instant itself (open beyond a level once entry is behind it — the
 * reopening/gap-through case) resolves identically under both hypotheses,
 * so that alone is never ambiguous. The two hypotheses are compared only
 * at the end: agreement is a real, determinate result (including "neither
 * boundary reached" — genuinely nothing to report, continue racing);
 * disagreement is AMBIGUOUS. Critically, disagreement can happen even
 * when only ONE boundary is ever in the candle's range at all — the
 * question is not "were both reachable" but "could that one boundary have
 * been reached before OR after the touch," which depends on where the
 * unreachable-from-OHLC-alone excursion to the opposite extreme falls.
 */
/**
 * Corrected 2026-09-13 — the previous version sampled exactly two
 * hypothetical intrabar paths (open->high->low->close and
 * open->low->high->close) and declared the candle "determinate" whenever
 * those two happened to agree. That is NOT proof every OHLC-compatible
 * path agrees: a real path may reverse direction more than once, and a
 * third, equally compatible path can disagree with both samples. Live
 * counterexample (BUY, touch 4340, TP 4350, SL 4330, O=4345 H=4352 L=4328
 * C=4348): both two-leg samples land on LOSS, yet
 * 4345 -> 4340 (entry) -> 4350 (TP) -> 4352 -> 4328 -> 4348 is equally
 * compatible with this OHLC row and resolves WIN. No finite sample of
 * paths can be exhaustive, so this function no longer samples paths at
 * all — it proves, directly from OHLC, which outcomes are REACHABLE by
 * ANY compatible path, via the following state-reachability argument
 * (stated here so the conditions below aren't "magic"):
 *
 * Normalize to a signed axis where the favorable direction (toward TP) is
 * always "larger" — this collapses BUY/SELL into one set of comparisons.
 * In this axis, sTouch always sits strictly between sSl and sTp (a
 * genuine mid-candle touch), and sOpen is always >= sTouch (this is a
 * structural fact of how the touch/approach direction is defined, not an
 * assumption). Call the extreme with the larger signed value
 * `favExtreme` (the real high for BUY, the real low for SELL) and the
 * other `advExtreme`.
 *
 * - `advExtreme` is UNREACHABLE before the touch: reaching it requires
 *   first crossing sTouch (it's on the opposite side), and the FIRST such
 *   crossing is, by definition, the touch itself. So advExtreme is
 *   necessarily visited by a post-touch continuation of the SAME leg the
 *   touch happens on, immediately available to any path — LOSS is
 *   therefore reachable whenever advExtreme is at/beyond SL (the
 *   continuation from touch to advExtreme necessarily passes through SL
 *   first, by the intermediate value theorem, if SL lies between them).
 * - `favExtreme` sits on the SAME side as the open. When there is real
 *   pre-touch room (sOpen > sTouch strictly), a path is always free to
 *   visit favExtreme entirely BEFORE the touch (a simple move from open
 *   further in its own direction, never needing to approach sTouch at
 *   all) — so WIN is reachable whenever favExtreme is at/beyond TP
 *   (route it immediately post-touch instead), and INDEPENDENTLY, a
 *   "nothing happens" continuation is reachable whenever favExtreme CAN
 *   be relegated pre-touch and the close itself never reaches TP (route
 *   post-touch as touch -> advExtreme -> close directly, skipping
 *   favExtreme entirely since it was already used pre-touch).
 * - When there is no pre-touch room (open == touch, or this candle is
 *   already fully after entry), favExtreme cannot be relegated — it will
 *   be visited post-touch in EVERY path, so "nothing happens" is only
 *   reachable when favExtreme itself never reaches TP.
 *
 * More than one reachable outcome (the same candle admits a compatible
 * path to each) is genuine ambiguity — not a sampling gap, a proof that
 * OHLC alone cannot decide it. Exactly one reachable outcome is a
 * genuine, provable determinate result.
 */
function resolveOhlcCandle(params: {
  open: number; high: number; low: number; close: number;
  direction: EntryDirection;
  touchPrice: number | null;
  tp: number; sl: number;
}): 'WIN' | 'LOSS' | 'NONE' | 'AMBIGUOUS' {
  const { open, high, low, close, direction, touchPrice, tp, sl } = params;
  const sign = direction === 'BUY' ? 1 : -1;
  const s = (v: number) => v * sign;
  const sTp = s(tp);
  const sSl = s(sl);
  const sOpen = s(open);
  const sClose = s(close);
  const sTouch = touchPrice == null ? sOpen : s(touchPrice);

  // Decisive at the touch instant itself — only possible when touchPrice
  // is null (this candle is already fully post-entry and its own open is
  // the reopening/gap print). A genuine mid-candle touch can never be
  // decisive here by construction (the touch price is always strictly
  // between sl and tp).
  if (sTouch >= sTp) return 'WIN';
  if (sTouch <= sSl) return 'LOSS';

  const sFavExtreme = Math.max(s(high), s(low));
  const sAdvExtreme = Math.min(s(high), s(low));
  const hasPreTouchRoom = touchPrice != null && sOpen > sTouch;

  const winReachable = sFavExtreme >= sTp;
  const lossReachable = sAdvExtreme <= sSl;
  // Only relevant/checked when loss is NOT reachable — see docstring: when
  // advExtreme is at/beyond SL, every path's mandatory post-touch visit to
  // it crosses SL, so "nothing happens" cannot survive to the close.
  const noneCap = hasPreTouchRoom ? sClose : sFavExtreme;
  const noneReachable = !lossReachable && noneCap < sTp;

  const reachable = [winReachable, lossReachable, noneReachable].filter(Boolean).length;
  if (reachable > 1) return 'AMBIGUOUS';
  if (winReachable) return 'WIN';
  if (lossReachable) return 'LOSS';
  return 'NONE';
}

/**
 * The core TP/SL race, reused for both the idealized and executable paths
 * (each with its own entry price -> its own TP/SL, and the executable call
 * additionally passing `realisticGapFills: true`). Uses candle WICKS
 * (high/low), not bodies — this is a stop/limit order fill model (a real
 * TP/SL order fills the instant price reaches it, it does not wait for a
 * candle to close beyond it). First-touch detection above now uses the same
 * wick-based rule, for the same reason — see `wickIntersectsZone`'s
 * docstring.
 */
export function resolvePriceRace(params: ResolvePriceRaceParams): OutcomeResolution {
  const { direction, entryPrice, entryTimeUtc, ticks, symbol, frozenEndUtc, realisticGapFills = false } = params;
  const tp = direction === 'BUY' ? entryPrice + 10 : entryPrice - 10;
  const sl = direction === 'BUY' ? entryPrice - 10 : entryPrice + 10;

  const relevantGaps = [...params.gaps]
    .filter((g) => g.symbol === symbol)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const allSorted = [...params.candles].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  const entryCandle = allSorted.find((c) => c.openTime.getTime() === entryTimeUtc.getTime()) ?? null;
  const sortedCandles = allSorted.filter(
    (c) => c.openTime.getTime() > entryTimeUtc.getTime() && c.openTime.getTime() < frozenEndUtc.getTime(),
  );

  let worstAdverse = 0;
  const trackAdverse = (price: number) => {
    const adverse = direction === 'BUY' ? entryPrice - price : price - entryPrice;
    if (adverse > worstAdverse) worstAdverse = adverse;
  };

  const finalize = (
    status: 'WIN' | 'LOSS',
    atUtc: Date,
    price: number,
  ): OutcomeResolution => ({
    status,
    entryPrice,
    tp,
    sl,
    resolvedAtUtc: atUtc,
    resolutionPrice: price,
    adverseExcursion: worstAdverse,
    holdingDurationMs: atUtc.getTime() - entryTimeUtc.getTime(),
    raceCandleUtc: null,
    concealingGap: null,
  });

  const indeterminate = (gap: DataGap): OutcomeResolution => ({
    status: 'INDETERMINATE',
    entryPrice,
    tp,
    sl,
    resolvedAtUtc: null,
    resolutionPrice: null,
    adverseExcursion: worstAdverse,
    holdingDurationMs: null,
    raceCandleUtc: null,
    concealingGap: gap,
  });

  const ambiguous = (raceCandleUtc: Date): OutcomeResolution => ({
    status: 'AMBIGUOUS',
    entryPrice,
    tp,
    sl,
    resolvedAtUtc: null,
    resolutionPrice: null,
    adverseExcursion: worstAdverse,
    holdingDurationMs: null,
    raceCandleUtc,
    concealingGap: null,
  });

  /**
   * Attempts to cross a [start, end) window. Returns 'resolved' (already
   * finalized into `outcome`), 'clean' (no crossing could have happened —
   * caller should advance past it and let the reopen candle's own
   * high/low be checked normally by the main per-candle loop below), or
   * 'unresolved' (cause of the gap is not established — caller must treat
   * as INDETERMINATE rather than guess).
   *
   * A CONFIRMED_CLOSURE window is 'clean' unconditionally, with no tick
   * requirement: the session was verified shut, so by definition no price
   * ever traded there to cross anything — there is no "path" through a
   * closure to model, only a single discrete jump from the last
   * pre-closure price to the reopen candle's own open, and that reopen
   * candle is then checked exactly like any other candle by the main loop
   * below — OPEN first (resolves immediately if the reopen print alone
   * already lies beyond a boundary), then high/low, then AMBIGUOUS only if
   * the open was neutral and the range still straddles both. An
   * UNCONFIRMED window still requires tick coverage to rule out a hidden
   * crossing, exactly as before.
   */
  const tryGap = (gap: DataGap, windowEnd: Date): { kind: 'resolved'; outcome: OutcomeResolution } | { kind: 'clean' } | { kind: 'unresolved' } => {
    if (gap.kind === 'CONFIRMED_CLOSURE') return { kind: 'clean' };
    const coveringTicks = ticksWithin(ticks, gap.start, gap.end.getTime() < windowEnd.getTime() ? gap.end : windowEnd);
    if (coveringTicks.length === 0) return { kind: 'unresolved' };
    const crossing = scanTicksForCrossing(coveringTicks, direction, tp, sl);
    for (const t of coveringTicks) trackAdverse(direction === 'BUY' ? t.bid : t.ask);
    if (crossing) return { kind: 'resolved', outcome: finalize(crossing.status, crossing.atUtc, crossing.price) };
    return { kind: 'clean' };
  };

  // Process the entry/touch candle explicitly — the hypothetical entry
  // happens the instant price first reaches `entryPrice`, not at this
  // candle's close, so a TP or SL reached later in the SAME minute must
  // not be silently skipped just because `sortedCandles` above only
  // starts strictly after this candle. See resolveOhlcCandle's own
  // docstring for how OHLC-only ambiguity is actually decided here,
  // rather than assumed whenever both boundaries merely exist somewhere
  // in the candle.
  if (entryCandle && entryCandle.openTime.getTime() < frozenEndUtc.getTime()) {
    // entryTimeUtc === entryCandle.openTime always (that's how entryCandle
    // was found above), so ticksWithin's own [openTime, closeTime) bound
    // already excludes anything before the touch — no separate filter needed.
    const entryCandleTicks = ticksWithin(ticks, entryCandle.openTime, entryCandle.closeTime);
    for (const t of entryCandleTicks) trackAdverse(direction === 'BUY' ? t.bid : t.ask);
    const verified = verifiedTickCrossing(entryCandleTicks, entryCandle.openTime, entryCandle.closeTime, direction, tp, sl);
    if (verified !== 'INSUFFICIENT') {
      // A verified, sufficiently-covered tick sequence establishes the
      // actual order directly — no inference needed, ambiguous or not.
      if (verified) return finalize(verified.status, verified.atUtc, verified.price);
      // Genuinely verified clean coverage, no crossing — fall through and keep racing.
    } else {
      // No ticks, or too sparse to trust — a partial sample must never
      // silently override what OHLC alone can or cannot establish.
      const ohlcResult = resolveOhlcCandle({
        open: entryCandle.open, high: entryCandle.high, low: entryCandle.low, close: entryCandle.close,
        direction, touchPrice: entryPrice, tp, sl,
      });
      if (ohlcResult === 'WIN') return finalize('WIN', entryCandle.openTime, tp);
      if (ohlcResult === 'LOSS') return finalize('LOSS', entryCandle.openTime, sl);
      if (ohlcResult === 'AMBIGUOUS') return ambiguous(entryCandle.openTime);
      // 'NONE' — OHLC establishes neither boundary was reached after entry; fall through and keep racing.
    }
  }

  // The entry candle (if present and not returned above) is now fully
  // accounted for — advance the gap-scan cursor past its own close so the
  // main loop below never re-examines the span the entry candle itself
  // already covers.
  let cursor = entryCandle ? entryCandle.closeTime : entryTimeUtc;

  for (const candle of sortedCandles) {
    const gap = findOverlappingGap(relevantGaps, symbol, cursor, candle.openTime);
    if (gap) {
      const result = tryGap(gap, candle.openTime);
      if (result.kind === 'resolved') return result.outcome;
      if (result.kind === 'unresolved') return indeterminate(gap);
      // 'clean' — ticks covering the gap showed no crossing; fall through and keep scanning this candle normally.
    }

    trackAdverse(direction === 'BUY' ? candle.low : candle.high);

    // Reopening/gap-through fix: the candle's own OPEN print is the first
    // price this candle actually offers — check it BEFORE the rest of the
    // candle's high/low. If the open alone already lies beyond one
    // boundary, that boundary was necessarily reached at-or-before this
    // candle even opened, so the order is already known and must not be
    // reclassified as ambiguous just because the candle's later range also
    // reaches the opposite boundary (open cannot be beyond both at once —
    // tp and sl sit on opposite sides of entryPrice by construction, so
    // this check alone never itself needs disambiguating). Applies to any
    // candle whose open gaps past a boundary, not only a reopen after a
    // DataGap — a sudden real print can do the same thing.
    const openBeyondTp = direction === 'BUY' ? candle.open >= tp : candle.open <= tp;
    const openBeyondSl = direction === 'BUY' ? candle.open <= sl : candle.open >= sl;
    if (openBeyondTp || openBeyondSl) {
      const status = openBeyondTp ? 'WIN' : 'LOSS';
      const nominalPrice = openBeyondTp ? tp : sl;
      // Idealized always resolves at the exact nominal level (unchanged
      // convention, matching idealEntryPrice on the entry side).
      // Executable reflects the real print it gapped to — never a price
      // that was never actually traded.
      const price = realisticGapFills ? candle.open : nominalPrice;
      return finalize(status, candle.openTime, price);
    }

    const tpHit = direction === 'BUY' ? candle.high >= tp : candle.low <= tp;
    const slHit = direction === 'BUY' ? candle.low <= sl : candle.high >= sl;

    if (tpHit && slHit) {
      const candleTicks = ticksWithin(ticks, candle.openTime, candle.closeTime);
      if (candleTicks.length > 0) {
        const crossing = scanTicksForCrossing(candleTicks, direction, tp, sl);
        if (crossing) return finalize(crossing.status, crossing.atUtc, crossing.price);
      }
      // Both boundaries in range within one candle and no tick data (or ticks inconclusive) resolves the order — never guess.
      return ambiguous(candle.openTime);
    }
    if (tpHit) return finalize('WIN', candle.openTime, tp);
    if (slHit) return finalize('LOSS', candle.openTime, sl);

    cursor = candle.closeTime;
  }

  // Ran out of candles before a resolution. Check one trailing gap between
  // the last clean point and the frozen-end timestamp.
  const trailingGap = findOverlappingGap(relevantGaps, symbol, cursor, frozenEndUtc);
  if (trailingGap) {
    const result = tryGap(trailingGap, frozenEndUtc);
    if (result.kind === 'resolved') return result.outcome;
    if (result.kind === 'unresolved') return indeterminate(trailingGap);
    // 'clean' falls through to UNRESOLVED below — ticks proved the gap itself was quiet, but no more candle data exists yet.
  }

  return {
    status: 'UNRESOLVED',
    entryPrice,
    tp,
    sl,
    resolvedAtUtc: null,
    resolutionPrice: null,
    adverseExcursion: worstAdverse,
    holdingDurationMs: null,
    raceCandleUtc: null,
    concealingGap: null,
  };
}

/**
 * Builds the full OutcomeEvent for a touch event — idealized and executable
 * paths kept structurally separate, per the spec. Returns null when the
 * touch isn't a valid entry (outside the eligible window, or an atypical
 * approach direction with no defined entryDirection) — no OutcomeEvent
 * exists for those; the TouchEvent itself still stands as the level's
 * (consumed) first-touch record.
 */
export function resolveOutcome(params: {
  touchEvent: TouchEvent;
  level: Level;
  candles: Candle[];
  ticks?: Tick[];
  gaps: DataGap[];
  symbol: string;
  frozenEndUtc: Date;
  executionCosts?: ExecutionCosts;
}): OutcomeEvent | null {
  const { touchEvent, level, candles, gaps, symbol, frozenEndUtc } = params;
  const ticks = params.ticks ?? [];
  if (!touchEvent.withinEligibleWindow || !touchEvent.entryDirection) return null;
  const direction = touchEvent.entryDirection;

  const idealized = resolvePriceRace({
    direction,
    entryPrice: touchEvent.idealEntryPrice,
    entryTimeUtc: touchEvent.touchTimestampUtc,
    candles,
    ticks,
    gaps,
    symbol,
    frozenEndUtc,
  });

  const spread = params.executionCosts?.spreadPriceUnits ?? 0;
  const executableEntryPrice =
    direction === 'BUY' ? touchEvent.executableEntryPrice + spread : touchEvent.executableEntryPrice - spread;

  const executable = resolvePriceRace({
    direction,
    entryPrice: executableEntryPrice,
    entryTimeUtc: touchEvent.touchTimestampUtc,
    candles,
    ticks,
    gaps,
    symbol,
    frozenEndUtc,
    realisticGapFills: true,
  });

  const idealEnd = idealized.resolvedAtUtc ?? frozenEndUtc;
  const executableEnd = executable.resolvedAtUtc ?? frozenEndUtc;

  return {
    id: `outcome:${touchEvent.id}`,
    touchEventId: touchEvent.id,
    levelId: touchEvent.levelId,
    symbol,
    entryDirection: direction,
    idealized,
    executable,
    beirutHour: touchEvent.beirutHour,
    beirutYear: touchEvent.beirutYear,
    role: level.role,
    activeWindow: {
      startUtc: touchEvent.touchTimestampUtc,
      endUtc: idealEnd.getTime() > executableEnd.getTime() ? idealEnd : executableEnd,
    },
  };
}
