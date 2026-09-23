/**
 * One signal, one position — always aimed at TP1.
 *
 * A message may list several targets ("Tp 4315 / Tp 4326"), but this engine
 * opens exactly ONE 0.01-lot position per signal, at the SOURCE entry and
 * SOURCE stop, targeting TP1 — the nearest target in the trade's direction
 * (see tp1.ts). The full published target list is still parsed and stored
 * for the audit trail; only the nearest one ever becomes a broker order.
 *
 * This is a strategy rule, set by the operator, not a technical limitation:
 * an earlier version of this engine opened one position PER target. Changed
 * because managing several simultaneous legs from one signal added
 * complexity — partial closes, per-leg P&L, TP1-touched cancelling some legs
 * but not others — for a benefit the operator decided was not worth it.
 *
 * "Leg 1" is still the term used throughout the codebase (the DB column is
 * `legIndex`, always 1 now) rather than renaming everything to "the order" —
 * that would touch every call site downstream for a purely cosmetic gain,
 * and every one of them already handles "however many legs exist" generically.
 *
 * The signal is still called a "signal group" downstream (DB tables, dedup,
 * occupancy) — with one leg, "group" is a group of one, and every rule that
 * treats the group as the unit of duplication/occupancy is unaffected by how
 * many legs happen to be in it.
 *
 * ## The brackets are the channel's, not this engine's
 *
 * Engine A computes a $5/$5 bracket from the live quote. Engine B does no
 * such thing: it copies the published stop and the published target
 * verbatim. Recomputing them would make this a different strategy that
 * happens to be triggered by Telegram, which is not what a copy engine is.
 *
 * What is validated is only that the broker will accept them — minimum stop
 * distance, freeze level, tick rounding — and a leg the broker would reject
 * is refused rather than widened to fit.
 */
import { roundToTick, type BrokerStopConstraints } from '../xauusd-m1m5/brackets';
import { TELEGRAM_LOT_STEP, TELEGRAM_MAGIC, TELEGRAM_MAX_LOTS, TELEGRAM_MIN_LOTS } from './safety-constants';
import { TELEGRAM_SPEC, type Direction } from './spec';
import { configuredMaxAdverseEntryDeviationUsd } from './controls';
import { evaluateEntryDeviation, firstTarget, reachesFirstTarget } from './tp1';
import type { ParsedSignal } from './parser';

export interface TelegramLeg {
  /** 1-based, in the order the channel published the targets. */
  readonly legIndex: number;
  readonly direction: Direction;
  readonly volumeLots: number;
  /** The entry the channel published, carried unchanged onto every leg. */
  readonly sourceEntry: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly magicNumber: number;
}

export type LegRefusal =
  /**
   * The market has moved off the published entry — adversely beyond the
   * configured bound, or favourably at all. See `tp1.ts`.
   */
  | 'TELEGRAM_ADVERSE_ENTRY_DEVIATION'
  /** Price has already reached the first target; the signal is spent. */
  | 'TELEGRAM_TP1_ALREADY_REACHED'
  | 'TELEGRAM_VOLUME_REFUSED'
  | 'TELEGRAM_BROKER_STOPS_REFUSED'
  | 'TELEGRAM_INVALID_CONSTRAINTS';

export interface LegPlan {
  readonly legs: readonly TelegramLeg[] | null;
  readonly refusal: LegRefusal | null;
  readonly detail: string | null;
  /** The executable price the deviation was measured against. */
  readonly executablePrice: number | null;
  /** Signed: positive is adverse, negative is favourable. */
  readonly deviationUsd: number | null;
  /** True when the market had moved TOWARD the target, not away from it. */
  readonly favourable: boolean;
  /** The nearest target, which is what decides whether the signal is spent. */
  readonly tp1: number | null;
}

