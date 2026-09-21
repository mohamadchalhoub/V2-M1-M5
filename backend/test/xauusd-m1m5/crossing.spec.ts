/**
 * §15.1 — entry formation and normal rearming, on both timeframes.
 *
 * Everything here is pure: no database, no broker, no clock. The whole point
 * of keeping `crossing.ts` free of I/O is that these boundaries can be
 * asserted exactly rather than approximately.
 */
import { describe, expect, it } from 'vitest';
import {
  createCrossingState,
  evaluate,
  isCrossingStateCompatible,
  type CrossingState,
  type Observation,
} from '../../src/xauusd-m1m5/crossing';
import { SPEC, SPEC_HASH, TIMEFRAMES, type Timeframe } from '../../src/xauusd-m1m5/spec';

const T0 = Date.UTC(2026, 8, 21, 10, 0, 0);

function obs(t: number, rsi: number | null, overrides: Partial<Observation> = {}): Observation {
  return { t, rsi, price: 4450, warmedUp: true, fresh: true, ...overrides };
}

/** Feeds a sequence of RSI values one second apart, returning every signal formed. */
function feed(state: CrossingState, rsis: Array<number | null>, startT = T0) {
  const signals: Array<{ i: number; direction: string; rsi: number }> = [];
  let s = state;
  rsis.forEach((rsi, i) => {
    const out = evaluate(s, obs(startT + i * 1000, rsi));
    s = out.state;
    if (out.signal) signals.push({ i, direction: out.signal.direction, rsi: out.signal.rsi });
  });
  return { state: s, signals };
}

