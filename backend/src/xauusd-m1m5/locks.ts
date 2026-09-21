/**
 * The four independent post-loss directional locks (§6).
 *
 *   M1 SELL   M1 BUY   M5 SELL   M5 BUY
 *
 * Each is locked by a broker-confirmed, fully-closed, negative realized
 * result on a position that THIS strategy owned on that timeframe in that
 * direction, and each unlocks only on the owning timeframe's own RSI:
 *
 *   SELL lock releases on  RSI <= 25   OR  RSI >= 98.5
 *   BUY  lock releases on  RSI >= 75   OR  RSI <=  1.5
 *
 * Equality counts, in all four cases, at full precision.
 *
 * ## 98.5 and 1.5
 *
 * These two values have NO standalone entry meaning in this strategy — §3.4
 * removed the extreme entry setups completely. They survive here, and only
 * here, as unlock conditions. Every surface that displays them must label
 * them as post-loss unlock thresholds and never as entry thresholds (§12).
 *
 * ## Unlocking is not an entry
 *
 * The single most dangerous confusion this module exists to prevent is
 * treating an unlock as a trade. §6.3 is explicit: unlocking changes
 * eligibility only. It must not submit an order, replay a crossing that was
 * skipped while locked, or reuse a consumed signal.
 *
 * There is a real overlap that makes this more than theoretical. A SELL lock
 * releases at RSI >= 98.5, and a SELL entry crossing fires at RSI >= 91 from
 * below — so one single observation at, say, RSI 99 can simultaneously
 * satisfy the unlock condition AND form a fresh SELL crossing. Submitting on
 * that observation would be exactly the behaviour §6.3 forbids.
 *
 * `evaluateObservation` therefore reports `wasActiveAtObservationStart`, and
 * the decision path treats that as blocking for the whole observation. The
 * direction becomes eligible only from the NEXT observation onward, so a
 * genuine fresh crossing is required afterwards: after a SELL unlock at
 * 98.5, RSI must return below 91 and then cross up through it again.
 *
 * ## Ordering and idempotency
 *
 * Closure events and market observations are applied in a defined order
 * (§6.5). An unlock is only ever recognised from an observation strictly
 * AFTER the lock's activation instant, so an RSI event that preceded the
 * losing closure can never release the lock it caused. Closure events carry
 * identities and are recorded, so a duplicate broker report is a no-op and
 * cannot relock a lifecycle that has already been legitimately unlocked
 * (§6.4, §15.2).
 */
import {
  SPEC,
  type Direction,
  type Timeframe,
  TIMEFRAMES,
  DIRECTIONS,
} from './spec';
import { directionalKey } from './safety-constants';

/** Skip reasons recorded when a lock blocks a crossing (§6.1, §6.2). */
export const POST_SELL_LOSS_LOCKOUT = 'POST_SELL_LOSS_LOCKOUT';
export const POST_BUY_LOSS_LOCKOUT = 'POST_BUY_LOSS_LOCKOUT';

export function lockoutReasonFor(direction: Direction): string {
  return direction === 'SELL' ? POST_SELL_LOSS_LOCKOUT : POST_BUY_LOSS_LOCKOUT;
}

/**
 * The broker-confirmed outcome of a fully closed position, as reconciled
 * from all of its attributable deals (§6.4).
 */
export interface ClosureOutcome {
  /** Stable identity of the closure event, for idempotency. */
  readonly closureEventId: string;
  /** Broker position/order identity that closed. */
  readonly positionId: string;
  readonly timeframe: Timeframe;
  readonly direction: Direction;
  /**
   * Net realized result in account currency, aggregating every attributable
   * deal of this position INCLUDING commission, swap and fees (§6.4). This
   * is a broker-confirmed figure, never floating P&L.
   */
  readonly netRealized: number;
  /** True only once every attributable deal is reconciled and exposure is zero. */
  readonly fullyClosed: boolean;
  /** Broker-confirmed closure timestamp, UTC ms. */
  readonly closedAt: number;
  /** Why it closed — TP, SL, Friday liquidation, remediation, user close. */
  readonly closureReason: string;
  /** RSI of the owning timeframe at closure, recorded as evidence. */
  readonly rsiAtClosure: number | null;
}

