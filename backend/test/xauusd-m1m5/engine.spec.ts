/**
 * §15.4 — the per-timeframe observation engine.
 *
 * Bar boundaries, forming-bar projection, warm-up, freshness on both sides,
 * duplicate and out-of-order handling, gap detection, latency measurement
 * and restart resumability.
 */
import { describe, expect, it } from 'vitest';
import {
  barStartMs,
  createEngineState,
  describeHealth,
  isResumable,
  isUnlockEligible,
  observe,
  warmUpFromClosedBars,
  type EngineState,
} from '../../src/xauusd-m1m5/engine';
import { currentRsi } from '../../src/xauusd-m1m5/rsi';
import { SPEC, SPEC_HASH, TIMEFRAME_BAR_MS, TIMEFRAMES, type Timeframe } from '../../src/xauusd-m1m5/spec';
import { V2_OBSERVATION_CADENCE_TOLERANCE_MS } from '../../src/xauusd-m1m5/safety-constants';

const T0 = Date.UTC(2026, 8, 21, 10, 0, 0);

/** An engine already past warm-up, so observations are eligible. */
function warm(timeframe: Timeframe): EngineState {
  const needed = SPEC.rsi.period + 1 + SPEC.rsi.warmupBars;
  const closes = Array.from({ length: needed }, (_, i) => 4450 + (i % 11) - 5);
  return warmUpFromClosedBars(createEngineState(timeframe), closes);
}

function tick(state: EngineState, tMs: number, price: number, evaluatedAtMs = tMs) {
  return observe(state, { tickAtMs: tMs, price, evaluatedAtMs });
}

describe('bar bucketing', () => {
  it.each(TIMEFRAMES)('%s buckets by its own bar size', (tf: Timeframe) => {
    const size = TIMEFRAME_BAR_MS[tf];
    expect(barStartMs(tf, T0)).toBe(T0);
    expect(barStartMs(tf, T0 + 1)).toBe(T0);
    expect(barStartMs(tf, T0 + size - 1)).toBe(T0);
    expect(barStartMs(tf, T0 + size)).toBe(T0 + size);
  });

  it('M1 and M5 bucket the same instant differently', () => {
    const t = T0 + 3 * 60_000; // 3 minutes past the hour
    expect(barStartMs('M1', t)).toBe(t);
    expect(barStartMs('M5', t)).toBe(T0); // still inside the first M5 bar
  });
});

describe('§10 ticks are not RSI periods', () => {
  it.each(TIMEFRAMES)('%s does not commit a bar while ticks stay inside it', (tf: Timeframe) => {
    let s = warm(tf);
    const before = s.rsi.closedBarCount;
    for (let i = 1; i <= 10; i += 1) {
      const out = tick(s, T0 + i * 1000, 4450 + i);
      s = out.state;
      expect(out.committedBar).toBe(false);
    }
    expect(s.rsi.closedBarCount).toBe(before);
  });

  it.each(TIMEFRAMES)('%s commits exactly once when the bar rolls over', (tf: Timeframe) => {
    const size = TIMEFRAME_BAR_MS[tf];
    let s = warm(tf);
    s = tick(s, T0 + 1000, 4451).state;
    const before = s.rsi.closedBarCount;

    const rollover = tick(s, T0 + size + 1000, 4455);
    expect(rollover.committedBar).toBe(true);
    expect(rollover.state.rsi.closedBarCount).toBe(before + 1);

    const nextInside = tick(rollover.state, T0 + size + 2000, 4456);
    expect(nextInside.committedBar).toBe(false);
    expect(nextInside.state.rsi.closedBarCount).toBe(before + 1);
  });

  it('the projected RSI depends on price, not on how many ticks arrived', () => {
    let sparse = warm('M1');
    let dense = warm('M1');

    sparse = tick(sparse, T0 + 1000, 4460).state;

    for (const [i, p] of [4451, 4452, 4453, 4454].entries()) {
      dense = tick(dense, T0 + 100 + i * 100, p).state;
    }
    const denseOut = tick(dense, T0 + 1000, 4460);

    const sparseOut = tick(warm('M1'), T0 + 1000, 4460);
    expect(denseOut.observation?.rsi).toBe(sparseOut.observation?.rsi);
  });

  it('uses the bar’s close-so-far as the committed close', () => {
    let s = warm('M1');
    s = tick(s, T0 + 1000, 4451).state;
    s = tick(s, T0 + 30_000, 4470).state; // still inside the bar
    s = tick(s, T0 + 59_000, 4455).state; // last price of the bar

    const rolled = tick(s, T0 + 61_000, 4456);
    expect(rolled.committedBar).toBe(true);
    // The committed close is 4455, the last price seen in the bar — not the
    // 4470 high and not the 4451 open.
    expect(rolled.state.rsi.lastClose).toBe(4455);
  });
});