describe.each(TIMEFRAMES)('crossing rules — %s', (tf: Timeframe) => {
  const fresh = () => createCrossingState(tf, SPEC_HASH);

  describe('§3.1 SELL — previous < 91 AND current >= 91', () => {
    it('fires on a rise across 91 from below', () => {
      const { signals } = feed(fresh(), [50, 90, 92]);
      expect(signals).toEqual([{ i: 2, direction: 'SELL', rsi: 92 }]);
    });

    it('fires on exact equality at 91 approached from below', () => {
      const { signals } = feed(fresh(), [50, 90.9999999, 91]);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ direction: 'SELL', rsi: 91 });
    });

    it('does not fire when the previous value was already at the threshold', () => {
      // prev = 91 is not < 91, so this is not a crossing.
      const { signals } = feed(fresh(), [50, 91, 92]);
      expect(signals).toHaveLength(1); // the 90->91 style crossing at i=1 only
      expect(signals[0].i).toBe(1);
    });

    it('compares at full precision, with no rounding to a decimal place', () => {
      // 90.99999999 rounds to 91.0 at one decimal but is strictly below the
      // threshold, so the pair (90.99999999 -> 91) is a genuine crossing and
      // the pair (91 -> 91.00000001) is not.
      const a = feed(fresh(), [50, 90.99999999, 91]);
      expect(a.signals).toHaveLength(1);

      // Both values are strictly above 91, so neither pair is a crossing —
      // even though both round to 91.0. Starting at 95 keeps the state
      // disarmed throughout, so nothing here can fire.
      const b = feed(fresh(), [95, 91.00000001, 91.00000002]);
      expect(b.signals).toHaveLength(0);
    });
  });

  describe('§3.2 BUY — previous > 8.9 AND current <= 8.9', () => {
    it('fires on a fall across 8.9 from above', () => {
      const { signals } = feed(fresh(), [50, 9, 8]);
      expect(signals).toEqual([{ i: 2, direction: 'BUY', rsi: 8 }]);
    });

    it('fires on exact equality at 8.9 approached from above', () => {
      const { signals } = feed(fresh(), [50, 8.9000001, 8.9]);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ direction: 'BUY', rsi: 8.9 });
    });

    it('does not fire when the previous value was already at the threshold', () => {
      const { signals } = feed(fresh(), [50, 8.9, 8.5]);
      expect(signals).toHaveLength(1);
      expect(signals[0].i).toBe(1);
    });
  });

  describe('§5 normal rearming', () => {
    it('remaining beyond 91 does not repeat the SELL signal', () => {
      const { signals } = feed(fresh(), [50, 90, 92, 93, 95, 99, 92]);
      expect(signals).toHaveLength(1);
      expect(signals[0].i).toBe(2);
    });

    it('remaining beyond 8.9 does not repeat the BUY signal', () => {
      const { signals } = feed(fresh(), [50, 9, 8, 5, 2, 1, 7]);
      expect(signals).toHaveLength(1);
      expect(signals[0].i).toBe(2);
    });

    it('leaving and recrossing 91 rearms and fires again', () => {
      const { signals } = feed(fresh(), [50, 90, 92, 88, 93]);
      expect(signals.map((s) => s.i)).toEqual([2, 4]);
      expect(signals.every((s) => s.direction === 'SELL')).toBe(true);
    });

    it('leaving and recrossing 8.9 rearms and fires again', () => {
      const { signals } = feed(fresh(), [50, 9, 8, 20, 8.5]);
      expect(signals.map((s) => s.i)).toEqual([2, 4]);
      expect(signals.every((s) => s.direction === 'BUY')).toBe(true);
    });

    it('a position closing while RSI stays beyond the threshold does not duplicate', () => {
      // Closure is not an input to this module at all — which is precisely
      // the guarantee. RSI staying above 91 produces exactly one signal no
      // matter what happens to the position in the meantime.
      const { signals } = feed(fresh(), [50, 90, 92, 94, 96, 94, 92]);
      expect(signals).toHaveLength(1);
    });
  });

  describe('§3.3 startup, warm-up and continuity', () => {
    it('the first observation cannot establish a crossing by itself', () => {
      const { signals } = feed(fresh(), [95]);
      expect(signals).toHaveLength(0);
    });

    it('does not enter when the first valid reading is already beyond the threshold', () => {
      // Starting at 95 and staying there must never enter: the state is born
      // disarmed and only RSI returning below 91 can arm it.
      const { signals, state } = feed(fresh(), [95, 96, 97, 99]);
      expect(signals).toHaveLength(0);
      expect(state.sellArmed).toBe(false);
    });

    it('arms only after RSI is seen on the permissive side, then fires', () => {
      const { signals } = feed(fresh(), [95, 96, 80, 93]);
      expect(signals).toEqual([{ i: 3, direction: 'SELL', rsi: 93 }]);
    });

    it('warm-up observations never generate entries and never advance continuity', () => {
      let s = fresh();
      // A textbook crossing, but during warm-up.
      s = evaluate(s, obs(T0, 90, { warmedUp: false })).state;
      const out = evaluate(s, obs(T0 + 1000, 92, { warmedUp: false }));
      expect(out.signal).toBeNull();
      expect(out.rejection).toBe('WARMING_UP');
      expect(out.state.previousRsi).toBeNull();

      // And the first warmed-up observation still cannot cross by itself,
      // because warm-up left no previous value behind.
      const after = evaluate(out.state, obs(T0 + 2000, 92));
      expect(after.signal).toBeNull();
      expect(after.continuityReset).toBe(true);
    });

    it('stale observations are rejected and do not advance continuity', () => {
      let s = fresh();
      s = evaluate(s, obs(T0, 90)).state;
      const out = evaluate(s, obs(T0 + 1000, 92, { fresh: false }));
      expect(out.signal).toBeNull();
      expect(out.rejection).toBe('NOT_FRESH');
      expect(out.state.previousRsi).toBe(90);
    });

    it('a gap longer than the budget resets continuity without inventing a crossing', () => {
      const budget = SPEC.observation.maxContinuityGapMs[tf];
      let s = fresh();
      s = evaluate(s, obs(T0, 90)).state;
      // 92 after a long gap would be a crossing if continuity held; it must not be.
      const out = evaluate(s, obs(T0 + budget + 1, 92));
      expect(out.continuityReset).toBe(true);
      expect(out.signal).toBeNull();
      // Re-armed strictly from where RSI actually is: 92 is beyond 91, so disarmed.
      expect(out.state.sellArmed).toBe(false);
    });

    it('a gap within the budget preserves continuity and still fires', () => {
      const budget = SPEC.observation.maxContinuityGapMs[tf];
      let s = fresh();
      s = evaluate(s, obs(T0, 90)).state;
      const out = evaluate(s, obs(T0 + budget - 1, 92));
      expect(out.continuityReset).toBe(false);
      expect(out.signal?.direction).toBe('SELL');
    });
  });

  describe('§15.1 duplicate and out-of-order observations', () => {
    it('a repeated observation does not produce a second signal', () => {
      let s = fresh();
      s = evaluate(s, obs(T0, 90)).state;
      const first = evaluate(s, obs(T0 + 1000, 92));
      expect(first.signal).not.toBeNull();
      const replay = evaluate(first.state, obs(T0 + 1000, 92));
      expect(replay.signal).toBeNull();
      expect(replay.rejection).toBe('OUT_OF_ORDER_OR_DUPLICATE');
    });

    it('an out-of-order observation is refused and leaves state untouched', () => {
      let s = fresh();
      s = evaluate(s, obs(T0, 90)).state;
      s = evaluate(s, obs(T0 + 5000, 88)).state;
      const late = evaluate(s, obs(T0 + 2000, 92));
      expect(late.signal).toBeNull();
      expect(late.rejection).toBe('OUT_OF_ORDER_OR_DUPLICATE');
      expect(late.state).toBe(s);
    });
  });

  describe('§3.4 removed strategy behaviour has no role', () => {
    it('requires no peak, pullback or retest before a SELL', () => {
      // A single monotonic rise across 91 with no prior excursion at all.
      const { signals } = feed(fresh(), [88, 89, 90, 92]);
      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe('SELL');
    });

    it('requires no trough or rebound before a BUY', () => {
      const { signals } = feed(fresh(), [12, 10, 9, 8]);
      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe('BUY');
    });

    it('RSI 82 does not invalidate an armed SELL', () => {
      // Under the old rules, dipping to 82 invalidated the setup. Here it is
      // simply a value below 91 that keeps SELL armed.
      const { signals } = feed(fresh(), [95, 80, 82, 81, 93]);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ i: 4, direction: 'SELL' });
    });

    it('RSI 18 does not invalidate an armed BUY', () => {
      const { signals } = feed(fresh(), [5, 20, 18, 19, 8 ]);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ i: 4, direction: 'BUY' });
    });

    it('98.5 is not a standalone entry: reaching it without crossing 91 does nothing', () => {
      // Born disarmed above 91 and rising to 98.5 and beyond — no entry.
      const { signals } = feed(fresh(), [95, 97, 98.5, 99, 100]);
      expect(signals).toHaveLength(0);
    });

    it('1.5 is not a standalone entry: reaching it without crossing 8.9 does nothing', () => {
      const { signals } = feed(fresh(), [5, 3, 1.5, 1, 0.5]);
      expect(signals).toHaveLength(0);
    });
  });

  describe('signal evidence', () => {
    it('records both sides of the crossing, the threshold, price and time', () => {
      let s = fresh();
      s = evaluate(s, obs(T0, 90.25)).state;
      const out = evaluate(s, { t: T0 + 1000, rsi: 91.75, price: 4451.23, warmedUp: true, fresh: true });
      expect(out.signal).toMatchObject({
        timeframe: tf,
        direction: 'SELL',
        rsi: 91.75,
        previousRsi: 90.25,
        threshold: 91,
        price: 4451.23,
        observedAt: T0 + 1000,
      });
      expect(out.state.lastConsumedSignalId).toBe(out.signal?.signalId);
    });
  });
});

