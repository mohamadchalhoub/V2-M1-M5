/**
 * One timeframe's complete observation engine (§10).
 *
 * Owns that timeframe's bar aggregation, RSI state, crossing state and
 * continuity, and produces the `Observation` the decision gate consumes.
 * There is one of these per timeframe and nothing is shared between them —
 * §4 permits a shared tick feed but not shared indicator or crossing state,
 * and keeping the whole per-timeframe world inside one object is what makes
 * that structural rather than a convention.
 *
 * ## Bars are derived here, ticks are not RSI periods
 *
 * The engine buckets incoming ticks into bars of its own timeframe. Within a
 * bar it only ever PROJECTS: the forming bar's RSI is recomputed from the
 * last committed closed-bar state on every tick, so tick density cannot move
 * the value and replaying a tick is idempotent. When a tick arrives in a
 * later bucket than the forming bar, the forming bar is committed exactly
 * once and the new bucket begins.
 *
 * ## Freshness is measured against an explicit server clock
 *
 * §10 requires an explicit server evaluation time rather than an implicit
 * `Date.now()` inside the calculation, so age is reproducible and testable.
 * `observe()` takes both the quote's own broker timestamp and the server
 * instant it was evaluated at, and reports the relationship between them.
 *
 * ## What this module does NOT do
 *
 * It does not decide, submit, or touch a lock. It produces an observation
 * and the crossing state that observation implies; `decision.ts` is where
 * those meet occupancy, locks and the schedule. Keeping that boundary sharp
 * is what lets §15's rule tests run with no engine at all, and lets this
 * module's tests run with no decisions at all.
 */
import {
  createCrossingState,
  type CrossingState,
  type Observation,
} from './crossing';
import {
  commitClosedBar,
  createRsiState,
  currentRsi,
  isWarmedUp,
  projectRsi,
  type WilderRsiState,
} from './rsi';
import {
  V2_ENGINE_CLOCK_FUTURE_LIMIT_MS,
  V2_FUTURE_OBSERVATION_TOLERANCE_MS,
} from './safety-constants';
import { SPEC, SPEC_HASH, TIMEFRAME_BAR_MS, continuityGapBudgetMs, type Timeframe } from './spec';

/** The bar bucket a broker timestamp falls into, for this timeframe. */
export function barStartMs(timeframe: Timeframe, t: number): number {
  const size = TIMEFRAME_BAR_MS[timeframe];
  return Math.floor(t / size) * size;
}

export interface EngineState {
  readonly timeframe: Timeframe;
  readonly specHash: string;
  readonly rsi: WilderRsiState;
  readonly crossing: CrossingState;
  /** Start of the bar currently forming, or null before the first tick. */
  readonly formingBarStart: number | null;
  /** Latest price seen inside the forming bar — its close-so-far. */
  readonly formingClose: number | null;
  /** Broker timestamp of the most recent ACCEPTED tick. */
  readonly lastTickT: number | null;
  /** Server instant of the most recent accepted observation, for cadence. */
  readonly lastEvaluatedAt: number | null;
  /** Measured interval between the last two accepted observations, in ms. */
  readonly lastObservationIntervalMs: number | null;
  /** Count of accepted observations since construction, for the dashboard. */
  readonly observationCount: number;
  /** Count of gaps that reset continuity, surfaced as an honesty signal. */
  readonly continuityResetCount: number;
}

export function createEngineState(timeframe: Timeframe): EngineState {
  return {
    timeframe,
    specHash: SPEC_HASH,
    rsi: createRsiState(),
    crossing: createCrossingState(timeframe, SPEC_HASH),
    formingBarStart: null,
    formingClose: null,
    lastTickT: null,
    lastEvaluatedAt: null,
    lastObservationIntervalMs: null,
    observationCount: 0,
    continuityResetCount: 0,
  };
}

export type TickRejection =
  /** Broker timestamp not strictly after the last accepted tick. */
  | 'OUT_OF_ORDER_OR_DUPLICATE'
  /** Price is not a usable number. */
  | 'INVALID_PRICE'
  /** Dated further into the future than clock skew can explain. */
  | 'FUTURE_DATED'
  /** Older than the staleness budget. */
  | 'STALE';

