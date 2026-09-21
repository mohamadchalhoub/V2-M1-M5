/**
 * §15.2 — the four post-loss directional locks, on both timeframes and in
 * both directions.
 *
 * The cases that matter most here are the negative ones: the things that
 * must NOT activate a lock, must NOT unlock one, and must NOT submit an
 * order. A lock that activates too eagerly merely stops trading; a lock that
 * releases when it should not, or that submits on the observation that
 * releases it, trades against the user's explicit rule.
 */
import { describe, expect, it } from 'vitest';
import {
  applyClosure,
  classifyClosure,
  createLockSet,
  describeUnlockCondition,
  evaluateObservation,
  getLock,
  isLocked,
  lockoutReasonFor,
  POST_BUY_LOSS_LOCKOUT,
  POST_SELL_LOSS_LOCKOUT,
  unlockEvidenceFor,
  type ClosureOutcome,
  type LockSet,
} from '../../src/xauusd-m1m5/locks';
import { DIRECTIONS, SPEC, SPEC_HASH, TIMEFRAMES, type Direction, type Timeframe } from '../../src/xauusd-m1m5/spec';

const T0 = Date.UTC(2026, 8, 21, 10, 0, 0);

function closure(
  timeframe: Timeframe,
  direction: Direction,
  netRealized: number,
  overrides: Partial<ClosureOutcome> = {},
): ClosureOutcome {
  return {
    closureEventId: `evt-${timeframe}-${direction}-${netRealized}`,
    positionId: `pos-${timeframe}-${direction}`,
    timeframe,
    direction,
    netRealized,
    fullyClosed: true,
    closedAt: T0,
    closureReason: 'SL',
    rsiAtClosure: 50,
    ...overrides,
  };
}

/** Locks a given timeframe+direction with a confirmed loss and returns the set. */
function lockedSet(timeframe: Timeframe, direction: Direction): LockSet {
  const out = applyClosure(createLockSet(SPEC_HASH), closure(timeframe, direction, -12.5));
  expect(out.lockActivated).toBe(true);
  return out.set;
}

describe('§6.4 what counts as a loss', () => {
  it.each([
    ['negative', -0.01, 'LOSS'],
    ['positive', 0.01, 'WIN'],
    ['exactly zero', 0, 'ZERO'],
  ])('classifies a %s fully-closed result as %s', (_label, net, expected) => {
    expect(classifyClosure({ fullyClosed: true, netRealized: net })).toBe(expected);
  });

  it('classifies a not-fully-closed position as UNRESOLVED regardless of sign', () => {
    expect(classifyClosure({ fullyClosed: false, netRealized: -100 })).toBe('UNRESOLVED');
    expect(classifyClosure({ fullyClosed: false, netRealized: 100 })).toBe('UNRESOLVED');
  });

  it('only a negative fully-closed result activates a lock', () => {
    const base = createLockSet(SPEC_HASH);
    expect(applyClosure(base, closure('M1', 'SELL', -5)).lockActivated).toBe(true);
    expect(applyClosure(base, closure('M1', 'SELL', 5)).lockActivated).toBe(false);
    expect(applyClosure(base, closure('M1', 'SELL', 0)).lockActivated).toBe(false);
    expect(applyClosure(base, closure('M1', 'SELL', -5, { fullyClosed: false })).lockActivated).toBe(false);
  });

  it('a partial closure does not prematurely finalize the outcome', () => {
    const out = applyClosure(createLockSet(SPEC_HASH), closure('M5', 'BUY', -30, { fullyClosed: false }));
    expect(out.classification).toBe('UNRESOLVED');
    expect(out.lockActivated).toBe(false);
    expect(isLocked(out.set, 'M5', 'BUY')).toBe(false);
    expect(out.detail).toMatch(/not fully reconciled/i);
  });

  it('activates regardless of closure reason', () => {
    for (const reason of ['SL', 'FRIDAY_LIQUIDATION', 'PROTECTION_REMEDIATION', 'USER_AUTHORIZED_CLOSE', 'TP']) {
      const out = applyClosure(createLockSet(SPEC_HASH), closure('M1', 'SELL', -1, { closureReason: reason }));
      expect(out.lockActivated, `closure reason ${reason}`).toBe(true);
    }
  });

  it('records the full activation evidence required by §6.5', () => {
    const set = applyClosure(
      createLockSet(SPEC_HASH),
      closure('M5', 'SELL', -42.75, { positionId: 'pos-9', closedAt: T0 + 500, rsiAtClosure: 63.25 }),
    ).set;
    expect(getLock(set, 'M5', 'SELL')).toMatchObject({
      active: true,
      losingPositionId: 'pos-9',
      netRealized: -42.75,
      closedAt: T0 + 500,
      activatedAt: T0 + 500,
      rsiAtActivation: 63.25,
    });
  });
});

