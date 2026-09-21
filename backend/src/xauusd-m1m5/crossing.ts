/**
 * Entry formation and normal rearming for one timeframe (§3, §5).
 *
 * This replaces the previous strategy's `pattern.ts` entirely. There are no
 * peaks, troughs, confirmations, pullbacks, rebounds or retests here, no
 * 82/18 invalidation, no Sell 1/Sell 2 or Buy 1/Buy 2 hierarchy, and no
 * standalone extreme entry at 98.5 or 1.5 (§3.4). The whole rule is:
 *
 *   SELL  when  previous RSI <  91   AND  current RSI >=  91
 *   BUY   when  previous RSI >  8.9  AND  current RSI <=  8.9
 *
 * evaluated intrabar at full precision, independently per timeframe.
 *
 * ## Why an explicit `armed` flag when the rule already implies it
 *
 * `previous < 91 AND current >= 91` cannot fire twice in a row without RSI
 * dropping below 91 in between, so normal rearming (§5) falls out of the
 * crossing condition itself. The explicit flag is kept for three reasons
 * that the bare condition does not cover:
 *
 * 1. §3.3 — the first observation after initialization, a gap or a restart
 *    must not establish a crossing by itself, and must not enter merely
 *    because RSI is ALREADY at or beyond a threshold. A fresh state starts
 *    disarmed, and arms only once an observation is seen strictly on the
 *    permissive side of the threshold.
 * 2. It is the thing that survives a restart and the thing the dashboard
 *    shows (§12 — "Independent crossing/rearming states"), so it has to be
 *    a persisted fact rather than an inference from a value.
 * 3. Defence in depth: if a future change ever loosened the crossing
 *    predicate, the flag still prevents a continuous stay beyond a threshold
 *    from repeatedly creating orders, which is the actual user requirement.
 *
 * ## Consumption
 *
 * A signal is CONSUMED the moment it forms, whatever happens to it
 * afterwards — submitted, skipped for occupancy, skipped for a post-loss
 * lock, skipped for the schedule, or refused by risk. §4 and §5 are explicit
 * that a skipped signal is never queued and never replayed when the slot
 * later frees. That is why `evaluate()` returns the already-disarmed state
 * together with the signal: the caller cannot forget to consume it, and no
 * code path exists that could re-offer it.
 */
import {
  SPEC,
  continuityGapBudgetMs,
  type Direction,
  type Timeframe,
} from './spec';

export interface CrossingState {
  readonly timeframe: Timeframe;
  /** Spec hash this state was written under; a mismatch refuses the state. */
  readonly specHash: string;
  /**
   * The RSI of the previous ACCEPTED observation, or null when continuity is
   * not established (fresh start, after a gap, after a restart without
   * usable state). Null can never produce a crossing.
   */
  readonly previousRsi: number | null;
  /** Timestamp (UTC ms) of the previous accepted observation, or null. */
  readonly previousObservationT: number | null;
  /**
   * True when a fresh SELL crossing is permitted: RSI has been observed
   * strictly below 91 since the last consumed SELL signal.
   */
  readonly sellArmed: boolean;
  /**
   * True when a fresh BUY crossing is permitted: RSI has been observed
   * strictly above 8.9 since the last consumed BUY signal.
   */
  readonly buyArmed: boolean;
  /** Monotonic counter, used to build unique signal identities. */
  readonly signalSeq: number;
  /** Identity of the last consumed signal, for audit and deduplication. */
  readonly lastConsumedSignalId: string | null;
}

export type ObservationRejection =
  /** Timestamp not strictly after the previous accepted observation. */
  | 'OUT_OF_ORDER_OR_DUPLICATE'
  /** RSI is not a finite number (indicator not seeded, bad input). */
  | 'NO_RSI'
  /** Indicator has not accumulated enough closed bars on this timeframe. */
  | 'WARMING_UP'
  /** Observation is older than the staleness budget, or dated in the future. */
  | 'NOT_FRESH';

