/**
 * Entry pricing and protective brackets (§7).
 *
 * TP and SL are each a **$5.00 move in quoted gold price** — a price
 * distance, not five broker points, and not a promise of a $5
 * account-currency result. What $5 of price is worth in account currency
 * depends on contract size and lot volume, and this module deliberately does
 * not pretend otherwise.
 *
 *   SELL at 4450 -> TP 4445, SL 4455
 *   BUY  at 4450 -> TP 4455, SL 4445
 *
 * ## Which side of the spread
 *
 * A BUY is filled at the ASK and a SELL at the BID. Using mid, or using the
 * wrong side, systematically misplaces both brackets by half the spread and
 * makes the recorded entry price disagree with what the broker actually
 * fills — which then makes every slippage figure wrong.
 *
 * ## Point size is verified, not assumed
 *
 * §7 requires the broker's real point size to be checked rather than
 * assuming every broker uses the same decimal representation. The constant in
 * `safety-constants.ts` is the EXPECTATION; `bracketsFor` takes the live
 * value and refuses a value that disagrees implausibly, because a wrong point
 * size turns a $5 stop into a $0.05 or $500 one.
 */
import {
  V2_EXPECTED_GOLD_POINT_SIZE,
  V2_SL_TP_TOLERANCE_POINTS,
  V2_SL_USD,
  V2_TP_USD,
} from './safety-constants';
import type { Direction } from './spec';

export interface Quote {
  readonly bid: number;
  readonly ask: number;
}

export interface Brackets {
  /** The side of the spread this direction is actually filled at. */
  readonly entryPrice: number;
  readonly takeProfit: number;
  readonly stopLoss: number;
  /** The distances actually applied, in price. Both should be exactly 5. */
  readonly takeProfitDistance: number;
  readonly stopLossDistance: number;
}

export type BracketRefusal =
  | 'INVALID_QUOTE'
  | 'CROSSED_QUOTE'
  | 'IMPLAUSIBLE_POINT_SIZE'
  | 'BRACKET_BELOW_BROKER_STOP_LEVEL'
  | 'BRACKET_INSIDE_FREEZE_LEVEL';

export interface BracketResult {
  readonly brackets: Brackets | null;
  readonly refusal: BracketRefusal | null;
  readonly detail: string | null;
}

/** Broker constraints that bound where a stop may be placed (§7). */
export interface BrokerStopConstraints {
  /** Live point size from SymbolMetadata, e.g. 0.01 for 2-digit gold. */
  readonly pointSize: number;
  /** Minimum distance from market, in points, that a stop may be set. */
  readonly stopLevelPoints: number;
  /** Distance from market, in points, within which orders are frozen. */
  readonly freezeLevelPoints: number;
  /** Smallest price increment the broker accepts. */
  readonly tickSize: number;
}

/**
 * How far the live point size may differ from the expectation before it is
 * refused. An order of magnitude either way is not a broker variation, it is
 * a wrong value — and acting on it would misplace the stop by 100x.
 */
const POINT_SIZE_PLAUSIBLE_RANGE = { min: V2_EXPECTED_GOLD_POINT_SIZE / 10, max: V2_EXPECTED_GOLD_POINT_SIZE * 10 };

export function bracketsFor(
  direction: Direction,
  quote: Quote,
  constraints: BrokerStopConstraints,
): BracketResult {
  const refuse = (refusal: BracketRefusal, detail: string): BracketResult => ({ brackets: null, refusal, detail });

  if (![quote.bid, quote.ask].every((p) => Number.isFinite(p) && p > 0)) {
    return refuse('INVALID_QUOTE', `Quote is unusable: bid=${quote.bid}, ask=${quote.ask}.`);
  }
  if (quote.ask < quote.bid) {
    return refuse('CROSSED_QUOTE', `Quote is crossed: bid=${quote.bid} exceeds ask=${quote.ask}.`);
  }
  if (
    !Number.isFinite(constraints.pointSize) ||
    constraints.pointSize < POINT_SIZE_PLAUSIBLE_RANGE.min ||
    constraints.pointSize > POINT_SIZE_PLAUSIBLE_RANGE.max
  ) {
    return refuse(
      'IMPLAUSIBLE_POINT_SIZE',
      `Broker point size ${constraints.pointSize} is implausible for this symbol (expected around ` +
        `${V2_EXPECTED_GOLD_POINT_SIZE}). Refusing rather than placing a stop that could be off by orders of ` +
        'magnitude.',
    );
  }

  // BUY fills at the ask, SELL at the bid.
  const entryPrice = direction === 'BUY' ? quote.ask : quote.bid;

  const takeProfit = direction === 'BUY' ? entryPrice + V2_TP_USD : entryPrice - V2_TP_USD;
  const stopLoss = direction === 'BUY' ? entryPrice - V2_SL_USD : entryPrice + V2_SL_USD;

  // Both brackets sit $5 away, so the binding broker constraint is the same
  // for each; checking the smaller of the two distances covers both.
  const distancePoints = V2_SL_USD / constraints.pointSize;
  if (distancePoints < constraints.stopLevelPoints) {
    return refuse(
      'BRACKET_BELOW_BROKER_STOP_LEVEL',
      `A $${V2_SL_USD} bracket is ${distancePoints} points, inside the broker minimum stop distance of ` +
        `${constraints.stopLevelPoints} points. The bracket is NOT widened to fit: the specified distance is a ` +
        'rule, not a preference.',
    );
  }
  if (constraints.freezeLevelPoints > 0 && distancePoints < constraints.freezeLevelPoints) {
    return refuse(
      'BRACKET_INSIDE_FREEZE_LEVEL',
      `A $${V2_SL_USD} bracket is ${distancePoints} points, inside the broker freeze level of ` +
        `${constraints.freezeLevelPoints} points, where modification would be rejected.`,
    );
  }

  return {
    brackets: {
      entryPrice,
      takeProfit: roundToTick(takeProfit, constraints.tickSize),
      stopLoss: roundToTick(stopLoss, constraints.tickSize),
      takeProfitDistance: V2_TP_USD,
      stopLossDistance: V2_SL_USD,
    },
    refusal: null,
    detail: null,
  };
}