describe('§6.4 idempotency of closure reports', () => {
  it('a duplicate closure report changes nothing', () => {
    const first = applyClosure(createLockSet(SPEC_HASH), closure('M1', 'BUY', -7));
    const second = applyClosure(first.set, closure('M1', 'BUY', -7));
    expect(second.duplicate).toBe(true);
    expect(second.lockActivated).toBe(false);
    expect(second.set).toBe(first.set);
  });

  it('a duplicate report cannot relock a lifecycle that has already unlocked', () => {
    const locked = lockedSet('M1', 'BUY');
    // Unlock it legitimately at RSI 75.
    const released = evaluateObservation(locked, 'M1', 'BUY', 75, T0 + 10_000, true);
    expect(released.unlocked).toBe(true);
    expect(isLocked(released.set, 'M1', 'BUY')).toBe(false);

    // The broker re-reports the very same closure.
    const replay = applyClosure(released.set, closure('M1', 'BUY', -12.5));
    expect(replay.duplicate).toBe(true);
    expect(isLocked(replay.set, 'M1', 'BUY')).toBe(false);
  });

  it('a genuinely new loss after an unlock does activate a fresh lifecycle', () => {
    const locked = lockedSet('M5', 'SELL');
    const released = evaluateObservation(locked, 'M5', 'SELL', 25, T0 + 10_000, true);
    expect(released.unlocked).toBe(true);

    const again = applyClosure(released.set, closure('M5', 'SELL', -3, { closureEventId: 'evt-new', closedAt: T0 + 20_000 }));
    expect(again.lockActivated).toBe(true);
    // A new lifecycle clears the old release rather than presenting it as current.
    expect(getLock(again.set, 'M5', 'SELL').lastUnlock).toBeNull();
  });
});