describe('§10 freshness is bounded on both sides', () => {
  it('accepts a quote inside the staleness budget', () => {
    const out = tick(warm('M1'), T0, 4450, T0 + SPEC.observation.maxStalenessMs);
    expect(out.observation?.fresh).toBe(true);
    expect(out.rejection).toBeNull();
  });

  it('marks a quote beyond the staleness budget as not fresh', () => {
    const out = tick(warm('M1'), T0, 4450, T0 + SPEC.observation.maxStalenessMs + 1);
    expect(out.observation?.fresh).toBe(false);
    // Still accepted into state — continuity is tracked even when the value
    // cannot be acted on.
    expect(out.rejection).toBeNull();
  });

  it('refuses a quote dated further into the future than clock skew explains', () => {
    const out = tick(warm('M1'), T0 + 10_000, 4450, T0);
    expect(out.rejection).toBe('FUTURE_DATED');
    expect(out.observation).toBeNull();
  });

  it('tolerates ordinary clock skew of a second or two', () => {
    const out = tick(warm('M1'), T0 + 1_000, 4450, T0);
    expect(out.rejection).toBeNull();
    expect(out.observation?.fresh).toBe(true);
  });

  it('reports age as the relationship between the two timestamps', () => {
    const out = tick(warm('M1'), T0, 4450, T0 + 4_500);
    expect(out.ageSeconds).toBe(4.5);
  });
});

describe('§15.4 duplicate, out-of-order and invalid ticks', () => {
  it('refuses a duplicate broker timestamp and leaves state untouched', () => {
    let s = warm('M1');
    s = tick(s, T0 + 1000, 4451).state;
    const dup = tick(s, T0 + 1000, 4452);
    expect(dup.rejection).toBe('OUT_OF_ORDER_OR_DUPLICATE');
    expect(dup.state).toBe(s);
  });

  it('refuses an out-of-order tick', () => {
    let s = warm('M1');
    s = tick(s, T0 + 5000, 4451).state;
    const late = tick(s, T0 + 2000, 4452);
    expect(late.rejection).toBe('OUT_OF_ORDER_OR_DUPLICATE');
    expect(late.state).toBe(s);
  });

  it.each([Number.NaN, 0, -1, Number.POSITIVE_INFINITY])('refuses an unusable price (%s)', (price) => {
    const out = tick(warm('M1'), T0 + 1000, price as number);
    expect(out.rejection).toBe('INVALID_PRICE');
    expect(out.observation).toBeNull();
  });
});

describe('§3.3/§6.5 continuity and gaps', () => {
  it.each(TIMEFRAMES)('%s flags the first tick of a run as a continuity reset', (tf: Timeframe) => {
    const out = tick(warm(tf), T0, 4450);
    expect(out.continuityReset).toBe(true);
    // The first tick is not counted as a gap — there was nothing to gap from.
    expect(out.state.continuityResetCount).toBe(0);
  });

  it.each(TIMEFRAMES)('%s flags a gap beyond its own budget and counts it', (tf: Timeframe) => {
    const budget = SPEC.observation.maxContinuityGapMs[tf];
    let s = warm(tf);
    s = tick(s, T0, 4450).state;

    const within = tick(s, T0 + budget - 1, 4451);
    expect(within.continuityReset).toBe(false);

    const beyond = tick(s, T0 + budget + 1, 4451);
    expect(beyond.continuityReset).toBe(true);
    expect(beyond.state.continuityResetCount).toBe(1);
  });

  it('does not synthesise closes for bars that were never observed', () => {
    // A ten-minute gap on M1 skips nine bars. Exactly one bar is committed —
    // the one that was actually forming — and no history is invented.
    let s = warm('M1');
    s = tick(s, T0 + 1000, 4451).state;
    const before = s.rsi.closedBarCount;
    const after = tick(s, T0 + 10 * 60_000, 4460);
    expect(after.state.rsi.closedBarCount).toBe(before + 1);
  });

  it('refuses to treat a post-gap observation as unlock-eligible', () => {
    const budget = SPEC.observation.maxContinuityGapMs.M1;
    let s = warm('M1');
    s = tick(s, T0, 4450).state;
    const afterGap = tick(s, T0 + budget + 1, 4451);
    expect(isUnlockEligible(afterGap)).toBe(false);
  });
});

describe('§3.3/§11 warm-up produces no signals and no unlocks', () => {
  it('a cold engine reports observations that are not warmed up', () => {
    const out = tick(createEngineState('M1'), T0, 4450);
    expect(out.observation?.warmedUp).toBe(false);
    expect(isUnlockEligible(out)).toBe(false);
  });

  it('warming from closed bars never touches the crossing state', () => {
    const cold = createEngineState('M5');
    const warmed = warmUpFromClosedBars(cold, [4450, 4451, 4452, 4453, 4454, 4455, 4456]);
    // The crossing state is the thing that forms signals, and it is byte-for-byte
    // identical: warm-up cannot signal because it never reaches that code.
    expect(warmed.crossing).toEqual(cold.crossing);
    expect(warmed.crossing.previousRsi).toBeNull();
    expect(warmed.crossing.sellArmed).toBe(false);
    expect(warmed.crossing.buyArmed).toBe(false);
  });

  it('warming advances the indicator', () => {
    const warmed = warmUpFromClosedBars(createEngineState('M1'), [4450, 4451, 4449, 4452, 4448, 4453, 4455]);
    expect(currentRsi(warmed.rsi)).not.toBeNull();
    expect(warmed.rsi.closedBarCount).toBe(7);
  });

  it('a warmed engine yields unlock-eligible observations', () => {
    let s = warm('M1');
    s = tick(s, T0, 4450).state;
    const second = tick(s, T0 + 1000, 4451);
    expect(isUnlockEligible(second)).toBe(true);
  });
});