export interface EngineTick {
  /** The BROKER's own timestamp, already normalised to true UTC exactly once. */
  readonly tickAtMs: number;
  /** The price this observation is of — one coherent quote's price. */
  readonly price: number;
  /** Explicit server evaluation instant (§10). */
  readonly evaluatedAtMs: number;
}

export interface EngineResult {
  readonly state: EngineState;
  /** The observation to hand to the decision gate, or null if the tick was refused. */
  readonly observation: Observation | null;
  readonly rejection: TickRejection | null;
  /** True when this tick completed a bar and committed it to the RSI state. */
  readonly committedBar: boolean;
  /**
   * True when continuity was broken before this tick. §6.5 uses this to
   * refuse an unlock, and §3.3 to refuse a crossing.
   */
  readonly continuityReset: boolean;
  /** `(evaluatedAtMs - tickAtMs) / 1000`, so the relationship stays checkable. */
  readonly ageSeconds: number;
}

/**
 * Folds one tick into this timeframe's engine.
 *
 * Refusals are deliberately NOT silent no-ops at the state level: an
 * out-of-order or invalid tick leaves state untouched so it cannot corrupt
 * continuity, and the reason is reported so the dashboard can show why the
 * cadence looks degraded rather than merely that it does.
 */
export function observe(state: EngineState, tick: EngineTick): EngineResult {
  const ageSeconds = (tick.evaluatedAtMs - tick.tickAtMs) / 1000;
  const unchanged = (rejection: TickRejection): EngineResult => ({
    state,
    observation: null,
    rejection,
    committedBar: false,
    continuityReset: false,
    ageSeconds,
  });

  if (!Number.isFinite(tick.price) || tick.price <= 0) return unchanged('INVALID_PRICE');
  if (state.lastTickT !== null && tick.tickAtMs <= state.lastTickT) return unchanged('OUT_OF_ORDER_OR_DUPLICATE');

  // Freshness is bounded on BOTH sides. `age <= limit` alone accepts every
  // negative age, so without the future check a wrongly-converted timestamp
  // three hours ahead would pass unconditionally — which is exactly the bug
  // the previous strategy found in production.
  const ageMs = tick.evaluatedAtMs - tick.tickAtMs;
  if (ageMs < -V2_FUTURE_OBSERVATION_TOLERANCE_MS) return unchanged('FUTURE_DATED');
  const fresh = ageMs <= SPEC.observation.maxStalenessMs;

  const bucket = barStartMs(state.timeframe, tick.tickAtMs);
  let rsiState = state.rsi;
  let committedBar = false;

  if (state.formingBarStart === null) {
    // First tick of a run: open a bar, commit nothing.
  } else if (bucket > state.formingBarStart) {
    // The forming bar completed. Commit it EXACTLY ONCE, using its
    // close-so-far as the bar close. Intervening bars with no ticks at all
    // are deliberately not synthesised: inventing closes for bars that were
    // never observed would be fabricating the very history §3.3 forbids, and
    // the continuity check below is what notices the gap instead.
    if (state.formingClose !== null) {
      rsiState = commitClosedBar(rsiState, state.formingClose);
      committedBar = true;
    }
  }

  const gapBudget = continuityGapBudgetMs(state.timeframe);
  const continuityReset =
    state.lastTickT === null || tick.tickAtMs - state.lastTickT > gapBudget;

  const warmedUp = isWarmedUp(rsiState);
  const projected = projectRsi(rsiState, tick.price);

  const observation: Observation = {
    t: tick.tickAtMs,
    rsi: projected,
    price: tick.price,
    warmedUp,
    fresh,
  };

  return {
    state: {
      ...state,
      rsi: rsiState,
      formingBarStart: bucket,
      formingClose: tick.price,
      lastTickT: tick.tickAtMs,
      lastEvaluatedAt: tick.evaluatedAtMs,
      lastObservationIntervalMs:
        state.lastEvaluatedAt === null ? null : tick.evaluatedAtMs - state.lastEvaluatedAt,
      observationCount: state.observationCount + 1,
      continuityResetCount: state.continuityResetCount + (continuityReset && state.lastTickT !== null ? 1 : 0),
    },
    observation,
    rejection: null,
    committedBar,
    continuityReset,
    ageSeconds,
  };
}

