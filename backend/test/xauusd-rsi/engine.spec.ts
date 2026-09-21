/**
 * The live observation engine: ordering, duplicates, gaps, minute rollover,
 * warm-up, freshness and restart persistence (spec §7, §8.2, §8.5, §8.6).
 */
import { describe, expect, it } from 'vitest';
import {
  applyClosedBar,
  applyTick,
  createEngineState,
  EngineState,
  engineRsiNow,
  engineWarmedUp,
  M1_MS,
  minuteBucket,
} from '../../src/xauusd-rsi/engine';
import { SPEC, SPEC_HASH } from '../../src/xauusd-rsi/spec';

const T0 = new Date('2026-09-23T10:00:00Z').getTime();

/**
 * Warms the engine past its warm-up threshold with contiguous closed bars
 * that oscillate gently, so average gain and average loss are both non-zero
 * and RSI sits mid-range rather than pinned at an extreme.
 */
function warmedEngine(): { state: EngineState; nextBarT: number; lastClose: number } {
  let state = createEngineState('TICK');
  const bars = SPEC.rsi.period + 1 + SPEC.rsi.warmupBars + 5;
  let t = T0;
  let close = 2000;
  for (let i = 0; i < bars; i += 1) {
    close = 2000 + (i % 2 === 0 ? 0.5 : -0.5);
    state = applyClosedBar(state, t, close).state;
    t += M1_MS;
  }
  return { state, nextBarT: t, lastClose: close };
}

describe('Warm-up', () => {
  it('suppresses signals until enough closed bars have been applied', () => {
    let state = createEngineState('TICK');
    let t = T0;
    for (let i = 0; i < 10; i += 1) {
      state = applyClosedBar(state, t, 2000 + i).state;
      t += M1_MS;
    }
    expect(engineWarmedUp(state)).toBe(false);

    // A price path that would otherwise fire an extreme SELL.
    const r = applyTick(state, { atT: t + 1_000, bid: 2100, tickKey: 'k1', nowT: t + 1_000 });
    expect(r.signals).toHaveLength(0);
    expect(r.notes.join(' ')).toMatch(/warm-up incomplete/);
  });

  it('is warmed up after the required number of bars', () => {
    const { state } = warmedEngine();
    expect(engineWarmedUp(state)).toBe(true);
    expect(engineRsiNow(state)).not.toBeNull();
  });
});

describe('Duplicate and out-of-order observations (spec §7)', () => {
  it('ignores a tick whose identity was already processed', () => {
    const { state, nextBarT } = warmedEngine();
    const first = applyTick(state, { atT: nextBarT + 1_000, bid: 2000.1, tickKey: 'tick-a', nowT: nextBarT + 1_000 });
    const second = applyTick(first.state, { atT: nextBarT + 2_000, bid: 2000.2, tickKey: 'tick-a', nowT: nextBarT + 2_000 });
    expect(second.notes.join(' ')).toMatch(/duplicate observation/);
    expect(second.state.ticksApplied).toBe(first.state.ticksApplied);
    expect(second.state.ticksRejectedDuplicate).toBe(1);
  });

  it('ignores an observation that precedes the last accepted one', () => {
    const { state, nextBarT } = warmedEngine();
    const first = applyTick(state, { atT: nextBarT + 5_000, bid: 2000.1, tickKey: 'a', nowT: nextBarT + 5_000 });
    const stale = applyTick(first.state, { atT: nextBarT + 1_000, bid: 2000.9, tickKey: 'b', nowT: nextBarT + 5_000 });
    expect(stale.notes.join(' ')).toMatch(/out-of-order/);
    expect(stale.state.ticksRejectedOutOfOrder).toBe(1);
    expect(stale.state.formingPrice).toBe(first.state.formingPrice);
  });

  it('rejects a non-positive bid rather than folding it in', () => {
    const { state, nextBarT } = warmedEngine();
    const r = applyTick(state, { atT: nextBarT + 1_000, bid: 0, tickKey: 'z', nowT: nextBarT + 1_000 });
    expect(r.notes.join(' ')).toMatch(/non-positive/);
    expect(r.state).toBe(state);
  });
});

