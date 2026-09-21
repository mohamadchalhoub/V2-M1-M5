/**
 * The decision gate: where crossings, post-loss locks, occupancy and the
 * schedule meet (§4, §5, §6.3, §9.1).
 *
 * The centrepiece is §6.3 — "an observation that unlocks a direction must
 * not also submit that direction's entry". That is not a hypothetical
 * ordering concern: a SELL lock releases at RSI >= 98.5 and a SELL entry
 * fires at RSI >= 91 from below, so one tick at 99 satisfies both. These
 * tests pin the behaviour down in exactly that overlap.
 */
import { describe, expect, it } from 'vitest';
import { createCrossingState, evaluate as evaluateCrossing, type CrossingState, type Observation } from '../../src/xauusd-m1m5/crossing';
import { decide, type DecisionInput, type OccupancyView } from '../../src/xauusd-m1m5/decision';
import { applyClosure, createLockSet, isLocked, type ClosureOutcome, type LockSet } from '../../src/xauusd-m1m5/locks';
import { evaluateEntryEligibility, type RuntimeGates } from '../../src/xauusd-m1m5/schedule';
import { SPEC_HASH, TIMEFRAMES, type Direction, type Timeframe } from '../../src/xauusd-m1m5/spec';

/** A Wednesday 10:00 Beirut — outside both daily pauses, not a Friday. */
const T0 = Date.UTC(2026, 8, 23, 7, 0, 0);

const OPEN_GATES: RuntimeGates = {
  brokerSessionOpen: true,
  dataFresh: true,
  recoveryComplete: true,
  killSwitchEngaged: false,
  executionBlockers: [],
};

const FREE: OccupancyView = { occupied: false, detail: 'no exposure' };
const OCCUPIED: OccupancyView = { occupied: true, detail: 'position #123 open' };

function obs(t: number, rsi: number): Observation {
  return { t, rsi, price: 4450, warmedUp: true, fresh: true };
}

function input(over: Partial<DecisionInput> & { timeframe: Timeframe; observation: Observation }): DecisionInput {
  return {
    crossingState: createCrossingState(over.timeframe, SPEC_HASH),
    lockSet: createLockSet(SPEC_HASH),
    occupancy: FREE,
    eligibility: evaluateEntryEligibility(over.observation.t, OPEN_GATES),
    unlockEligible: true,
    ...over,
  };
}

/** Advances a crossing state through priming values without going via `decide`. */
function primed(timeframe: Timeframe, rsis: number[], startT: number): { state: CrossingState; t: number } {
  let state = createCrossingState(timeframe, SPEC_HASH);
  let t = startT;
  for (const rsi of rsis) {
    state = evaluateCrossing(state, obs(t, rsi)).state;
    t += 1000;
  }
  return { state, t };
}

function lockedWith(timeframe: Timeframe, direction: Direction, closedAt: number): LockSet {
  const outcome: ClosureOutcome = {
    closureEventId: `evt-${timeframe}-${direction}`,
    positionId: `pos-${timeframe}-${direction}`,
    timeframe,
    direction,
    netRealized: -15,
    fullyClosed: true,
    closedAt,
    closureReason: 'SL',
    rsiAtClosure: 50,
  };
  const out = applyClosure(createLockSet(SPEC_HASH), outcome);
  expect(out.lockActivated).toBe(true);
  return out.set;
}

