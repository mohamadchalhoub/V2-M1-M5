/**
 * The pure $0.50 continuous trailing stop-and-reverse decision core.
 *
 * Everything here is a pure function over an explicit state and an explicit
 * quote — no database, no broker, no clock read internally. That is what
 * lets every invariant in the spec (retracement never loosens a reversal
 * level, a gap through a trigger still fires, the fixed initial reference
 * never trails) be proven by a test that constructs a state and a quote and
 * asserts on the result, with nothing else in the picture.
 *
 * ## Why plain inclusive comparisons are enough for "crossing"
 *
 * The old RSI strategy needed edge-detection (`previous < threshold AND
 * current >= threshold`) because RSI can sit on one side of 91 for many
 * ticks in a row, and re-arming had to happen exactly once per crossing. This
 * state machine has no such repetition risk: the instant a trigger condition
 * becomes true, the state transitions (WAIT_INITIAL_DIRECTION -> ACTIVE_*, or
 * ACTIVE_BUY -> ACTIVE_SELL), and the very next evaluation is already judged
 * against a brand new trigger level computed from the new state. So a plain
 * `price >= level` / `price <= level` is both correct and automatically
 * gap-safe: it does not matter whether price approached the level tick by
 * tick or jumped straight past it in one tick, the inequality is satisfied
 * either way, exactly as the spec's "crossing counts" examples require.
 *
 * ## Bid/Ask
 *
 * BUY opens at ASK and exits (closes) at BID; SELL opens at BID and exits at
 * ASK. The session reference is the MID of bid/ask at capture, a fair anchor
 * that does not itself favour either direction. Each trigger and each
 * trailing extreme is evaluated against the side that direction would
 * actually transact on, documented per function below.
 */
import { SPEC, type SarDirection } from './spec';

export type SarState =
  | 'WAIT_MARKET_OPEN'
  | 'WAIT_INITIAL_DIRECTION'
  | 'ACTIVE_BUY'
  | 'ACTIVE_SELL'
  | 'REVERSAL_UNKNOWN'
  | 'DAILY_CLOSED';

export interface SarQuote {
  readonly bid: number;
  readonly ask: number;
}

/**
 * The full persisted shape of one session's state. Every field an operator
 * or a restart needs to reconstruct exactly where things stood.
 */
export interface SarSessionState {
  readonly sessionDate: string;
  readonly state: SarState;

  /** Fixed at capture; never recomputed while WAIT_INITIAL_DIRECTION. */
  readonly sessionReference: number | null;
  readonly initialBuyTrigger: number | null;
  readonly initialSellTrigger: number | null;
  readonly referenceCapturedAtMs: number | null;

  /** Identifies one BUY-or-SELL holding period; changes on every reversal. */
  readonly cycleId: string | null;
  readonly direction: SarDirection | null;
  readonly entryFillPrice: number | null;
  /** The BUY cycle's trailing high (bid) or the SELL cycle's trailing low (ask). */
  readonly extremeSinceEntry: number | null;
  readonly reversalLevel: number | null;

  readonly brokerTicket: string | null;
}

export function initialSessionState(sessionDate: string): SarSessionState {
  return {
    sessionDate,
    state: 'WAIT_MARKET_OPEN',
    sessionReference: null,
    initialBuyTrigger: null,
    initialSellTrigger: null,
    referenceCapturedAtMs: null,
    cycleId: null,
    direction: null,
    entryFillPrice: null,
    extremeSinceEntry: null,
    reversalLevel: null,
    brokerTicket: null,
  };
}

/**
 * Captures the fixed session reference the moment the market is first
 * genuinely tradable at/after 01:00. Mid of bid/ask, so the reference itself
 * does not favour BUY or SELL.
 */
export function captureSessionReference(
  session: SarSessionState,
  quote: SarQuote,
  nowMs: number,
  reversalDistanceUsd: number = SPEC.reversalDistanceUsd,
): SarSessionState {
  const reference = (quote.bid + quote.ask) / 2;
  return {
    ...session,
    state: 'WAIT_INITIAL_DIRECTION',
    sessionReference: reference,
    initialBuyTrigger: reference + reversalDistanceUsd,
    initialSellTrigger: reference - reversalDistanceUsd,
    referenceCapturedAtMs: nowMs,
  };
}

export interface InitialDirectionOutcome {
  readonly direction: SarDirection | null;
  /** The actual price the direction would fill at — never the logical trigger. */
  readonly fillPrice: number | null;
}

/**
 * Which boundary is reached/crossed first, judged against the side each
 * direction actually fills at: BUY against the ask, SELL against the bid.
 *
 * If both fire on the same evaluation — only possible from a quote gap wide
 * enough to jump clean through both triggers in one tick, effectively
 * unreachable at a $0.50 distance on XAUUSD — BUY is the deterministic
 * tiebreak. This never happens in the test suite except to prove the
 * tiebreak is deterministic at all.
 */