describe('Gaps and continuity (spec §8.6)', () => {
  it('resets pattern state when the observation gap exceeds the continuity limit', () => {
    const { state, nextBarT } = warmedEngine();
    const first = applyTick(state, { atT: nextBarT + 1_000, bid: 2000.1, tickKey: 'a', nowT: nextBarT + 1_000 });
    const afterGap = nextBarT + 1_000 + SPEC.observation.maxContinuityGapMs + 1_000;
    const r = applyTick(first.state, { atT: afterGap, bid: 2000.2, tickKey: 'b', nowT: afterGap });
    expect(r.didReset).toBe(true);
    expect(r.notes.join(' ')).toMatch(/continuity limit/);
    expect(r.state.gapResets).toBe(1);
    expect(r.state.pattern.previousRsi).not.toBeNull(); // this observation became the new baseline
  });

  it('never emits a signal on the very observation that reset state', () => {
    const { state, nextBarT } = warmedEngine();
    const first = applyTick(state, { atT: nextBarT + 1_000, bid: 2000.1, tickKey: 'a', nowT: nextBarT + 1_000 });
    const afterGap = nextBarT + 1_000 + SPEC.observation.maxContinuityGapMs + 1_000;
    const r = applyTick(first.state, { atT: afterGap, bid: 3000, tickKey: 'b', nowT: afterGap });
    expect(r.signals).toHaveLength(0);
  });

  it('resets PATTERN state when closed bars skip a minute, but carries the indicator across the gap', () => {
    // MetaTrader does not restart RSI after a session break: the first bar of
    // the new week is smoothed against the last bars of the previous one. An
    // engine that reset the recursive average here would disagree with the
    // terminal every Monday, and would blind itself for a further warm-up
    // period after every weekend. Pattern state is the part that must go,
    // because the pullback may have happened unobserved.
    const { state, nextBarT } = warmedEngine();
    const r = applyClosedBar(state, nextBarT + 5 * M1_MS, 2000.5);

    expect(r.didReset).toBe(true);
    expect(r.notes.join(' ')).toMatch(/missing M1 bar/);

    // Indicator survives, so the engine can still trade immediately after.
    expect(engineWarmedUp(r.state)).toBe(true);
    expect(r.state.needsRsiReseed).toBe(false);
    expect(r.state.rsi.seeded).toBe(true);

    // Pattern PROGRESS does not survive: no tracked or frozen level, and no
    // previous tick reading. The bar that triggered the reset is then
    // observed like any other close, so the resting phase may be IDLE rather
    // than AWAITING_ARM_RESET — what matters is that nothing is part-formed.
    expect(r.state.pattern.previousRsi).toBeNull();
    expect(['AWAITING_ARM_RESET', 'IDLE']).toContain(r.state.pattern.sellRetest.phase);
    expect(r.state.pattern.sellRetest.runningExtreme).toBeNull();
    expect(r.state.pattern.sellRetest.frozenExtreme).toBeNull();
    expect(r.state.pattern.buyRetest.runningExtreme).toBeNull();
    expect(r.state.pattern.buyRetest.frozenExtreme).toBeNull();
    expect(r.state.gapResets).toBe(1);
  });

  it('ignores a closed bar that is not newer than the last applied one', () => {
    const { state, nextBarT } = warmedEngine();
    const r = applyClosedBar(state, nextBarT - M1_MS, 2000.5);
    expect(r.notes.join(' ')).toMatch(/not newer/);
    expect(r.state.closedBarsApplied).toBe(state.closedBarsApplied);
  });
});

describe('Minute rollover (spec §8.1)', () => {
  it('commits the forming bar exactly once when the minute completes', () => {
    const { state, nextBarT } = warmedEngine();
    const before = state.closedBarsApplied;

    let s = state;
    // Three ticks inside one minute — none may advance the recursive state.
    for (let i = 0; i < 3; i += 1) {
      s = applyTick(s, { atT: nextBarT + i * 10_000, bid: 2000 + i * 0.1, tickKey: `m1-${i}`, nowT: nextBarT + i * 10_000 }).state;
    }
    expect(s.closedBarsApplied).toBe(before);

    // First tick of the NEXT minute commits the previous one, once.
    s = applyTick(s, { atT: nextBarT + M1_MS + 1_000, bid: 2000.4, tickKey: 'm2-0', nowT: nextBarT + M1_MS + 1_000 }).state;
    expect(s.closedBarsApplied).toBe(before + 1);

    s = applyTick(s, { atT: nextBarT + M1_MS + 2_000, bid: 2000.5, tickKey: 'm2-1', nowT: nextBarT + M1_MS + 2_000 }).state;
    expect(s.closedBarsApplied).toBe(before + 1);
  });

  it('tracks the forming minute bucket', () => {
    const { state, nextBarT } = warmedEngine();
    const r = applyTick(state, { atT: nextBarT + 37_000, bid: 2000.1, tickKey: 'x', nowT: nextBarT + 37_000 });
    expect(r.state.formingMinuteT).toBe(minuteBucket(nextBarT + 37_000));
  });
});