describe('§10 latency and cadence measurement', () => {
  it('measures the interval between accepted observations', () => {
    let s = warm('M1');
    s = tick(s, T0, 4450, T0).state;
    expect(s.lastObservationIntervalMs).toBeNull(); // nothing to compare to yet

    const second = tick(s, T0 + 1000, 4451, T0 + 1000);
    expect(second.state.lastObservationIntervalMs).toBe(1000);
  });

  it('reports the cadence as met at the one-second target and degraded beyond tolerance', () => {
    let s = warm('M1');
    s = tick(s, T0, 4450, T0).state;

    const onTime = tick(s, T0 + 1000, 4451, T0 + 1000).state;
    expect(describeHealth(onTime, V2_OBSERVATION_CADENCE_TOLERANCE_MS).cadenceMet).toBe(true);

    const late = tick(s, T0 + 9000, 4451, T0 + 9000).state;
    expect(describeHealth(late, V2_OBSERVATION_CADENCE_TOLERANCE_MS).cadenceMet).toBe(false);
  });

  it('reports how many bars remain before warm-up completes', () => {
    const cold = describeHealth(createEngineState('M5'), V2_OBSERVATION_CADENCE_TOLERANCE_MS);
    expect(cold.warmedUp).toBe(false);
    expect(cold.barsUntilWarm).toBe(SPEC.rsi.period + 1 + SPEC.rsi.warmupBars);

    const ready = describeHealth(warm('M5'), V2_OBSERVATION_CADENCE_TOLERANCE_MS);
    expect(ready.warmedUp).toBe(true);
    expect(ready.barsUntilWarm).toBe(0);
  });
});

describe('§10 restart resumability', () => {
  it('resumes a state written under the current rules', () => {
    const s = tick(warm('M1'), T0, 4450).state;
    expect(isResumable(s, T0 + 1000)).toEqual({ resumable: true, reason: null });
  });

  it('refuses a state written under different rules', () => {
    const s = { ...createEngineState('M1'), specHash: 'deadbeefdeadbeef' };
    const verdict = isResumable(s, T0);
    expect(verdict.resumable).toBe(false);
    expect(verdict.reason).toMatch(/cannot be reinterpreted/i);
  });

  it('refuses a state whose clock is implausibly far ahead', () => {
    const s = { ...createEngineState('M1'), lastTickT: T0 + 10 * 60_000 };
    const verdict = isResumable(s, T0);
    expect(verdict.resumable).toBe(false);
    expect(verdict.reason).toMatch(/ahead of wall clock/i);
    expect(verdict.reason).toMatch(/freeze/i);
  });

  it('survives a JSON round trip with indicator and crossing state intact', () => {
    let s = warm('M1');
    s = tick(s, T0, 4450).state;
    s = tick(s, T0 + 1000, 4455).state;

    const restored = JSON.parse(JSON.stringify(s)) as EngineState;
    expect(restored.rsi.closedBarCount).toBe(s.rsi.closedBarCount);
    expect(currentRsi(restored.rsi)).toBe(currentRsi(s.rsi));
    expect(restored.crossing.sellArmed).toBe(s.crossing.sellArmed);
    expect(restored.specHash).toBe(SPEC_HASH);
    expect(isResumable(restored, T0 + 2000).resumable).toBe(true);
  });
});

describe('§4 M1 and M5 engines share nothing', () => {
  it('feeding M1 leaves M5 entirely untouched', () => {
    const m5 = warm('M5');
    const m5Before = JSON.parse(JSON.stringify(m5));

    let m1 = warm('M1');
    for (let i = 1; i <= 120; i += 1) m1 = tick(m1, T0 + i * 1000, 4450 + (i % 9)).state;

    expect(JSON.parse(JSON.stringify(m5))).toEqual(m5Before);
    expect(m5.observationCount).toBe(0);
    expect(m1.observationCount).toBe(120);
  });

  it('the same tick stream produces different bar counts on each timeframe', () => {
    let m1 = warm('M1');
    let m5 = warm('M5');
    const m1Before = m1.rsi.closedBarCount;
    const m5Before = m5.rsi.closedBarCount;

    // Ten minutes of ticks, one per 30 seconds.
    for (let i = 0; i <= 20; i += 1) {
      const t = T0 + i * 30_000;
      m1 = tick(m1, t, 4450 + (i % 7)).state;
      m5 = tick(m5, t, 4450 + (i % 7)).state;
    }

    const m1Committed = m1.rsi.closedBarCount - m1Before;
    const m5Committed = m5.rsi.closedBarCount - m5Before;
    expect(m1Committed).toBeGreaterThan(m5Committed);
    expect(m5Committed).toBe(2); // ten minutes spans two completed M5 bars
  });
});