export function evaluateInitialDirection(session: SarSessionState, quote: SarQuote): InitialDirectionOutcome {
  if (session.state !== 'WAIT_INITIAL_DIRECTION') return { direction: null, fillPrice: null };
  const buyFires = session.initialBuyTrigger !== null && quote.ask >= session.initialBuyTrigger;
  const sellFires = session.initialSellTrigger !== null && quote.bid <= session.initialSellTrigger;
  if (buyFires) return { direction: 'BUY', fillPrice: quote.ask };
  if (sellFires) return { direction: 'SELL', fillPrice: quote.bid };
  return { direction: null, fillPrice: null };
}

/** Opens the first cycle once a broker fill is confirmed (never before). */
export function openInitialCycle(
  session: SarSessionState,
  direction: SarDirection,
  confirmedFillPrice: number,
  cycleId: string,
  brokerTicket: string,
): SarSessionState {
  return {
    ...session,
    state: direction === 'BUY' ? 'ACTIVE_BUY' : 'ACTIVE_SELL',
    cycleId,
    direction,
    entryFillPrice: confirmedFillPrice,
    extremeSinceEntry: confirmedFillPrice,
    reversalLevel:
      direction === 'BUY'
        ? confirmedFillPrice - SPEC.reversalDistanceUsd
        : confirmedFillPrice + SPEC.reversalDistanceUsd,
    brokerTicket,
  };
}

export interface TrailingUpdate {
  readonly extremeSinceEntry: number;
  readonly reversalLevel: number;
  /** True the instant the reversal level is reached or crossed this tick. */
  readonly reversalTriggered: boolean;
}

/**
 * BUY: `highestPriceSinceEntry` tracks the trailing high of BID (what the
 * position would actually close at). It only ever increases. The SELL
 * reversal level trails it by the reversal distance and likewise only ever
 * increases — a retracement can never loosen it, because the level is
 * recomputed from the extreme, and the extreme itself never decreases.
 */
export function updateBuyTrailing(
  session: SarSessionState,
  quote: SarQuote,
  reversalDistanceUsd: number = SPEC.reversalDistanceUsd,
): TrailingUpdate {
  const previousExtreme = session.extremeSinceEntry ?? quote.bid;
  const extremeSinceEntry = Math.max(previousExtreme, quote.bid);
  const reversalLevel = extremeSinceEntry - reversalDistanceUsd;
  return { extremeSinceEntry, reversalLevel, reversalTriggered: quote.bid <= reversalLevel };
}

/**
 * SELL: `lowestPriceSinceEntry` tracks the trailing low of ASK (what the
 * position would actually close at, buying it back). It only ever decreases;
 * the BUY reversal level trails it and only ever decreases in turn.
 */
export function updateSellTrailing(
  session: SarSessionState,
  quote: SarQuote,
  reversalDistanceUsd: number = SPEC.reversalDistanceUsd,
): TrailingUpdate {
  const previousExtreme = session.extremeSinceEntry ?? quote.ask;
  const extremeSinceEntry = Math.min(previousExtreme, quote.ask);
  const reversalLevel = extremeSinceEntry + reversalDistanceUsd;
  return { extremeSinceEntry, reversalLevel, reversalTriggered: quote.ask >= reversalLevel };
}

/** Applies a trailing update to the session without changing direction/state. */
export function applyTrailing(session: SarSessionState, update: TrailingUpdate): SarSessionState {
  return { ...session, extremeSinceEntry: update.extremeSinceEntry, reversalLevel: update.reversalLevel };
}

/** Starts the NEW cycle after a broker-confirmed reversal fill. The old cycle's high/low is never carried over. */
export function openReversalCycle(
  session: SarSessionState,
  newDirection: SarDirection,
  confirmedFillPrice: number,
  cycleId: string,
  brokerTicket: string,
): SarSessionState {
  return openInitialCycle(session, newDirection, confirmedFillPrice, cycleId, brokerTicket);
}

/** Marks a submitted reversal/entry whose broker answer was lost or ambiguous. Blocks further action until resolved. */
export function markUnknown(session: SarSessionState): SarSessionState {
  return { ...session, state: 'REVERSAL_UNKNOWN' };
}

/** Resolves an UNKNOWN once reconciliation established broker reality. */
export function resolveUnknown(
  session: SarSessionState,
  resolved: { readonly filled: false } | { readonly filled: true; readonly direction: SarDirection; readonly fillPrice: number; readonly ticket: string; readonly cycleId: string },
): SarSessionState {
  if (!resolved.filled) {
    // The order never reached the broker: the state before the attempt still holds.
    return session.direction === null
      ? { ...session, state: 'WAIT_INITIAL_DIRECTION' }
      : { ...session, state: session.direction === 'BUY' ? 'ACTIVE_BUY' : 'ACTIVE_SELL' };
  }
  return openInitialCycle(session, resolved.direction, resolved.fillPrice, resolved.cycleId, resolved.ticket);
}

/** 23:40 Beirut: no new exposure, flatten whatever is open, end the day. */
export function closeForDay(session: SarSessionState): SarSessionState {
  return {
    ...initialSessionState(session.sessionDate),
    state: 'DAILY_CLOSED',
  };
}

/** 01:00 Beirut the next day: a brand new session, flat, waiting for the market. */
export function startNewSession(sessionDate: string): SarSessionState {
  return initialSessionState(sessionDate);
}