describe.each(TIMEFRAMES)('§6.3 unlocking is not an entry — %s', (tf: Timeframe) => {
  it('a single observation at 99 releases the SELL lock but does NOT submit', () => {
    // Prime so that 99 would otherwise be a textbook fresh SELL crossing:
    // previous value 90 (< 91), current 99 (>= 91).
    const { state, t } = primed(tf, [50, 90], T0);
    const lockSet = lockedWith(tf, 'SELL', T0 - 60_000);

    const out = decide(input({ timeframe: tf, crossingState: state, lockSet, observation: obs(t, 99) }));

    // The crossing formed...
    expect(out.signal).not.toBeNull();
    expect(out.signal?.direction).toBe('SELL');
    // ...the lock released on the very same observation...
    expect(out.unlocks).toHaveLength(1);
    expect(out.unlocks[0]).toMatchObject({ direction: 'SELL' });
    expect(isLocked(out.lockSet, tf, 'SELL')).toBe(false);
    // ...and nothing was submitted.
    expect(out.candidate).toBeNull();
    expect(out.skipReason).toBe('POST_SELL_LOSS_LOCKOUT');
    expect(out.skipDetail).toMatch(/released it/i);
  });

  it('a single observation at 1.0 releases the BUY lock but does NOT submit', () => {
    const { state, t } = primed(tf, [50, 9], T0);
    const lockSet = lockedWith(tf, 'BUY', T0 - 60_000);

    const out = decide(input({ timeframe: tf, crossingState: state, lockSet, observation: obs(t, 1) }));

    expect(out.signal?.direction).toBe('BUY');
    expect(out.unlocks[0]).toMatchObject({ direction: 'BUY' });
    expect(isLocked(out.lockSet, tf, 'BUY')).toBe(false);
    expect(out.candidate).toBeNull();
    expect(out.skipReason).toBe('POST_BUY_LOSS_LOCKOUT');
  });

  it('after the unlock, a fresh crossing is required — and then it submits', () => {
    const { state, t } = primed(tf, [50, 90], T0);
    const lockSet = lockedWith(tf, 'SELL', T0 - 60_000);

    // Observation 1: unlocks at 99, submits nothing, and consumes the crossing.
    const first = decide(input({ timeframe: tf, crossingState: state, lockSet, observation: obs(t, 99) }));
    expect(first.candidate).toBeNull();
    expect(isLocked(first.lockSet, tf, 'SELL')).toBe(false);

    // Staying high submits nothing: the direction is consumed and disarmed.
    const staying = decide(
      input({ timeframe: tf, crossingState: first.crossingState, lockSet: first.lockSet, observation: obs(t + 1000, 99.5) }),
    );
    expect(staying.signal).toBeNull();
    expect(staying.candidate).toBeNull();

    // Returning below 91 rearms.
    const back = decide(
      input({ timeframe: tf, crossingState: staying.crossingState, lockSet: staying.lockSet, observation: obs(t + 2000, 80) }),
    );
    expect(back.signal).toBeNull();
    expect(back.crossingState.sellArmed).toBe(true);

    // The subsequent fresh crossing now submits.
    const fresh = decide(
      input({ timeframe: tf, crossingState: back.crossingState, lockSet: back.lockSet, observation: obs(t + 3000, 92) }),
    );
    expect(fresh.candidate).not.toBeNull();
    expect(fresh.candidate?.direction).toBe('SELL');
    expect(fresh.skipReason).toBeNull();
  });

  it('a crossing skipped while locked is never replayed after the lock releases', () => {
    const { state, t } = primed(tf, [50, 90], T0);
    const lockSet = lockedWith(tf, 'SELL', T0 - 60_000);

    // A SELL crossing at 92 while locked: skipped and consumed.
    const blocked = decide(input({ timeframe: tf, crossingState: state, lockSet, observation: obs(t, 92) }));
    expect(blocked.skipReason).toBe('POST_SELL_LOSS_LOCKOUT');
    expect(blocked.candidate).toBeNull();
    expect(isLocked(blocked.lockSet, tf, 'SELL')).toBe(true); // 92 is not an unlock value

    // Now unlock on a separate observation at 20.
    const released = decide(
      input({ timeframe: tf, crossingState: blocked.crossingState, lockSet: blocked.lockSet, observation: obs(t + 1000, 20) }),
    );
    expect(isLocked(released.lockSet, tf, 'SELL')).toBe(false);
    // The earlier crossing does not come back.
    expect(released.candidate).toBeNull();
    expect(released.signal).toBeNull();
  });

  it('the other direction is unaffected by an active lock', () => {
    const { state, t } = primed(tf, [50, 9], T0);
    const lockSet = lockedWith(tf, 'SELL', T0 - 60_000); // SELL locked, BUY free

    const out = decide(input({ timeframe: tf, crossingState: state, lockSet, observation: obs(t, 8) }));
    expect(out.candidate?.direction).toBe('BUY');
    expect(out.skipReason).toBeNull();

    // Worth stating explicitly, because it looks surprising at first glance:
    // this same observation ALSO releases the SELL lock. Every BUY entry
    // fires at RSI <= 8.9, and every value <= 8.9 is also <= 25, which is the
    // SELL lock's low unlock arm — so a BUY entry on a timeframe whose SELL
    // is locked always releases that lock as a side effect. That is correct
    // under §6.1: the unlock condition is a property of RSI alone, not of
    // what else the observation happened to do. What matters is that the
    // release is not itself an entry, which the next assertion pins down.
    expect(out.unlocks.map((u) => u.direction)).toEqual(['SELL']);
    expect(isLocked(out.lockSet, tf, 'SELL')).toBe(false);
    expect(out.candidate?.direction).not.toBe('SELL');
  });

  it('a SELL lock released as a side effect of a BUY entry still needs a fresh SELL crossing', () => {
    const { state, t } = primed(tf, [50, 9], T0);
    const lockSet = lockedWith(tf, 'SELL', T0 - 60_000);

    // The BUY entry above releases the SELL lock.
    const buy = decide(input({ timeframe: tf, crossingState: state, lockSet, observation: obs(t, 8) }));
    expect(isLocked(buy.lockSet, tf, 'SELL')).toBe(false);

    // RSI climbing straight back through 91 is a genuine fresh crossing, and
    // only now — on a later observation — may SELL submit.
    const rearm = decide(
      input({ timeframe: tf, crossingState: buy.crossingState, lockSet: buy.lockSet, observation: obs(t + 1000, 80) }),
    );
    const sell = decide(
      input({ timeframe: tf, crossingState: rearm.crossingState, lockSet: rearm.lockSet, observation: obs(t + 2000, 92) }),
    );
    expect(sell.candidate?.direction).toBe('SELL');
  });
});