/**
 * Whether an observation from this result may be used to release a post-loss
 * lock (§6.5).
 *
 * Deliberately stricter than the crossing's own requirements: a lock is a
 * durable consequence of a real loss, and releasing one on evidence the
 * engine is not certain of would hand back eligibility the user's rule says
 * should still be withheld. Warm-up history, stale data and the first
 * observation after a gap are all refused.
 */
export function isUnlockEligible(result: EngineResult): boolean {
  const obs = result.observation;
  if (obs === null) return false;
  if (!obs.warmedUp || !obs.fresh) return false;
  if (result.continuityReset) return false;
  return obs.rsi !== null && Number.isFinite(obs.rsi);
}

/**
 * Seeds the indicator from closed historical bars, without producing a
 * single entry or unlock (§3.3, §11).
 *
 * This is the only permitted use of history in this strategy besides broker
 * reconciliation: enough recent bars to make RSI meaningful. It commits bars
 * to the RSI state and touches neither the crossing state nor any lock, so
 * warm-up literally cannot signal — not because a flag suppresses it, but
 * because the code path that forms signals is never entered.
 */
export function warmUpFromClosedBars(state: EngineState, closes: readonly number[]): EngineState {
  let rsi = state.rsi;
  for (const close of closes) rsi = commitClosedBar(rsi, close);
  return { ...state, rsi };
}

export interface EngineHealth {
  readonly timeframe: Timeframe;
  readonly rsi: number | null;
  readonly warmedUp: boolean;
  readonly closedBarCount: number;
  readonly barsUntilWarm: number;
  readonly lastTickT: number | null;
  readonly lastObservationIntervalMs: number | null;
  readonly cadenceMet: boolean;
  readonly observationCount: number;
  readonly continuityResetCount: number;
}

/** Dashboard view of one timeframe's engine (§12). */
export function describeHealth(state: EngineState, toleranceMs: number): EngineHealth {
  const needed = SPEC.rsi.period + 1 + SPEC.rsi.warmupBars;
  const interval = state.lastObservationIntervalMs;
  return {
    timeframe: state.timeframe,
    rsi: currentRsi(state.rsi),
    warmedUp: isWarmedUp(state.rsi),
    closedBarCount: state.rsi.closedBarCount,
    barsUntilWarm: Math.max(0, needed - state.rsi.closedBarCount),
    lastTickT: state.lastTickT,
    lastObservationIntervalMs: interval,
    cadenceMet: interval !== null && interval <= SPEC.observation.targetIntervalMs + toleranceMs,
    observationCount: state.observationCount,
    continuityResetCount: state.continuityResetCount,
  };
}

/**
 * Whether a persisted engine state may be resumed (§10).
 *
 * Two independent reasons to refuse. A spec-hash mismatch means the rules
 * changed under it. A persisted clock far ahead of wall clock means the file
 * is wrong rather than the market being early — and that failure is
 * particularly nasty, because a future `lastTickT` rejects every incoming
 * tick as out-of-order, freezing RSI while the loop still reports a healthy
 * cadence. Both cases rebuild from history rather than continuing.
 */
export function isResumable(state: EngineState, nowMs: number): { resumable: boolean; reason: string | null } {
  if (state.specHash !== SPEC_HASH) {
    return {
      resumable: false,
      reason:
        `Persisted state was written under spec hash ${state.specHash}, but the current rules hash to ` +
        `${SPEC_HASH}. Refusing to resume: arming and continuity decisions recorded under different rules ` +
        'cannot be reinterpreted under these ones.',
    };
  }
  if (state.lastTickT !== null && state.lastTickT - nowMs > V2_ENGINE_CLOCK_FUTURE_LIMIT_MS) {
    return {
      resumable: false,
      reason:
        `Persisted clock is ${Math.round((state.lastTickT - nowMs) / 1000)}s ahead of wall clock, beyond what ` +
        'skew can explain. Refusing to resume: every incoming tick would be rejected as out-of-order and RSI ' +
        'would freeze while the loop still reported a healthy cadence.',
    };
  }
  return { resumable: true, reason: null };
}
