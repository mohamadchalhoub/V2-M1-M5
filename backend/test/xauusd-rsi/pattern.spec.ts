/**
 * The four entry setups of `xauusd-m1-rsi-retest-extremes-v1`, driven
 * directly as RSI sequences.
 *
 * These tests deliberately feed RSI values rather than prices: the rules in
 * spec §3/§4/§5/§6 are stated purely in RSI terms, so testing them through a
 * price series would only add a second thing that could be wrong. RSI
 * calculation itself is covered separately in `rsi.spec.ts`, and their
 * composition in `engine.spec.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  createPatternState,
  Direction,
  observe,
  observeClosedBar,
  PatternState,
  ruleFamilyFor,
  SetupKind,
  splitByRuleFamily,
  TriggeredSetup,
} from '../../src/xauusd-rsi/pattern';

interface Firing {
  index: number;
  kinds: SetupKind[];
  direction: Direction;
  triggered: TriggeredSetup[];
}

/**
 * Feeds a sequence of RSI readings through the state machine.
 *
 * Every sequence starts from a fresh state, which begins in
 * `AWAITING_ARM_RESET` — so each case below primes with a neutral reading
 * first. That is the real start-up behaviour (spec §7: never enter merely
 * because the first reading is already extreme), not a test artefact.
 */
/**
 * Each value is one M1 BAR: the bar closes at that RSI, then a tick arrives
 * at the same value.
 *
 * That ordering matters and mirrors production. Retest progression — the
 * trough or peak, the confirming candle, the invalidation — happens only on
 * the close; the entry fires only on a tick. Feeding ticks alone, as this
 * helper used to, could no longer arm anything.
 */
function drive(values: number[], canEmitAt: (index: number) => boolean = () => true): { state: PatternState; firings: Firing[] } {
  let state = createPatternState('test-spec-hash');
  const firings: Firing[] = [];
  values.forEach((rsi, index) => {
    state = observeClosedBar({ state, closeRsi: rsi }).state;
    const result = observe({ state, rsi, atT: index * 1_000, canEmit: canEmitAt(index) });
    state = result.state;
    if (result.triggered.length > 0) {
      firings.push({
        index,
        kinds: result.triggered.map((t) => t.kind),
        direction: result.triggered[0].direction,
        triggered: result.triggered,
      });
    }
  });
  return { state, firings };
}

describe('SELL — RSI peak retest (spec §3.1)', () => {
  it("fires on the user's own example: 92 -> 86 -> 92", () => {
    const { firings } = drive([50, 92, 86, 92]);
    expect(firings).toHaveLength(1);
    expect(firings[0].index).toBe(3);
    expect(firings[0].direction).toBe('SELL');
    expect(firings[0].kinds).toEqual(['SELL_PEAK_RETEST']);
  });

  it("does not fire on the user's own invalidation example: 92 -> 80 -> 92", () => {
    const { firings } = drive([50, 92, 80, 92]);
    expect(firings).toHaveLength(0);
  });

  it('treats a touch of exactly 82 as NOT invalidating (spec §6.3)', () => {
    const { firings } = drive([50, 92, 82, 92]);
    expect(firings).toHaveLength(1);
    expect(firings[0].kinds).toEqual(['SELL_PEAK_RETEST']);
  });

  it('invalidates just beyond the boundary, at 81.9999', () => {
    const { firings } = drive([50, 92, 81.9999, 92]);
    expect(firings).toHaveLength(0);
  });

  it('does not confirm a peak on equal consecutive readings — a plateau extends the running maximum', () => {
    // The second 92 must NOT freeze the peak; only the strictly lower 86 does.
    const { state, firings } = drive([50, 92, 92]);
    expect(firings).toHaveLength(0);
    expect(state.sellRetest.phase).toBe('TRACKING_EXTREME');
    expect(state.sellRetest.runningExtreme).toBe(92);
  });

  it('freezes the highest reading of the plateau, then fires on the return to it', () => {
    const { firings } = drive([50, 92, 92, 95, 86, 95]);
    expect(firings).toHaveLength(1);
    expect(firings[0].index).toBe(5);
    expect(firings[0].triggered[0].keyLevel).toBe(95);
  });

  it('a drop straight through Sell 1 invalidates rather than freezing a peak on the way down', () => {
    const { state } = drive([50, 92, 75]);
    expect(state.sellRetest.phase).toBe('IDLE');
    expect(state.sellRetest.frozenExtreme).toBeNull();
  });

  it('requires a strict crossing: reaching the peak from above does not re-fire', () => {
    // After the fire at index 3 the setup is AWAITING_REARM; staying high never re-fires.
    const { firings } = drive([50, 92, 86, 92, 93, 92, 94]);
    expect(firings).toHaveLength(1);
  });
});