export interface LegPlanInput {
  readonly signal: ParsedSignal;
  readonly quote: { bid: number; ask: number };
  readonly constraints: BrokerStopConstraints;
  /**
   * Whether the first target has ALREADY been reached at some point since
   * publication, as recorded by the latch in `tp1.ts`. Passed in rather than
   * derived from the current quote on purpose: a touch is permanent, and a
   * planner that looked only at the current price would let a retracement
   * revive a signal that is finished.
   */
  readonly tp1AlreadyTouched?: boolean;
  /** Overrides the configured adverse bound; used by tests. */
  readonly maxAdverseUsd?: number;
}

/**
 * Builds the legs, or refuses the whole signal.
 *
 * Whole-signal, deliberately: if the broker would reject the nearest target
 * for being inside its stop level, the engine does not open the far leg
 * alone. A partially copied multi-target trade is a different trade with a
 * different risk profile, and nobody asked for it.
 */
export function planLegs(input: LegPlanInput): LegPlan {
  const { signal, quote, constraints } = input;
  const refuse = (
    refusal: LegRefusal,
    detail: string,
    executablePrice: number | null = null,
    deviationUsd: number | null = null,
    favourable = false,
    tp1: number | null = null,
  ): LegPlan => ({ legs: null, refusal, detail, executablePrice, deviationUsd, favourable, tp1 });

  if (!Number.isFinite(constraints.pointSize) || constraints.pointSize <= 0) {
    return refuse(
      'TELEGRAM_INVALID_CONSTRAINTS',
      `Broker point size ${constraints.pointSize} is unusable, so the broker's stop and freeze levels cannot be ` +
        'converted to price. Refusing rather than submitting levels that could be wrong by orders of magnitude.',
    );
  }

  // A BUY is filled at the ASK and a SELL at the BID. Measuring against mid,
  // or against the wrong side, understates the distance by half the spread on
  // every signal.
  const executablePrice = signal.direction === 'BUY' ? quote.ask : quote.bid;
  const tp1 = firstTarget(signal.direction, signal.takeProfits);

  // --- Is the signal already spent? Checked before anything else, because a
  // signal whose first target has been reached is finished however good the
  // entry looks now. The latch wins over the live quote: a touch recorded
  // earlier cancels the signal even if price has since retraced.
  const closingPrice = signal.direction === 'SELL' ? quote.ask : quote.bid;
  if (input.tp1AlreadyTouched === true || reachesFirstTarget(signal.direction, tp1, closingPrice)) {
    return refuse(
      'TELEGRAM_TP1_ALREADY_REACHED',
      input.tp1AlreadyTouched === true
        ? `The first target ${tp1} was already reached for this signal. It stays cancelled even though price has ` +
            `since retraced to ${closingPrice}: the move the message described has already happened.`
        : `Price ${closingPrice} has reached the first target ${tp1}. The signal is finished; no leg is opened, it ` +
            'is not held for a retracement and it is never replayed.',
      executablePrice,
      null,
      false,
      tp1,
    );
  }

  // --- Entry protection. The published entry is the trade: price having
  // moved off it in EITHER direction is refused now, not just adverse
  // movement beyond the bound — see tp1.ts.
  const maxAdverse = input.maxAdverseUsd ?? configuredMaxAdverseEntryDeviationUsd();
  const deviation = evaluateEntryDeviation(signal.direction, signal.entry, executablePrice, maxAdverse);
  if (!deviation.acceptable) {
    return refuse(
      'TELEGRAM_ADVERSE_ENTRY_DEVIATION',
      deviation.detail,
      executablePrice,
      deviation.adverseUsd,
      deviation.favourable,
      tp1,
    );
  }
  const deviationUsd = deviation.adverseUsd;
  const favourable = deviation.favourable;

  const lots = TELEGRAM_SPEC.lotsPerTakeProfit;
  const volumeDetail = validateLegVolume(lots);
  if (volumeDetail !== null) {
    return refuse('TELEGRAM_VOLUME_REFUSED', volumeDetail, executablePrice, deviationUsd, favourable, tp1);
  }

  // The broker's minimum stop distance and freeze level are measured from the
  // CURRENT market, not from the published entry: that is what the terminal
  // checks when the order is sent.
  const minDistance = constraints.stopLevelPoints * constraints.pointSize;
  const freezeDistance = constraints.freezeLevelPoints * constraints.pointSize;
  const required = Math.max(minDistance, freezeDistance);

  const stopLoss = roundToTick(signal.stopLoss, constraints.tickSize);
  const stopDistance = Math.abs(executablePrice - stopLoss);
  if (stopDistance < required) {
    return refuse(
      'TELEGRAM_BROKER_STOPS_REFUSED',
      `The published stop ${stopLoss} is ${stopDistance.toFixed(2)} from the market, inside the broker's ` +
        `${required.toFixed(2)} minimum. The stop is NOT widened to fit — the published level is the trade.`,
      executablePrice,
      deviationUsd,
      favourable,
      tp1,
    );
  }

  // --- Exactly ONE leg, targeting TP1 only.
  //
  // A multi-target signal used to become one broker position PER target
  // (2 TPs -> 2 legs). Changed on operator instruction: regardless of how
  // many targets a message lists, this engine now opens a single 0.01-lot
  // position aimed at the nearest one, TP1 -- the same level that already
  // governs the permanent "signal is spent" latch above. Every other target
  // the channel published is recorded (ParsedSignal.takeProfits keeps the
  // full list, for the audit trail) but never becomes a second position.
  const takeProfit = roundToTick(tp1, constraints.tickSize);
  const tpDistance = Math.abs(takeProfit - executablePrice);
  if (tpDistance < required) {
    return refuse(
      'TELEGRAM_BROKER_STOPS_REFUSED',
      `Take profit ${takeProfit} is ${tpDistance.toFixed(2)} from the market, inside the broker's ` +
        `${required.toFixed(2)} minimum. The stop is NOT widened to fit — the published level is the trade.`,
      executablePrice,
      deviationUsd,
      favourable,
      tp1,
    );
  }

  const legs: TelegramLeg[] = [
    {
      legIndex: 1,
      direction: signal.direction,
      volumeLots: lots,
      sourceEntry: signal.entry,
      stopLoss,
      takeProfit,
      magicNumber: TELEGRAM_MAGIC,
    },
  ];

  return { legs, refusal: null, detail: null, executablePrice, deviationUsd, favourable, tp1 };
}

