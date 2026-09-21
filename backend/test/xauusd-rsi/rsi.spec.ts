/**
 * MT5-compatible Wilder RSI(5) — seeding, smoothing, the zero-loss
 * convention, and intrabar projection (spec §8.1).
 *
 * The reference numbers below are computed by hand from Wilder's own
 * definition and written into the test, rather than snapshotted from this
 * implementation's output — a snapshot of the code under test proves only
 * that it still does what it did.
 */
import { describe, expect, it } from 'vitest';
import {
  commitClosedBar,
  createRsiState,
  currentRsi,
  isWarmedUp,
  projectRsi,
  rsiFromAverages,
  rsiSeries,
} from '../../src/xauusd-rsi/rsi';
import { SPEC } from '../../src/xauusd-rsi/spec';
import { applyClosedBar, createEngineState, engineRsiNow, M1_MS } from '../../src/xauusd-rsi/engine';

describe('Wilder seeding', () => {
  it('produces no value until period + 1 closes have been seen', () => {
    let state = createRsiState(5);
    for (const close of [10, 11, 12, 11, 13]) {
      state = commitClosedBar(state, close);
      expect(currentRsi(state)).toBeNull();
    }
    state = commitClosedBar(state, 14);
    expect(currentRsi(state)).not.toBeNull();
  });

  it('seeds with the arithmetic mean of the first `period` changes', () => {
    // closes 10,11,12,11,13,14 -> changes +1,+1,-1,+2,+1
    // avgGain = (1+1+0+2+1)/5 = 1.0 ; avgLoss = (0+0+1+0+0)/5 = 0.2
    // RS = 5 ; RSI = 100 - 100/6 = 83.3333...
    const series = rsiSeries([10, 11, 12, 11, 13, 14], 5);
    expect(series[5]).toBeCloseTo(83.333333, 5);
  });

  it('smooths subsequent changes with Wilder recursion, not a fresh average', () => {
    // From the state above: next close 15 -> gain 1, loss 0
    // avgGain = (1.0*4 + 1)/5 = 1.0 ; avgLoss = (0.2*4 + 0)/5 = 0.16
    // RS = 6.25 ; RSI = 100 - 100/7.25 = 86.206896...
    const series = rsiSeries([10, 11, 12, 11, 13, 14, 15], 5);
    expect(series[6]).toBeCloseTo(86.206897, 5);
  });

  it('defaults to the spec period of 5', () => {
    expect(createRsiState().period).toBe(5);
    expect(SPEC.rsi.period).toBe(5);
  });
});

describe("MT5's zero-loss convention", () => {
  it('returns 100 when average loss is zero', () => {
    expect(rsiFromAverages(1, 0)).toBe(100);
  });

  it('returns 100 for a perfectly FLAT series, matching MT5 rather than a 50 convention', () => {
    // This reproduces the terminal's own behaviour. It is disclosed rather
    // than filtered: a motionless market reads 100, which is inside the
    // extreme-SELL region. See rsi.ts's own note and the spec's §8.1.
    const series = rsiSeries([2000, 2000, 2000, 2000, 2000, 2000], 5);
    expect(series[5]).toBe(100);
  });

  it('returns 0 when there are only losses', () => {
    const series = rsiSeries([20, 19, 18, 17, 16, 15], 5);
    expect(series[5]).toBe(0);
  });

  it('returns 50 for perfectly balanced average gain and loss', () => {
    expect(rsiFromAverages(1, 1)).toBe(50);
  });
});

describe('Intrabar projection (spec §8.1)', () => {
  const seeded = () => {
    let s = createRsiState(5);
    for (const c of [10, 11, 12, 11, 13, 14]) s = commitClosedBar(s, c);
    return s;
  };

  it('does not mutate or advance the committed closed-bar state', () => {
    const before = seeded();
    const snapshot = { ...before };
    projectRsi(before, 20);
    expect(before).toEqual(snapshot);
    expect(before.closedBarCount).toBe(6);
  });

  it('is independent of how many ticks arrive — the same price always gives the same RSI', () => {
    const state = seeded();
    const once = projectRsi(state, 15);
    // Ten "ticks" at the same price, none of which advance the state.
    for (let i = 0; i < 10; i += 1) projectRsi(state, 15);
    expect(projectRsi(state, 15)).toBe(once);
  });

  it('agrees with the committed value once that same price actually closes the bar', () => {
    const state = seeded();
    const projected = projectRsi(state, 15);
    const committed = currentRsi(commitClosedBar(state, 15));
    expect(projected).toBe(committed);
  });

  it('moves with price within the forming bar', () => {
    const state = seeded();
    expect(projectRsi(state, 20)!).toBeGreaterThan(projectRsi(state, 14)!);
    expect(projectRsi(state, 8)!).toBeLessThan(projectRsi(state, 14)!);
  });

  it('yields null before the state is seeded', () => {
    expect(projectRsi(createRsiState(5), 100)).toBeNull();
  });
});