export type LossClassification = 'LOSS' | 'WIN' | 'ZERO' | 'UNRESOLVED';

/**
 * §6.4 — what counts as a loss.
 *
 * A negative net realized result activates the lock regardless of closure
 * reason: SL, Friday liquidation, protection remediation and a
 * user-authorized close are all treated identically. A positive result does
 * not. A ZERO result does not — it is neither a win nor a loss, and §13.1
 * requires it to be reported separately rather than folded into either
 * bucket.
 *
 * Anything not yet fully reconciled is UNRESOLVED and must not be
 * classified, because acting on a partial view could either miss a lock or
 * invent one.
 */
export function classifyClosure(outcome: Pick<ClosureOutcome, 'fullyClosed' | 'netRealized'>): LossClassification {
  if (!outcome.fullyClosed || !Number.isFinite(outcome.netRealized)) return 'UNRESOLVED';
  if (outcome.netRealized < 0) return 'LOSS';
  if (outcome.netRealized > 0) return 'WIN';
  return 'ZERO';
}

export interface UnlockEvidence {
  /** Which arm of the OR released it. */
  readonly condition: 'RSI_AT_OR_BELOW' | 'RSI_AT_OR_ABOVE';
  readonly threshold: number;
  /** Full-precision RSI that satisfied it. */
  readonly rsi: number;
  /** UTC ms of the observation that released it. */
  readonly at: number;
}

export interface LockRecord {
  readonly timeframe: Timeframe;
  readonly direction: Direction;
  readonly active: boolean;
  /** Identity of the losing position that activated it (§6.5). */
  readonly losingPositionId: string | null;
  readonly losingClosureEventId: string | null;
  /** Broker-confirmed net realized loss that caused it. */
  readonly netRealized: number | null;
  /** Broker-confirmed closure timestamp of the losing position. */
  readonly closedAt: number | null;
  /** When the lock itself was activated. Unlocks must be strictly after this. */
  readonly activatedAt: number | null;
  /** RSI of the owning timeframe at the moment of the losing closure. */
  readonly rsiAtActivation: number | null;
  /** The most recent unlock, retained after release as audit evidence. */
  readonly lastUnlock: UnlockEvidence | null;
}

export interface LockSet {
  readonly specHash: string;
  /** Keyed `"M1:SELL"`, `"M1:BUY"`, `"M5:SELL"`, `"M5:BUY"`. */
  readonly locks: Readonly<Record<string, LockRecord>>;
  /**
   * Closure event identities already applied. This is what makes duplicate
   * broker reports idempotent (§6.4): a repeated report of the same closure
   * cannot reactivate a lock that has since been legitimately unlocked.
   */
  readonly processedClosureEventIds: readonly string[];
}

function emptyLock(timeframe: Timeframe, direction: Direction): LockRecord {
  return {
    timeframe,
    direction,
    active: false,
    losingPositionId: null,
    losingClosureEventId: null,
    netRealized: null,
    closedAt: null,
    activatedAt: null,
    rsiAtActivation: null,
    lastUnlock: null,
  };
}

export function createLockSet(specHash: string): LockSet {
  const locks: Record<string, LockRecord> = {};
  for (const tf of TIMEFRAMES) {
    for (const dir of DIRECTIONS) {
      locks[directionalKey(tf, dir)] = emptyLock(tf, dir);
    }
  }
  return { specHash, locks, processedClosureEventIds: [] };
}

export function getLock(set: LockSet, timeframe: Timeframe, direction: Direction): LockRecord {
  return set.locks[directionalKey(timeframe, direction)] ?? emptyLock(timeframe, direction);
}

export function isLocked(set: LockSet, timeframe: Timeframe, direction: Direction): boolean {
  return getLock(set, timeframe, direction).active;
}

/**
 * How many closure identities to retain. Bounded so the persisted set cannot
 * grow without limit, generous enough that a duplicate report arriving days
 * late is still recognised as a duplicate.
 */
const MAX_PROCESSED_CLOSURE_IDS = 2_000;