/**
 * Validates the leg size against the broker envelope. Note that it REFUSES
 * rather than rounding: rounding a stop to a valid tick is an adjustment
 * below the precision anyone cares about, while rounding a volume changes the
 * size traded into one nobody approved.
 */
export function validateLegVolume(lots: number): string | null {
  if (!Number.isFinite(lots) || lots <= 0) return `Leg volume ${lots} is not a positive number.`;
  if (lots < TELEGRAM_MIN_LOTS) return `Leg volume ${lots} is below the broker minimum ${TELEGRAM_MIN_LOTS}.`;
  if (lots > TELEGRAM_MAX_LOTS) return `Leg volume ${lots} exceeds the broker maximum ${TELEGRAM_MAX_LOTS}.`;
  const steps = lots / TELEGRAM_LOT_STEP;
  if (Math.abs(steps - Math.round(steps)) > 1e-9) {
    return `Leg volume ${lots} is not a multiple of the broker step ${TELEGRAM_LOT_STEP}.`;
  }
  return null;
}

/**
 * Margin for the WHOLE group, from MT5's own formula
 * `lots * contractSize * price / leverage`, summed across legs.
 *
 * Checked per group rather than per leg because the legs are submitted within
 * moments of each other: approving each against the full free margin in turn
 * would approve a set the account cannot actually carry.
 *
 * Returns Infinity when leverage or contract size is unknown. That is not a
 * sentinel to be special-cased downstream — it flows into the comparison and
 * is refused there, which is the correct outcome in the correct place.
 */
export function groupMarginRequired(
  legs: readonly TelegramLeg[],
  contractSize: number,
  price: number,
  leverage: number | null,
): number {
  if (!leverage || leverage <= 0) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(contractSize) || contractSize <= 0) return Number.POSITIVE_INFINITY;
  const lots = legs.reduce((sum, leg) => sum + leg.volumeLots, 0);
  return (lots * contractSize * price) / leverage;
}