describe('§4 occupancy', () => {
  it.each(TIMEFRAMES)('%s skips and consumes a signal while occupied', (tf: Timeframe) => {
    const { state, t } = primed(tf, [50, 90], T0);
    const out = decide(input({ timeframe: tf, crossingState: state, occupancy: OCCUPIED, observation: obs(t, 92) }));

    expect(out.signal).not.toBeNull();
    expect(out.candidate).toBeNull();
    expect(out.skipReason).toBe('TIMEFRAME_OCCUPIED');
    expect(out.skipDetail).toMatch(/never executed later/i);
    // Consumed: the direction is disarmed even though nothing was submitted.
    expect(out.crossingState.sellArmed).toBe(false);
  });

  it('a signal skipped for occupancy is not replayed when the slot frees', () => {
    const { state, t } = primed('M1', [50, 90], T0);
    const blocked = decide(input({ timeframe: 'M1', crossingState: state, occupancy: OCCUPIED, observation: obs(t, 92) }));
    expect(blocked.skipReason).toBe('TIMEFRAME_OCCUPIED');

    // Slot frees; RSI is still above 91. Nothing re-fires.
    const freed = decide(
      input({ timeframe: 'M1', crossingState: blocked.crossingState, occupancy: FREE, observation: obs(t + 1000, 93) }),
    );
    expect(freed.signal).toBeNull();
    expect(freed.candidate).toBeNull();
  });

  it('occupancy on one timeframe does not block the other', () => {
    const m1 = primed('M1', [50, 90], T0);
    const m5 = primed('M5', [50, 90], T0);

    const m1Out = decide(input({ timeframe: 'M1', crossingState: m1.state, occupancy: OCCUPIED, observation: obs(m1.t, 92) }));
    const m5Out = decide(input({ timeframe: 'M5', crossingState: m5.state, occupancy: FREE, observation: obs(m5.t, 92) }));

    expect(m1Out.candidate).toBeNull();
    expect(m5Out.candidate).not.toBeNull();
  });
});

describe('§9.1 schedule gating', () => {
  it('a signal during the afternoon pause is skipped and consumed, not queued', () => {
    // 15:00 Beirut on a Wednesday is inside 14:00–19:00.
    const pausedT = Date.UTC(2026, 8, 23, 12, 0, 0);
    const { state, t } = primed('M1', [50, 90], pausedT);
    const eligibility = evaluateEntryEligibility(t, OPEN_GATES);
    expect(eligibility.reason).toBe('AFTERNOON_PAUSE');

    const out = decide(input({ timeframe: 'M1', crossingState: state, eligibility, observation: obs(t, 92) }));
    expect(out.signal).not.toBeNull();
    expect(out.candidate).toBeNull();
    expect(out.skipReason).toBe('SCHEDULE_BLOCKED');
    expect(out.skipDetail).toMatch(/never queued/i);
    expect(out.crossingState.sellArmed).toBe(false);
  });

  it('lock processing continues during a pause', () => {
    const pausedT = Date.UTC(2026, 8, 23, 12, 0, 0);
    const lockSet = lockedWith('M1', 'SELL', pausedT - 60_000);
    const eligibility = evaluateEntryEligibility(pausedT, OPEN_GATES);
    expect(eligibility.eligible).toBe(false);

    const out = decide(input({ timeframe: 'M1', lockSet, eligibility, observation: obs(pausedT, 20) }));
    // Unlock happened even though entries are blocked.
    expect(out.unlocks).toHaveLength(1);
    expect(isLocked(out.lockSet, 'M1', 'SELL')).toBe(false);
  });
});

describe('gate precedence', () => {
  it('reports the post-loss lock ahead of occupancy and schedule when several apply', () => {
    const pausedT = Date.UTC(2026, 8, 23, 12, 0, 0);
    const { state, t } = primed('M1', [50, 90], pausedT);
    const lockSet = lockedWith('M1', 'SELL', pausedT - 60_000);
    const eligibility = evaluateEntryEligibility(t, OPEN_GATES);

    const out = decide(
      input({ timeframe: 'M1', crossingState: state, lockSet, occupancy: OCCUPIED, eligibility, observation: obs(t, 92) }),
    );
    expect(out.skipReason).toBe('POST_SELL_LOSS_LOCKOUT');
  });

  it('reports occupancy ahead of the schedule', () => {
    const pausedT = Date.UTC(2026, 8, 23, 12, 0, 0);
    const { state, t } = primed('M1', [50, 90], pausedT);
    const eligibility = evaluateEntryEligibility(t, OPEN_GATES);

    const out = decide(input({ timeframe: 'M1', crossingState: state, occupancy: OCCUPIED, eligibility, observation: obs(t, 92) }));
    expect(out.skipReason).toBe('TIMEFRAME_OCCUPIED');
  });
});

describe('§6.5 unlock eligibility', () => {
  it('an observation across a gap cannot unlock', () => {
    const lockSet = lockedWith('M1', 'SELL', T0 - 60_000);
    const out = decide(input({ timeframe: 'M1', lockSet, unlockEligible: false, observation: obs(T0, 10) }));
    expect(out.unlocks).toHaveLength(0);
    expect(isLocked(out.lockSet, 'M1', 'SELL')).toBe(true);
  });
});