describe('Freshness (spec §8.2)', () => {
  it('suppresses signals when the observation is older than the staleness limit', () => {
    const { state, nextBarT } = warmedEngine();
    const atT = nextBarT + 1_000;
    const nowT = atT + SPEC.observation.maxStalenessMs + 5_000;
    const r = applyTick(state, { atT, bid: 2500, tickKey: 'stale', nowT });
    expect(r.signals).toHaveLength(0);
    expect(r.notes.join(' ')).toMatch(/signals suppressed/);
  });

  it('still advances pattern state while suppressed, so continuity survives', () => {
    const { state, nextBarT } = warmedEngine();
    const atT = nextBarT + 1_000;
    const r = applyTick(state, { atT, bid: 2000.3, tickKey: 'stale', nowT: atT + 60_000 });
    expect(r.state.pattern.previousRsi).not.toBeNull();
    expect(r.state.pattern.observationCount).toBe(1);
  });
});

describe('End-to-end signal production', () => {
  it('emits an extreme SELL when a fresh, warmed-up price path drives RSI across the crossing level', () => {
    const { state, nextBarT } = warmedEngine();
    let s = state;
    let t = nextBarT;
    const emitted: string[][] = [];

    // A steady climb: with period 5 this pushes average loss toward zero and
    // RSI toward 100, crossing the extreme-SELL level. Wilder's average decays
    // by (period-1)/period per bar, so clearing 98 needs roughly ten closed
    // bars of one-sided movement — at three ticks per minute, ~30 ticks.
    for (let i = 0; i < 45; i += 1) {
      t += 20_000;
      const r = applyTick(s, { atT: t, bid: 2000 + i * 3, tickKey: `up-${i}`, nowT: t });
      s = r.state;
      for (const sig of r.signals) emitted.push(sig.kinds);
    }

    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted[0]).toContain('EXTREME_SELL');
  });

  it('records reconstructable evidence on every emitted signal', () => {
    const { state, nextBarT } = warmedEngine();
    let s = state;
    let t = nextBarT;
    let found: ReturnType<typeof applyTick>['signals'][number] | null = null;
    for (let i = 0; i < 45 && !found; i += 1) {
      t += 20_000;
      const r = applyTick(s, { atT: t, bid: 2000 + i * 3, tickKey: `e-${i}`, nowT: t });
      s = r.state;
      if (r.signals.length > 0) found = r.signals[0];
    }
    expect(found).not.toBeNull();
    expect(found!.evidence.specHash).toBe(SPEC_HASH);
    expect(found!.evidence.strategyVersion).toBe(SPEC.strategyVersion);
    expect(found!.evidence.observationMode).toBe('TICK');
    expect(found!.evidence.previousRsi).not.toBeNull();
    expect(found!.evidence.currentRsi).toBeCloseTo(found!.rsi, 10);
    expect(found!.evidence.thresholds.buy1).toBe(18);
    expect(found!.evidence.triggered.length).toBeGreaterThan(0);
  });
});

describe('Restart persistence', () => {
  it('survives a JSON round-trip with identical subsequent behaviour', () => {
    const { state, nextBarT } = warmedEngine();
    const withTick = applyTick(state, { atT: nextBarT + 1_000, bid: 2000.2, tickKey: 'a', nowT: nextBarT + 1_000 }).state;

    const revived = JSON.parse(JSON.stringify(withTick)) as EngineState;
    expect(revived.specHash).toBe(SPEC_HASH);

    const nextT = nextBarT + 20_000;
    const fromLive = applyTick(withTick, { atT: nextT, bid: 2001, tickKey: 'b', nowT: nextT });
    const fromRevived = applyTick(revived, { atT: nextT, bid: 2001, tickKey: 'b', nowT: nextT });

    expect(fromRevived.state.pattern).toEqual(fromLive.state.pattern);
    expect(fromRevived.state.rsi).toEqual(fromLive.state.rsi);
    expect(fromRevived.signals).toEqual(fromLive.signals);
  });

  it('refuses to reuse a duplicate tick key across the restart boundary', () => {
    const { state, nextBarT } = warmedEngine();
    const withTick = applyTick(state, { atT: nextBarT + 1_000, bid: 2000.2, tickKey: 'a', nowT: nextBarT + 1_000 }).state;
    const revived = JSON.parse(JSON.stringify(withTick)) as EngineState;
    const again = applyTick(revived, { atT: nextBarT + 2_000, bid: 2000.3, tickKey: 'a', nowT: nextBarT + 2_000 });
    expect(again.state.ticksRejectedDuplicate).toBe(1);
  });
});