describe('BUY — RSI trough retest (spec §3.2)', () => {
  it("fires on the user's own example: 7 -> 15 -> 7", () => {
    const { firings } = drive([50, 7, 15, 7]);
    expect(firings).toHaveLength(1);
    expect(firings[0].index).toBe(3);
    expect(firings[0].direction).toBe('BUY');
    expect(firings[0].kinds).toEqual(['BUY_TROUGH_RETEST']);
  });

  it("does not fire on the user's own invalidation example: 7 -> 20 -> 7", () => {
    const { firings } = drive([50, 7, 20, 7]);
    expect(firings).toHaveLength(0);
  });

  it('treats a touch of exactly 18 as NOT invalidating, using Buy 1 = 18 rather than the 14 in the screenshots', () => {
    const { firings } = drive([50, 7, 18, 7]);
    expect(firings).toHaveLength(1);
  });

  it('invalidates just beyond the boundary, at 18.0001', () => {
    const { firings } = drive([50, 7, 18.0001, 7]);
    expect(firings).toHaveLength(0);
  });

  it('arms only below Buy 2 = 8.9, not merely below Buy 1', () => {
    // 12 is below Buy 1 (18) but not below Buy 2 (8.9) — no pattern may arm.
    const { state } = drive([50, 12, 14, 12]);
    expect(state.buyRetest.phase).toBe('IDLE');
    expect(state.buyRetest.runningExtreme).toBeNull();
  });

  it('does not confirm a trough on equal consecutive readings', () => {
    const { state, firings } = drive([50, 7, 7]);
    expect(firings).toHaveLength(0);
    expect(state.buyRetest.phase).toBe('TRACKING_EXTREME');
    expect(state.buyRetest.runningExtreme).toBe(7);
  });
});

describe('Extreme setups (spec §3.3, §3.4)', () => {
  it('does NOT fire at 98.4, just below the 98.5 threshold', () => {
    const { firings } = drive([50, 98.4]);
    expect(firings).toHaveLength(0);
  });

  it('fires at exactly 98.5, the stated threshold', () => {
    const { firings } = drive([50, 98.5]);
    expect(firings).toHaveLength(1);
    expect(firings[0].kinds).toEqual(['EXTREME_SELL']);
  });

  it('fires an extreme SELL on a fresh crossing, with no retest pattern', () => {
    const { firings } = drive([50, 99]);
    expect(firings).toHaveLength(1);
    expect(firings[0].kinds).toEqual(['EXTREME_SELL']);
    expect(firings[0].direction).toBe('SELL');
  });

  it('fires an extreme BUY on a fresh crossing, with no retest pattern', () => {
    const { firings } = drive([50, 1.0]);
    expect(firings).toHaveLength(1);
    expect(firings[0].kinds).toEqual(['EXTREME_BUY']);
    expect(firings[0].direction).toBe('BUY');
  });

  it('does not fire merely because the FIRST reading is already extreme (spec §7 start-up rule)', () => {
    const { firings } = drive([99, 99.5, 98.6]);
    expect(firings).toHaveLength(0);
  });

  it('does not re-fire while RSI merely REMAINS in the extreme region (spec §6.4)', () => {
    // Monotonically rising inside the region on purpose: no pullback means no
    // peak is ever frozen, so the peak-retest setup stays silent and this case
    // isolates the extreme setup's own rearming rule.
    const { firings } = drive([50, 99, 99.5, 99.8, 100]);
    expect(firings).toHaveLength(1);
    expect(firings[0].index).toBe(1);
    expect(firings[0].kinds).toEqual(['EXTREME_SELL']);
  });

  it('re-arms only after leaving the region, then fires on the next fresh crossing', () => {
    const { firings } = drive([50, 99, 90, 99]);
    expect(firings).toHaveLength(2);
    expect(firings.map((f) => f.index)).toEqual([1, 3]);
  });

  it('uses 1.5 consistently for the extreme BUY threshold, crossing and rearm', () => {
    // 1.5 exactly is a crossing (<=), 1.6 is not, and 1.6 also re-arms.
    const { firings } = drive([50, 1.5, 1.4, 1.6, 1.5]);
    expect(firings.map((f) => f.index)).toEqual([1, 4]);
  });
});