describe.each(TIMEFRAMES)('§6.1/§6.2 unlock conditions — %s', (tf: Timeframe) => {
  describe('SELL lock releases on RSI <= 25 OR RSI >= 98.5', () => {
    it.each([
      ['well below the low arm', 10, true],
      ['exactly at the low arm', 25, true],
      ['just above the low arm', 25.0000001, false],
      ['mid range', 60, false],
      ['just below the high arm', 98.4999999, false],
      ['exactly at the high arm', 98.5, true],
      ['well above the high arm', 99.9, true],
    ])('%s (RSI %s) -> unlocked=%s', (_label, rsi, expected) => {
      const out = evaluateObservation(lockedSet(tf, 'SELL'), tf, 'SELL', rsi as number, T0 + 5000, true);
      expect(out.unlocked).toBe(expected);
      expect(isLocked(out.set, tf, 'SELL')).toBe(!expected);
    });
  });

  describe('BUY lock releases on RSI >= 75 OR RSI <= 1.5', () => {
    it.each([
      ['well above the high arm', 90, true],
      ['exactly at the high arm', 75, true],
      ['just below the high arm', 74.9999999, false],
      ['mid range', 40, false],
      ['just above the low arm', 1.5000001, false],
      ['exactly at the low arm', 1.5, true],
      ['well below the low arm', 0.2, true],
    ])('%s (RSI %s) -> unlocked=%s', (_label, rsi, expected) => {
      const out = evaluateObservation(lockedSet(tf, 'BUY'), tf, 'BUY', rsi as number, T0 + 5000, true);
      expect(out.unlocked).toBe(expected);
      expect(isLocked(out.set, tf, 'BUY')).toBe(!expected);
    });
  });

  it('records which arm of the OR released the lock', () => {
    const low = evaluateObservation(lockedSet(tf, 'SELL'), tf, 'SELL', 20, T0 + 5000, true);
    expect(low.evidence).toMatchObject({ condition: 'RSI_AT_OR_BELOW', threshold: 25, rsi: 20 });

    const high = evaluateObservation(lockedSet(tf, 'SELL'), tf, 'SELL', 99, T0 + 5000, true);
    expect(high.evidence).toMatchObject({ condition: 'RSI_AT_OR_ABOVE', threshold: 98.5, rsi: 99 });
  });

  it('retains the release as audit evidence after the lock clears', () => {
    const out = evaluateObservation(lockedSet(tf, 'BUY'), tf, 'BUY', 1.5, T0 + 5000, true);
    const lock = getLock(out.set, tf, 'BUY');
    expect(lock.active).toBe(false);
    expect(lock.lastUnlock).toMatchObject({ condition: 'RSI_AT_OR_BELOW', threshold: 1.5, rsi: 1.5 });
    // The cause is still on the record, not erased by the release.
    expect(lock.losingPositionId).not.toBeNull();
    expect(lock.netRealized).toBeLessThan(0);
  });
});

describe('§6.5 ordering, gaps and warm-up cannot fabricate unlocks', () => {
  it('an observation that is not unlock-eligible never releases a lock', () => {
    const out = evaluateObservation(lockedSet('M1', 'SELL'), 'M1', 'SELL', 10, T0 + 5000, false);
    expect(out.unlocked).toBe(false);
    expect(out.wasActiveAtObservationStart).toBe(true);
    expect(isLocked(out.set, 'M1', 'SELL')).toBe(true);
  });

  it('an RSI observation preceding the losing closure cannot release the lock it caused', () => {
    const locked = lockedSet('M1', 'SELL'); // activated at T0
    const earlier = evaluateObservation(locked, 'M1', 'SELL', 10, T0 - 1000, true);
    expect(earlier.unlocked).toBe(false);
    expect(isLocked(earlier.set, 'M1', 'SELL')).toBe(true);

    // The same value, after activation, does release it.
    const later = evaluateObservation(locked, 'M1', 'SELL', 10, T0 + 1, true);
    expect(later.unlocked).toBe(true);
  });

  it('an observation exactly at the activation instant does not release the lock', () => {
    const out = evaluateObservation(lockedSet('M5', 'BUY'), 'M5', 'BUY', 99, T0, true);
    expect(out.unlocked).toBe(false);
  });

  it('a null or non-finite RSI never releases a lock', () => {
    for (const rsi of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = evaluateObservation(lockedSet('M1', 'BUY'), 'M1', 'BUY', rsi as number | null, T0 + 5000, true);
      expect(out.unlocked).toBe(false);
    }
  });
});

describe('§6 independence of the four locks', () => {
  it('locking one timeframe+direction leaves the other three untouched', () => {
    for (const tf of TIMEFRAMES) {
      for (const dir of DIRECTIONS) {
        const set = lockedSet(tf, dir);
        for (const otherTf of TIMEFRAMES) {
          for (const otherDir of DIRECTIONS) {
            const shouldBeLocked = otherTf === tf && otherDir === dir;
            expect(isLocked(set, otherTf, otherDir), `${tf}/${dir} locked -> ${otherTf}/${otherDir}`).toBe(
              shouldBeLocked,
            );
          }
        }
      }
    }
  });

  it('unlocking one does not unlock another that happens to share a value', () => {
    // Lock both M1 SELL and M5 SELL, then feed an unlock value to M1 only.
    let set = lockedSet('M1', 'SELL');
    set = applyClosure(set, closure('M5', 'SELL', -8, { closureEventId: 'evt-m5' })).set;
    expect(isLocked(set, 'M1', 'SELL')).toBe(true);
    expect(isLocked(set, 'M5', 'SELL')).toBe(true);

    const out = evaluateObservation(set, 'M1', 'SELL', 10, T0 + 5000, true);
    expect(isLocked(out.set, 'M1', 'SELL')).toBe(false);
    expect(isLocked(out.set, 'M5', 'SELL')).toBe(true);
  });

  it('a SELL loss does not lock BUY on the same timeframe', () => {
    const set = lockedSet('M1', 'SELL');
    expect(isLocked(set, 'M1', 'BUY')).toBe(false);
  });
});