describe('Warm-up gating (spec §8.5)', () => {
  it('is not warmed up immediately after seeding', () => {
    let s = createRsiState(5);
    for (const c of [10, 11, 12, 11, 13, 14]) s = commitClosedBar(s, c);
    expect(isWarmedUp(s)).toBe(false);
  });

  it('becomes warmed up only after period + 1 + warmupBars closed bars', () => {
    const required = SPEC.rsi.period + 1 + SPEC.rsi.warmupBars;
    let s = createRsiState(5);
    for (let i = 0; i < required - 1; i += 1) s = commitClosedBar(s, 2000 + Math.sin(i) * 5);
    expect(isWarmedUp(s)).toBe(false);
    s = commitClosedBar(s, 2001);
    expect(isWarmedUp(s)).toBe(true);
  });
});

describe('Flat closes under Wilder smoothing', () => {
  /**
   * Regression test for a wrong EXPLANATION, not a wrong calculation.
   *
   * The dashboard and the spec both claimed that once any down move exists
   * in the smoothed history, flat closes "raise RSI", citing ~54.5 for a
   * mixed history followed by five flat closes. That is false. A zero-change
   * close contributes zero to both sides, so Wilder multiplies the average
   * gain and the average loss by the same (period-1)/period factor and their
   * ratio — hence RSI — is untouched.
   *
   * The implementation was always right; only the words were wrong. These
   * tests pin the behaviour so the wording cannot drift back.
   */
  const MIXED = [2000, 2003, 2001, 2006, 2002, 2008, 2004, 2009, 2005, 2011, 2007, 2012];

  function seed(closes: readonly number[]) {
    let s = createEngineState('TICK');
    let t = Date.UTC(2026, 0, 1);
    for (const c of closes) {
      s = applyClosedBar(s, t, c).state;
      t += M1_MS;
    }
    return { state: s, t };
  }

  it('leaves RSI EXACTLY unchanged across many consecutive flat closes', () => {
    let { state, t } = seed(MIXED);
    const before = engineRsiNow(state)!;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(100);

    const last = MIXED[MIXED.length - 1];
    for (let i = 0; i < 20; i += 1) {
      state = applyClosedBar(state, t, last).state;
      t += M1_MS;
      // Exact equality, not approximate: the ratio is preserved identically.
      expect(engineRsiNow(state)).toBe(before);
    }
  });

  it('does not drift toward 100, contradicting the old "flat closes raise RSI" claim', () => {
    let { state, t } = seed(MIXED);
    const before = engineRsiNow(state)!;
    const last = MIXED[MIXED.length - 1];
    for (let i = 0; i < 50; i += 1) {
      state = applyClosedBar(state, t, last).state;
      t += M1_MS;
    }
    const after = engineRsiNow(state)!;
    expect(after).toBe(before);
    expect(after).toBeLessThan(SPEC.thresholds.extremeSellCross);
  });

  it('holds from a LOW starting point too — flat closes do not lift it', () => {
    const falling = Array.from({ length: 12 }, (_, i) => 2100 - i * 2);
    let { state, t } = seed(falling);
    const before = engineRsiNow(state)!;
    const last = falling[falling.length - 1];
    for (let i = 0; i < 10; i += 1) {
      state = applyClosedBar(state, t, last).state;
      t += M1_MS;
    }
    expect(engineRsiNow(state)).toBe(before);
  });

  it('keeps reporting 100 in the degenerate zero-average-loss case, as MT5 does', () => {
    // A history with NO down move at all: average loss is already zero, so
    // there is no ratio to preserve and MT5's 100 stands. This is the single
    // exception, and it is reproduced rather than filtered.
    const onlyUp = Array.from({ length: 12 }, (_, i) => 2000 + i);
    let { state, t } = seed(onlyUp);
    expect(engineRsiNow(state)).toBe(100);
    const last = onlyUp[onlyUp.length - 1];
    for (let i = 0; i < 5; i += 1) {
      state = applyClosedBar(state, t, last).state;
      t += M1_MS;
      expect(engineRsiNow(state)).toBe(100);
    }
  });
});