describe('Duplicate prevention and rearming (spec §6)', () => {
  it('rearms the SELL retest only after RSI falls below 82', () => {
    // 90 does not rearm; 80 does, and only then can a new pattern form and fire.
    const { firings } = drive([50, 92, 86, 92, 90, 92, 80, 92, 86, 92]);
    expect(firings.map((f) => f.index)).toEqual([3, 9]);
  });

  it('rearms the BUY retest only after RSI rises above 18', () => {
    const { firings } = drive([50, 7, 15, 7, 10, 7, 20, 7, 15, 7]);
    expect(firings.map((f) => f.index)).toEqual([3, 9]);
  });

  it('splits two families firing on one observation into TWO separate decisions', () => {
    // 99 fires the extreme; 85 is a REAL pullback — out of the arming zone
    // (below Sell 2) but not through Sell 1 — so it re-arms the extreme AND
    // freezes the peak at 99; the return to 99 satisfies both the peak retest
    // and a fresh extreme crossing. Under the two-slot model these are two
    // different trades against two different slots, so they must NOT be
    // merged.
    //
    // 97 was used here before, which no longer freezes anything: a pullback
    // that never leaves the zone is not a pullback.
    const { firings } = drive([50, 99, 85, 99]);
    expect(firings).toHaveLength(2);
    const both = firings[1];
    expect(both.kinds.sort()).toEqual(['EXTREME_SELL', 'SELL_PEAK_RETEST']);

    const split = splitByRuleFamily(both.triggered);
    expect(split).toHaveLength(2);

    const retest = split.find((d) => d.family === 'RETEST');
    const extreme = split.find((d) => d.family === 'EXTREME');
    expect(retest?.kinds).toEqual(['SELL_PEAK_RETEST']);
    expect(extreme?.kinds).toEqual(['EXTREME_SELL']);
    // Each decision carries only its own family's reasoning.
    expect(retest?.reason).toContain('SELL_PEAK_RETEST');
    expect(retest?.reason).not.toContain('EXTREME_SELL');
    expect(extreme?.reason).toContain('EXTREME_SELL');
    expect(extreme?.reason).not.toContain('SELL_PEAK_RETEST');
  });

  it('produces one decision when only one family fires', () => {
    const split = splitByRuleFamily([
      { kind: 'BUY_TROUGH_RETEST', direction: 'BUY', reason: 'x', keyLevel: 7 },
    ]);
    expect(split).toHaveLength(1);
    expect(split[0].family).toBe('RETEST');
    expect(split[0].direction).toBe('BUY');
  });

  it('maps every setup to exactly one family', () => {
    expect(ruleFamilyFor('SELL_PEAK_RETEST')).toBe('RETEST');
    expect(ruleFamilyFor('BUY_TROUGH_RETEST')).toBe('RETEST');
    expect(ruleFamilyFor('EXTREME_SELL')).toBe('EXTREME');
    expect(ruleFamilyFor('EXTREME_BUY')).toBe('EXTREME');
  });

  it('refuses to invent a direction if opposite setups ever fired within ONE family', () => {
    expect(() =>
      splitByRuleFamily([
        { kind: 'EXTREME_SELL', direction: 'SELL', reason: 'x', keyLevel: 98.5 },
        { kind: 'EXTREME_BUY', direction: 'BUY', reason: 'y', keyLevel: 1.5 },
      ]),
    ).toThrow(/arithmetically impossible/);
  });

  it('allows opposite directions ACROSS families, since they are separate trades', () => {
    // Not reachable from real RSI, but the splitter must not conflate the two
    // families' directions if it ever were.
    const split = splitByRuleFamily([
      { kind: 'SELL_PEAK_RETEST', direction: 'SELL', reason: 'x', keyLevel: 92 },
      { kind: 'EXTREME_BUY', direction: 'BUY', reason: 'y', keyLevel: 1.5 },
    ]);
    expect(split).toHaveLength(2);
    expect(split.find((d) => d.family === 'RETEST')?.direction).toBe('SELL');
    expect(split.find((d) => d.family === 'EXTREME')?.direction).toBe('BUY');
  });
});