export interface ClosureApplication {
  readonly set: LockSet;
  readonly classification: LossClassification;
  /** True when this closure activated a lock. */
  readonly lockActivated: boolean;
  /** True when the event was a duplicate and changed nothing. */
  readonly duplicate: boolean;
  readonly detail: string;
}

/**
 * Applies a broker-confirmed closure (§6.1, §6.2, §6.4).
 *
 * Only a fully closed, negative, strategy-owned position of this timeframe
 * and direction activates a lock. A partial closure, an unconfirmed close
 * request, a rejected entry, a skipped signal or a foreign position must
 * never reach this function at all — ownership and reconciliation filter
 * those upstream — but the `fullyClosed` and classification checks here are
 * a second line of defence.
 */
export function applyClosure(set: LockSet, outcome: ClosureOutcome): ClosureApplication {
  if (set.processedClosureEventIds.includes(outcome.closureEventId)) {
    return {
      set,
      classification: classifyClosure(outcome),
      lockActivated: false,
      duplicate: true,
      detail:
        `Closure ${outcome.closureEventId} was already applied; ignored. A repeated broker report ` +
        'never reactivates a lock whose lifecycle has already been processed.',
    };
  }

  const classification = classifyClosure(outcome);
  const remember = [...set.processedClosureEventIds, outcome.closureEventId].slice(-MAX_PROCESSED_CLOSURE_IDS);

  if (classification !== 'LOSS') {
    return {
      set: { ...set, processedClosureEventIds: remember },
      classification,
      lockActivated: false,
      duplicate: false,
      detail:
        classification === 'UNRESOLVED'
          ? 'Closure is not fully reconciled; no lock decision taken until every attributable deal resolves.'
          : `Net realized ${outcome.netRealized} classified ${classification}; no post-loss lock activated.`,
    };
  }

  const key = directionalKey(outcome.timeframe, outcome.direction);
  const activatedAt = outcome.closedAt;

  return {
    set: {
      ...set,
      processedClosureEventIds: remember,
      locks: {
        ...set.locks,
        [key]: {
          timeframe: outcome.timeframe,
          direction: outcome.direction,
          active: true,
          losingPositionId: outcome.positionId,
          losingClosureEventId: outcome.closureEventId,
          netRealized: outcome.netRealized,
          closedAt: outcome.closedAt,
          activatedAt,
          rsiAtActivation: outcome.rsiAtClosure,
          // A previous unlock is deliberately cleared: this is a NEW lock
          // lifecycle, and retaining the old release as though it applied
          // would misrepresent the audit trail.
          lastUnlock: null,
        },
      },
    },
    classification,
    lockActivated: true,
    duplicate: false,
    detail:
      `${outcome.timeframe} ${outcome.direction} locked after broker-confirmed loss of ${outcome.netRealized} ` +
      `on position ${outcome.positionId} (${outcome.closureReason}). ${describeUnlockCondition(outcome.direction)}`,
  };
}

export interface LockObservationResult {
  readonly set: LockSet;
  /**
   * True when this lock was ACTIVE as the observation arrived.
   *
   * This — not the post-observation state — is what the decision path must
   * consult. §6.3: an observation that unlocks a direction must not also
   * submit that direction's entry, and RSI >= 98.5 can satisfy both a SELL
   * unlock and a fresh SELL crossing at once.
   */
  readonly wasActiveAtObservationStart: boolean;
  /** True when this observation released the lock. */
  readonly unlocked: boolean;
  readonly evidence: UnlockEvidence | null;
}

/**
 * Evaluates one timeframe's observation against that timeframe's two locks
 * (§6.1, §6.2, §6.5).
 *
 * `eligible` must be false for warm-up observations, stale observations and
 * anything read across an unobserved gap: §6.5 forbids guessing an unlock
 * through a gap or using warm-up history to unlock. A lock simply stays
 * active until a genuine, fresh, in-continuity observation satisfies it.
 */