export interface Observation {
  /** UTC ms of the observation itself (the quote's own timestamp). */
  readonly t: number;
  /** Full-precision projected RSI for the forming bar. Never rounded. */
  readonly rsi: number | null;
  /** The quote price the RSI was projected from, carried into signal evidence. */
  readonly price: number;
  /** True once this timeframe has enough closed bars (§3.3, §10). */
  readonly warmedUp: boolean;
  /** True when the observation passes the freshness bounds (§7, §10). */
  readonly fresh: boolean;
}

export interface CrossingSignal {
  readonly signalId: string;
  readonly timeframe: Timeframe;
  readonly direction: Direction;
  /** RSI that triggered the crossing, full precision. */
  readonly rsi: number;
  /** RSI of the preceding accepted observation, full precision. */
  readonly previousRsi: number;
  /** Threshold the crossing was measured against (91 or 8.9). */
  readonly threshold: number;
  /** Quote price at the moment of the crossing. */
  readonly price: number;
  /** UTC ms of the observation that produced the crossing. */
  readonly observedAt: number;
}

export interface CrossingEvaluation {
  readonly state: CrossingState;
  /** The crossing formed by this observation, already consumed. */
  readonly signal: CrossingSignal | null;
  /** Null when the observation was folded into state; otherwise why it was not. */
  readonly rejection: ObservationRejection | null;
  /**
   * True when continuity was broken before this observation was applied —
   * either the first observation of a run or a gap longer than this
   * timeframe's budget. §3.3: continuity is re-established WITHOUT inventing
   * a crossing through the unobserved interval.
   */
  readonly continuityReset: boolean;
}

export function createCrossingState(timeframe: Timeframe, specHash: string): CrossingState {
  return {
    timeframe,
    specHash,
    previousRsi: null,
    previousObservationT: null,
    // Deliberately DISARMED at birth. §3.3 — a first observation already at
    // or beyond a threshold must not enter. Arming requires positively
    // observing RSI on the permissive side first.
    sellArmed: false,
    buyArmed: false,
    signalSeq: 0,
    lastConsumedSignalId: null,
  };
}

/**
 * Whether a state written under `specHash` may still be used.
 *
 * Refused rather than migrated: a state file written under different
 * thresholds describes arming decisions that the current rules would not
 * have made, and silently adopting it produces entries no audit can explain.
 */
export function isCrossingStateCompatible(state: CrossingState, specHash: string): boolean {
  return state.specHash === specHash;
}

/**
 * Folds one observation into the crossing state, returning any signal it
 * forms. Pure: same inputs always produce the same outputs, which is what
 * makes duplicate observations harmless and the whole rule set exhaustively
 * testable without a broker.
 */