describe('Blocked signals are consumed, never replayed (spec §9.5)', () => {
  it('a suppressed SELL retest does not fire later once emission resumes', () => {
    // Emission is blocked exactly at index 3, the observation that satisfies
    // the retest. The setup must still consume it and move to AWAITING_REARM.
    const { state, firings } = drive([50, 92, 86, 92, 92, 93, 92], (i) => i !== 3);
    expect(firings).toHaveLength(0);
    expect(state.sellRetest.phase).toBe('AWAITING_REARM');
  });

  it('a suppressed extreme SELL does not fire later while RSI stays extreme', () => {
    const { state, firings } = drive([50, 99, 99.2, 100], (i) => i !== 1);
    expect(firings).toHaveLength(0);
    expect(state.extremeSell.phase).toBe('DISARMED');
  });

  it('a position closing while RSI stays extreme produces no new signal — occupancy is not an input here', () => {
    // The state machine has no notion of occupancy by construction, so a
    // freed slot cannot resurrect a consumed event. Staying extreme is inert.
    const { firings } = drive([50, 99, 99.1, 99.4, 99.9, 98.6]);
    expect(firings).toHaveLength(1);
  });
});

describe('Start-up and reset behaviour', () => {
  it('refuses to arm a retest pattern from a mid-region cold start', () => {
    // Starting at 95 (already above Sell 2) must not be treated as a peak
    // this engine watched form — it waits for RSI to return to the ordinary
    // range first, so it never claims a maximum it did not observe.
    const { state, firings } = drive([95, 93, 96, 90, 96]);
    expect(firings).toHaveLength(0);
    // 90 <= 91 released the reset; 96 then armed a genuine tracking phase.
    expect(state.sellRetest.phase).toBe('TRACKING_EXTREME');
    expect(state.sellRetest.runningExtreme).toBe(96);
  });

  it('refuses to arm a BUY pattern from a cold start already below Buy 2', () => {
    const { state, firings } = drive([5, 6, 4]);
    expect(firings).toHaveLength(0);
    expect(state.buyRetest.phase).toBe('AWAITING_ARM_RESET');
  });
});