export function evaluateObservation(
  set: LockSet,
  timeframe: Timeframe,
  direction: Direction,
  rsi: number | null,
  at: number,
  eligible: boolean,
): LockObservationResult {
  const lock = getLock(set, timeframe, direction);
  const wasActive = lock.active;

  if (!wasActive) {
    return { set, wasActiveAtObservationStart: false, unlocked: false, evidence: null };
  }
  if (!eligible || rsi === null || !Number.isFinite(rsi)) {
    return { set, wasActiveAtObservationStart: true, unlocked: false, evidence: null };
  }

  // §6.5 event ordering — an RSI observation that PRECEDES the losing
  // closure can never release the lock that closure caused. Without this, a
  // late-arriving broker closure report could be unlocked by market data the
  // engine had already seen before the loss was even known.
  if (lock.activatedAt !== null && at <= lock.activatedAt) {
    return { set, wasActiveAtObservationStart: true, unlocked: false, evidence: null };
  }

  const evidence = unlockEvidenceFor(direction, rsi, at);
  if (evidence === null) {
    return { set, wasActiveAtObservationStart: true, unlocked: false, evidence: null };
  }

  const key = directionalKey(timeframe, direction);
  return {
    set: {
      ...set,
      locks: {
        ...set.locks,
        // Everything about the lifecycle is retained except `active`, so the
        // dashboard and audit trail can still show what caused the lock and
        // what released it (§6.5, §12).
        [key]: { ...lock, active: false, lastUnlock: evidence },
      },
    },
    wasActiveAtObservationStart: true,
    unlocked: true,
    evidence,
  };
}

/**
 * The unlock test itself, at full precision, equality counting (§6.1, §6.2).
 * Returns which arm of the OR was satisfied, or null.
 */
export function unlockEvidenceFor(direction: Direction, rsi: number, at: number): UnlockEvidence | null {
  if (direction === 'SELL') {
    const { rsiAtOrBelow, rsiAtOrAbove } = SPEC.postLossUnlock.sell;
    if (rsi <= rsiAtOrBelow) return { condition: 'RSI_AT_OR_BELOW', threshold: rsiAtOrBelow, rsi, at };
    if (rsi >= rsiAtOrAbove) return { condition: 'RSI_AT_OR_ABOVE', threshold: rsiAtOrAbove, rsi, at };
    return null;
  }
  const { rsiAtOrAbove, rsiAtOrBelow } = SPEC.postLossUnlock.buy;
  if (rsi >= rsiAtOrAbove) return { condition: 'RSI_AT_OR_ABOVE', threshold: rsiAtOrAbove, rsi, at };
  if (rsi <= rsiAtOrBelow) return { condition: 'RSI_AT_OR_BELOW', threshold: rsiAtOrBelow, rsi, at };
  return null;
}

/**
 * The exact wording §12 requires on the dashboard. These strings describe
 * UNLOCK conditions; 98.5 and 1.5 must never be presented as entry levels.
 */
export function describeUnlockCondition(direction: Direction): string {
  if (direction === 'SELL') {
    const { rsiAtOrBelow, rsiAtOrAbove } = SPEC.postLossUnlock.sell;
    return `Waiting for RSI <=${rsiAtOrBelow} OR RSI >=${rsiAtOrAbove}.`;
  }
  const { rsiAtOrAbove, rsiAtOrBelow } = SPEC.postLossUnlock.buy;
  return `Waiting for RSI >=${rsiAtOrAbove} OR RSI <=${rsiAtOrBelow}.`;
}

/**
 * §13 — an unlock notification must state that other directions and
 * timeframes are unaffected by THIS lock, while remaining subject to their
 * own gates.
 */
export function describeLockScope(timeframe: Timeframe, direction: Direction): string {
  const otherDirection: Direction = direction === 'SELL' ? 'BUY' : 'SELL';
  const otherTimeframe: Timeframe = timeframe === 'M1' ? 'M5' : 'M1';
  return (
    `This lock affects ${timeframe} ${direction} only. ${timeframe} ${otherDirection}, ` +
    `${otherTimeframe} ${direction} and ${otherTimeframe} ${otherDirection} are unaffected by it, ` +
    'though each remains subject to its own locks, occupancy, schedule and risk gates.'
  );
}

/** Whether a persisted lock set may still be used under the current rules. */
export function isLockSetCompatible(set: LockSet, specHash: string): boolean {
  return set.specHash === specHash;
}