export function evaluate(state: CrossingState, obs: Observation): CrossingEvaluation {
  const unchanged = (rejection: ObservationRejection): CrossingEvaluation => ({
    state,
    signal: null,
    rejection,
    continuityReset: false,
  });

  // Duplicate and out-of-order observations never advance state and never
  // produce a second signal for the same instant (§10, §15.1).
  if (state.previousObservationT !== null && obs.t <= state.previousObservationT) {
    return unchanged('OUT_OF_ORDER_OR_DUPLICATE');
  }
  // Warm-up is tested BEFORE the null check, because during warm-up the
  // indicator legitimately has no value yet and `WARMING_UP` is the reason an
  // operator needs: it says "wait", where `NO_RSI` reads as "something is
  // broken". Both suppress the signal identically, so this ordering changes
  // only what gets reported — but a dashboard that cries fault during normal
  // start-up is one an operator learns to ignore.
  //
  // With this order, a surviving `NO_RSI` means the indicator claims to be
  // warmed up yet produced no value, which IS an anomaly worth seeing.
  if (!obs.warmedUp) return unchanged('WARMING_UP');
  if (obs.rsi === null || !Number.isFinite(obs.rsi)) return unchanged('NO_RSI');

  // Staleness likewise does not merely suppress the signal — it must not
  // advance continuity either, because an entry formed against a `previousRsi`
  // that came from stale or warm-up data would not be the event the rules
  // described (§3.3, §11).
  if (!obs.fresh) return unchanged('NOT_FRESH');

  const gapBudget = continuityGapBudgetMs(state.timeframe);
  const gapMs = state.previousObservationT === null ? null : obs.t - state.previousObservationT;
  const continuityReset = state.previousObservationT === null || (gapMs !== null && gapMs > gapBudget);

  const { sellCross, buyCross } = SPEC.thresholds;

  // Arming is evaluated on THIS observation before the crossing test, and it
  // is what re-establishes a usable state after a reset. An observation that
  // merely arms a direction never also fires it: firing additionally requires
  // a previous RSI on the far side, which a reset has cleared.
  const sellArmed = state.sellArmed || obs.rsi < sellCross;
  const buyArmed = state.buyArmed || obs.rsi > buyCross;

  if (continuityReset) {
    return {
      state: {
        ...state,
        previousRsi: obs.rsi,
        previousObservationT: obs.t,
        // Arming after a reset is decided solely by where RSI actually is.
        // Starting from `false` rather than the carried-over flag is what
        // stops a pre-gap arm from firing on a post-gap value, i.e. what
        // stops a crossing being invented through the unobserved interval.
        sellArmed: obs.rsi < sellCross,
        buyArmed: obs.rsi > buyCross,
      },
      signal: null,
      rejection: null,
      continuityReset: true,
    };
  }

  const previousRsi = state.previousRsi as number;

  // USER RULE §3.1 — previous < 91 AND current >= 91. Equality at the
  // threshold counts when approached from the specified side, and the
  // comparison is against the full-precision value: no rounding, no epsilon.
  const sellCrossing = sellArmed && previousRsi < sellCross && obs.rsi >= sellCross;
  // USER RULE §3.2 — previous > 8.9 AND current <= 8.9.
  const buyCrossing = buyArmed && previousRsi > buyCross && obs.rsi <= buyCross;

  // The two conditions are mutually exclusive for any finite pair of values
  // (one requires an upward move across 91, the other a downward move across
  // 8.9), so no precedence rule is needed or implied.
  let direction: Direction | null = null;
  if (sellCrossing) direction = 'SELL';
  else if (buyCrossing) direction = 'BUY';

  if (direction === null) {
    return {
      state: { ...state, previousRsi: obs.rsi, previousObservationT: obs.t, sellArmed, buyArmed },
      signal: null,
      rejection: null,
      continuityReset: false,
    };
  }

  const signalSeq = state.signalSeq + 1;
  const signalId = `${state.timeframe}:${direction}:${obs.t}:${signalSeq}`;

  return {
    state: {
      ...state,
      previousRsi: obs.rsi,
      previousObservationT: obs.t,
      // CONSUMED here, unconditionally. Whatever the caller decides to do
      // with this signal — submit, skip for occupancy, skip for a post-loss
      // lock, skip for the schedule, refuse on risk — the direction is
      // disarmed and must be re-armed by RSI returning to the permissive
      // side before another crossing can form (§5).
      sellArmed: direction === 'SELL' ? false : sellArmed,
      buyArmed: direction === 'BUY' ? false : buyArmed,
      signalSeq,
      lastConsumedSignalId: signalId,
    },
    signal: {
      signalId,
      timeframe: state.timeframe,
      direction,
      rsi: obs.rsi,
      previousRsi,
      threshold: direction === 'SELL' ? sellCross : buyCross,
      price: obs.price,
      observedAt: obs.t,
    },
    rejection: null,
    continuityReset: false,
  };
}

/** Human-readable rearming state for the dashboard (§12). */
export function describeArming(state: CrossingState, direction: Direction): string {
  const { sellCross, buyCross } = SPEC.thresholds;
  if (direction === 'SELL') {
    return state.sellArmed
      ? `Armed — a rise across ${sellCross} from below will signal SELL.`
      : `Not armed — RSI must return below ${sellCross} before another SELL crossing can form.`;
  }
  return state.buyArmed
    ? `Armed — a fall across ${buyCross} from above will signal BUY.`
    : `Not armed — RSI must return above ${buyCross} before another BUY crossing can form.`;
}