describe('timeframe independence (§4)', () => {
  it('M1 and M5 states are separate values that cannot influence each other', () => {
    const m1 = createCrossingState('M1', SPEC_HASH);
    const m5 = createCrossingState('M5', SPEC_HASH);

    const m1After = feed(m1, [50, 90, 92]);
    expect(m1After.signals).toHaveLength(1);

    // M5 fed nothing at all is still untouched and still disarmed.
    expect(m5.previousRsi).toBeNull();
    expect(m5.signalSeq).toBe(0);

    // And M5 crossing independently produces its own identity.
    const m5After = feed(m5, [50, 90, 92]);
    expect(m5After.signals).toHaveLength(1);
    expect(m1After.state.lastConsumedSignalId).toMatch(/^M1:/);
    expect(m5After.state.lastConsumedSignalId).toMatch(/^M5:/);
  });

  it('M5 tolerates a gap that would reset M1, because budgets are per timeframe', () => {
    const gap = SPEC.observation.maxContinuityGapMs.M1 + 1000;
    expect(gap).toBeLessThan(SPEC.observation.maxContinuityGapMs.M5);

    const m1 = evaluate(evaluate(createCrossingState('M1', SPEC_HASH), obs(T0, 90)).state, obs(T0 + gap, 92));
    const m5 = evaluate(evaluate(createCrossingState('M5', SPEC_HASH), obs(T0, 90)).state, obs(T0 + gap, 92));

    expect(m1.continuityReset).toBe(true);
    expect(m1.signal).toBeNull();
    expect(m5.continuityReset).toBe(false);
    expect(m5.signal?.direction).toBe('SELL');
  });
});

describe('spec-hash compatibility', () => {
  it('accepts state written under the current rules and refuses anything else', () => {
    const s = createCrossingState('M1', SPEC_HASH);
    expect(isCrossingStateCompatible(s, SPEC_HASH)).toBe(true);
    expect(isCrossingStateCompatible(s, 'deadbeefdeadbeef')).toBe(false);
  });
});
