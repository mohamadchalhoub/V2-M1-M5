/**
 * One timeframe's per-observation decision (§3, §4, §5, §6, §9).
 *
 * Pure, synchronous, and deliberately the ONLY place where a crossing, a
 * post-loss lock, occupancy and the schedule meet. Keeping the whole gate in
 * one pure function is what makes §15's boundary cases testable without a
 * broker, a database or a clock, and it is what makes the ordering below a
 * property of the code rather than a convention that some future call site
 * might not follow.
 *
 * ## Ordering, and why it is this order
 *
 * 1. **Locks are read BEFORE the observation is applied.** The lock's state
 *    as the observation ARRIVED is what governs this observation. §6.3: an
 *    observation that unlocks a direction must not also submit that
 *    direction's entry — and the overlap is real, because RSI >= 98.5
 *    releases a SELL lock while RSI >= 91 from below forms a SELL crossing,
 *    so a single tick at 99 can do both.
 *
 * 2. **The crossing is evaluated and CONSUMED regardless of outcome.** §4
 *    and §5 require a signal that cannot be acted on to be recorded, skipped
 *    and consumed — never queued, never replayed when the slot frees or the
 *    lock releases. Consumption happens inside `crossing.evaluate`, so no
 *    path through this function can accidentally preserve a signal.
 *
 * 3. **Unlock is applied to the lock set whatever happened to the signal.**
 *    Eligibility changes even on an observation whose signal was skipped;
 *    that is the whole point of §6.3.
 *
 * Note that the skip reasons are evaluated in a fixed precedence so the
 * recorded reason is deterministic. A signal blocked by several gates at
 * once reports the post-loss lock first, because that is the gate with the
 * longest consequence and the one the operator most needs explained.
 */
import {
  evaluate as evaluateCrossing,
  type CrossingEvaluation,
  type CrossingSignal,
  type CrossingState,
  type Observation,
} from './crossing';
import {
  evaluateObservation as evaluateLockObservation,
  lockoutReasonFor,
  type LockSet,
  type UnlockEvidence,
} from './locks';
import type { EntryEligibility } from './schedule';
import type { Direction, Timeframe } from './spec';

export type SkipReason =
  /** §6 — this timeframe+direction is locked by a prior realized loss. */
  | 'POST_SELL_LOSS_LOCKOUT'
  | 'POST_BUY_LOSS_LOCKOUT'
  /** §4 — this timeframe already holds an active, pending or uncertain exposure. */
  | 'TIMEFRAME_OCCUPIED'
  /** §9 — a schedule or runtime gate blocks new entries. */
  | 'SCHEDULE_BLOCKED';

export interface OccupancyView {
  /**
   * True when this timeframe holds an active, pending or uncertain exposure
   * (§4). "Uncertain" counts deliberately: an unreconciled submission may
   * already be a position at the broker, and treating it as free would risk
   * a second one.
   */
  readonly occupied: boolean;
  /** Human detail for the audit record and dashboard. */
  readonly detail: string;
}

export interface DecisionInput {
  readonly timeframe: Timeframe;
  readonly crossingState: CrossingState;
  readonly lockSet: LockSet;
  readonly observation: Observation;
  readonly occupancy: OccupancyView;
  readonly eligibility: EntryEligibility;
  /**
   * Whether this observation may be used to release a lock (§6.5). False for
   * warm-up observations, stale observations and the first observation after
   * a continuity gap — none of which may fabricate an unlock.
   */
  readonly unlockEligible: boolean;
}

export interface DecisionOutput {
  readonly crossingState: CrossingState;
  readonly lockSet: LockSet;
  /** The crossing formed by this observation, if any. Already consumed. */
  readonly signal: CrossingSignal | null;
  /** Set when the signal may be submitted, subject to downstream risk and quote checks. */
  readonly candidate: CrossingSignal | null;
  /** Set when a signal formed but cannot be acted on. */
  readonly skipReason: SkipReason | null;
  readonly skipDetail: string | null;
  /** Unlocks applied by this observation, for notification and audit (§13). */
  readonly unlocks: readonly { direction: Direction; evidence: UnlockEvidence }[];
  /** Diagnostic passthrough from the crossing evaluation. */
  readonly crossing: CrossingEvaluation;
}

export function decide(input: DecisionInput): DecisionOutput {
  const { timeframe, observation, occupancy, eligibility } = input;

  // ---- 1. Lock state as the observation ARRIVES, before anything is applied.
  const sellLock = evaluateLockObservation(
    input.lockSet,
    timeframe,
    'SELL',
    observation.rsi,
    observation.t,
    input.unlockEligible,
  );
  const buyLock = evaluateLockObservation(
    sellLock.set,
    timeframe,
    'BUY',
    observation.rsi,
    observation.t,
    input.unlockEligible,
  );
  const lockSet = buyLock.set;

  const lockedAtArrival: Record<Direction, boolean> = {
    SELL: sellLock.wasActiveAtObservationStart,
    BUY: buyLock.wasActiveAtObservationStart,
  };

  const unlocks: { direction: Direction; evidence: UnlockEvidence }[] = [];
  if (sellLock.unlocked && sellLock.evidence) unlocks.push({ direction: 'SELL', evidence: sellLock.evidence });
  if (buyLock.unlocked && buyLock.evidence) unlocks.push({ direction: 'BUY', evidence: buyLock.evidence });

  // ---- 2. Crossing. Consumed here whatever happens next.
  const crossing = evaluateCrossing(input.crossingState, observation);
  const signal = crossing.signal;

  const base = {
    crossingState: crossing.state,
    lockSet,
    signal,
    unlocks,
    crossing,
  };

  if (signal === null) {
    return { ...base, candidate: null, skipReason: null, skipDetail: null };
  }

  // ---- 3. Gates, in fixed precedence.
  if (lockedAtArrival[signal.direction]) {
    const reason = lockoutReasonFor(signal.direction) as SkipReason;
    const releasedNow = unlocks.some((u) => u.direction === signal.direction);
    return {
      ...base,
      candidate: null,
      skipReason: reason,
      skipDetail: releasedNow
        ? `${timeframe} ${signal.direction} was locked when this observation arrived and this same observation ` +
          'released it. Unlocking changes eligibility only and never submits an order, so this crossing is ' +
          'skipped and consumed; a subsequent fresh crossing is required.'
        : `${timeframe} ${signal.direction} is locked by a prior broker-confirmed realized loss. The crossing ` +
          'is recorded, skipped and consumed — it is never queued for when the lock releases.',
    };
  }

  if (occupancy.occupied) {
    return {
      ...base,
      candidate: null,
      skipReason: 'TIMEFRAME_OCCUPIED',
      skipDetail:
        `${timeframe} already holds an active, pending or uncertain exposure (${occupancy.detail}). ` +
        'The crossing is recorded, skipped and consumed — it is never executed later when the position closes.',
    };
  }

  if (!eligibility.eligible) {
    return {
      ...base,
      candidate: null,
      skipReason: 'SCHEDULE_BLOCKED',
      skipDetail:
        `${eligibility.detail} The crossing is recorded, skipped and consumed — it is never queued for ` +
        'the end of the pause or the reopening.',
    };
  }

  return { ...base, candidate: signal, skipReason: null, skipDetail: null };
}