describe('§6 skip reasons and operator wording', () => {
  it('uses the exact reason strings the specification names', () => {
    expect(lockoutReasonFor('SELL')).toBe('POST_SELL_LOSS_LOCKOUT');
    expect(lockoutReasonFor('BUY')).toBe('POST_BUY_LOSS_LOCKOUT');
    expect(POST_SELL_LOSS_LOCKOUT).toBe('POST_SELL_LOSS_LOCKOUT');
    expect(POST_BUY_LOSS_LOCKOUT).toBe('POST_BUY_LOSS_LOCKOUT');
  });

  it('describes unlock conditions in the wording §12 requires', () => {
    expect(describeUnlockCondition('SELL')).toBe('Waiting for RSI <=25 OR RSI >=98.5.');
    expect(describeUnlockCondition('BUY')).toBe('Waiting for RSI >=75 OR RSI <=1.5.');
  });

  it('keeps 98.5 and 1.5 bound to unlocking only', () => {
    // They appear in the unlock config and nowhere in the entry thresholds.
    expect(SPEC.postLossUnlock.sell.rsiAtOrAbove).toBe(98.5);
    expect(SPEC.postLossUnlock.buy.rsiAtOrBelow).toBe(1.5);
    expect(Object.values(SPEC.thresholds)).toEqual([91, 8.9]);
    expect(Object.values(SPEC.thresholds)).not.toContain(98.5);
    expect(Object.values(SPEC.thresholds)).not.toContain(1.5);
  });

  it('unlockEvidenceFor is a pure predicate with no side effect on eligibility', () => {
    expect(unlockEvidenceFor('SELL', 25, T0)).not.toBeNull();
    expect(unlockEvidenceFor('SELL', 26, T0)).toBeNull();
    expect(unlockEvidenceFor('BUY', 75, T0)).not.toBeNull();
    expect(unlockEvidenceFor('BUY', 74, T0)).toBeNull();
  });
});

describe('§6.5 persistence across restart', () => {
  it('a lock set survives a JSON round trip with every field intact', () => {
    let set = lockedSet('M1', 'SELL');
    set = applyClosure(set, closure('M5', 'BUY', -2.25, { closureEventId: 'evt-b' })).set;

    const restored = JSON.parse(JSON.stringify(set)) as LockSet;
    expect(isLocked(restored, 'M1', 'SELL')).toBe(true);
    expect(isLocked(restored, 'M5', 'BUY')).toBe(true);
    expect(isLocked(restored, 'M1', 'BUY')).toBe(false);
    expect(isLocked(restored, 'M5', 'SELL')).toBe(false);
    expect(getLock(restored, 'M5', 'BUY').netRealized).toBe(-2.25);
    // And the duplicate-suppression memory survives too, so a closure report
    // that arrives again after a restart is still recognised as a duplicate.
    expect(applyClosure(restored, closure('M1', 'SELL', -12.5)).duplicate).toBe(true);
  });

  it('a restart with no market data cannot clear a lock', () => {
    const set = lockedSet('M1', 'SELL');
    const restored = JSON.parse(JSON.stringify(set)) as LockSet;
    // No observation at all: still locked.
    expect(isLocked(restored, 'M1', 'SELL')).toBe(true);
  });
});