/**
 * Rounds a protective level to the broker's tick size.
 *
 * Note the asymmetry with volume: rounding a STOP to a valid tick is
 * required — the broker rejects anything else, and the adjustment is at most
 * one tick, far below the precision the $5 rule expresses. Rounding a VOLUME
 * would change the size traded, which is why `volume.ts` refuses instead of
 * rounding. Different things, different treatment.
 */
export function roundToTick(price: number, tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return price;
  const rounded = Math.round(price / tickSize) * tickSize;
  // Re-round to kill floating-point dust, e.g. 4445.000000000001.
  const decimals = Math.max(0, Math.ceil(-Math.log10(tickSize)));
  return Number(rounded.toFixed(decimals));
}

/**
 * Re-verifies that a candidate's brackets still describe the required
 * distances, immediately before submission.
 *
 * The claim that these were computed correctly earlier is not evidence that
 * the values being sent now are right: they may have travelled through a
 * database round trip, a Decimal conversion and a queue.
 */
export function verifyBracketDistances(
  direction: Direction,
  entryPrice: number,
  stopLoss: number,
  takeProfit: number,
  pointSize: number,
): { ok: boolean; detail: string | null } {
  // The relative epsilon matters: the tolerance is "at most one point", and
  // one point is exactly what a broker-rounded level differs by. Without it
  // the comparison sits precisely on the boundary, where binary floating
  // point decides the outcome — 4455.01 - 4455 is 0.010000000000218279, so a
  // legitimately rounded stop would be refused as misplaced. Scaled to the
  // price rather than absolute, since gold trades near 4000 and the
  // representable gap grows with magnitude.
  const tolerance = V2_SL_TP_TOLERANCE_POINTS * pointSize + Math.abs(entryPrice) * Number.EPSILON * 8;

  const expectedTp = direction === 'BUY' ? entryPrice + V2_TP_USD : entryPrice - V2_TP_USD;
  const expectedSl = direction === 'BUY' ? entryPrice - V2_SL_USD : entryPrice + V2_SL_USD;

  if (Math.abs(takeProfit - expectedTp) > tolerance) {
    return {
      ok: false,
      detail: `Take profit ${takeProfit} is not $${V2_TP_USD} from entry ${entryPrice} (expected ${expectedTp}).`,
    };
  }
  if (Math.abs(stopLoss - expectedSl) > tolerance) {
    return {
      ok: false,
      detail: `Stop loss ${stopLoss} is not $${V2_SL_USD} from entry ${entryPrice} (expected ${expectedSl}).`,
    };
  }
  // Direction sanity: a SELL whose stop sits below entry would be a take
  // profit, and vice versa. Cheap to check, catastrophic to get wrong.
  if (direction === 'BUY' && !(stopLoss < entryPrice && takeProfit > entryPrice)) {
    return { ok: false, detail: `BUY brackets are inverted: entry ${entryPrice}, SL ${stopLoss}, TP ${takeProfit}.` };
  }
  if (direction === 'SELL' && !(stopLoss > entryPrice && takeProfit < entryPrice)) {
    return { ok: false, detail: `SELL brackets are inverted: entry ${entryPrice}, SL ${stopLoss}, TP ${takeProfit}.` };
  }
  return { ok: true, detail: null };
}

/**
 * Drift between the price a signal was formed at and the executable price
 * now, in broker points (§7 — 100-point limit).
 */
export function entryDriftPoints(signalPrice: number, executablePrice: number, pointSize: number): number {
  return Math.abs(executablePrice - signalPrice) / pointSize;
}