describe('Closed-bar progression, intrabar entry (user rules, revision 5)', () => {
  /**
   * Drives TICKS only — no bar ever closes. Models what really happened on
   * 2026-09-21: three readings inside bars, 0.045 apart.
   */
  function ticksOnly(values: number[]) {
    let state = createPatternState('test-spec-hash');
    const all: TriggeredSetup[] = [];
    values.forEach((rsi, i) => {
      const r = observe({ state, rsi, atT: i * 1_000, canEmit: true });
      state = r.state;
      all.push(...r.triggered);
    });
    return { state, triggered: all };
  }

  it('THE DEFECT: ticks alone never arm, freeze or fire a retest', () => {
    // The exact recorded sequence that opened ticket 58555388969.
    const { triggered } = ticksOnly([50, 8.0752, 8.1199, 8.0752]);
    expect(triggered).toHaveLength(0);
  });

  it('ticks alone cannot arm the SELL side either', () => {
    const { triggered } = ticksOnly([50, 92.2464, 92.2114, 92.5632]);
    expect(triggered).toHaveLength(0);
  });

  it('a rising candle of ANY size confirms the trough — 8.00 -> 8.12 -> 8.00 fires', () => {
    // The user's own answer: size is irrelevant, it need only be a rising
    // candle that closes below Buy 1.
    const { firings } = drive([50, 8.0, 8.12, 8.0]);
    expect(firings).toHaveLength(1);
    expect(firings[0].kinds).toEqual(['BUY_TROUGH_RETEST']);
    expect(firings[0].triggered[0].keyLevel).toBeCloseTo(8.0, 6);
  });

  it.each([
    ['8.12', 8.12],
    ['12.0', 12.0],
    ['17.9', 17.9],
  ])('rebound closing at %s (below Buy 1) still fires', (_label, rebound) => {
    const { firings } = drive([50, 8.0, rebound, 8.0]);
    expect(firings).toHaveLength(1);
  });

  it('a bar CLOSING above Buy 1 kills the trough — 8.00 -> 50 -> 8.00 does not fire', () => {
    const { firings } = drive([50, 8.0, 50, 8.0]);
    expect(firings).toHaveLength(0);
  });

  it('an INTRABAR spike above Buy 1 does NOT invalidate, if the bar closes below it', () => {
    // User rule: "if rsi rise above 18 and the candle closed when rsi was
    // below 18 --> keep testing to see if it will reach the trough".
    let state = createPatternState('test-spec-hash');
    for (const close of [50, 8.0, 12.0]) state = observeClosedBar({ state, closeRsi: close }).state;
    expect(state.buyRetest.phase).toBe('EXTREME_FROZEN');

    // A tick spikes to 25, well above Buy 1 — no close, so no invalidation.
    state = observe({ state, rsi: 25, atT: 1_000, canEmit: true }).state;
    expect(state.buyRetest.phase).toBe('EXTREME_FROZEN');

    // The bar then closes at 17, below Buy 1: the trough survives.
    state = observeClosedBar({ state, closeRsi: 17 }).state;
    expect(state.buyRetest.phase).toBe('EXTREME_FROZEN');

    // And the return to the trough still buys.
    const r = observe({ state, rsi: 8.0, atT: 2_000, canEmit: true });
    expect(r.triggered.map((t) => t.kind)).toEqual(['BUY_TROUGH_RETEST']);
  });

  it('the entry fires INTRABAR, without waiting for the bar to close', () => {
    let state = createPatternState('test-spec-hash');
    for (const close of [50, 8.0, 12.0]) state = observeClosedBar({ state, closeRsi: close }).state;

    // Ticks descending toward the trough; the one that reaches it fires.
    state = observe({ state, rsi: 10, atT: 1_000, canEmit: true }).state;
    const r = observe({ state, rsi: 7.95, atT: 2_000, canEmit: true });
    expect(r.triggered.map((t) => t.kind)).toEqual(['BUY_TROUGH_RETEST']);
  });

  it('tracks a deeper trough across bars before any rising candle appears', () => {
    const { firings } = drive([50, 8.5, 8.0, 12.0, 8.0]);
    expect(firings).toHaveLength(1);
    expect(firings[0].triggered[0].keyLevel).toBeCloseTo(8.0, 6);
  });

  it('SELL mirrors it: a falling candle confirms, a close below Sell 1 kills it', () => {
    expect(drive([50, 92.5, 92.2, 92.5]).firings).toHaveLength(1);
    expect(drive([50, 92.5, 80, 92.5]).firings).toHaveLength(0);
  });
});
