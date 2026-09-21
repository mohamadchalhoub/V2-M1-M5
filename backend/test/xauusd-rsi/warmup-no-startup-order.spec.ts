/**
 * Warm-up history initialises the indicator and NOTHING else.
 *
 * The user's scope is live DEMO operation: preceding M1 prices are permitted
 * only so RSI(5) can be computed at all. They must never become entries, and
 * an already-extreme first live reading must not fire on startup. The engine
 * must watch a real live crossing before it may act.
 *
 * These are the two ways that could silently go wrong:
 *
 *   1. the seeding path emitting signals for historical bars, and
 *   2. the seeding path leaving `previousRsi` behind, so the FIRST live
 *      observation has a historical `previous` half to cross against.
 *
 * Both are asserted directly rather than inferred.
 */
import { describe, expect, it } from 'vitest';
import { applyClosedBar, applyTick, createEngineState, engineRsiNow, engineWarmedUp, EngineState, M1_MS } from '../../src/xauusd-rsi/engine';
import { SPEC } from '../../src/xauusd-rsi/spec';

const REQUIRED_BARS = SPEC.rsi.period + 1 + SPEC.rsi.warmupBars;
const T0 = Date.UTC(2026, 8, 14, 0, 0, 0);

/** Seeds exactly as `RsiWatchService.reseedFromCandles` does. */
function seed(closes: readonly number[], startT = T0): { state: EngineState; signals: number; lastT: number } {
  let state = createEngineState('TICK');
  let signals = 0;
  let t = startT;
  for (const close of closes) {
    // advancePattern = false, exactly as RsiWatchService.reseedFromCandles
    // does: warm-up makes RSI computable and must leave no pattern state.
    const step = applyClosedBar(state, t, close, false);
    state = step.state;
    signals += step.signals.length;
    t += M1_MS;
  }
  return { state, signals, lastT: t - M1_MS };
}

/** A rising series: every close higher than the last, so RSI drives to 100. */
function rising(count: number, from = 2000): number[] {
  return Array.from({ length: count }, (_, i) => from + i * 0.5);
}

/** A falling series, so RSI drives toward 0. */
function falling(count: number, from = 4000): number[] {
  return Array.from({ length: count }, (_, i) => from - i * 0.5);
}

describe('Warm-up seeding', () => {
  it(`uses ${REQUIRED_BARS} bars (period + 1 + warm-up) to reach a warm indicator`, () => {
    expect(REQUIRED_BARS).toBe(256);
    const short = seed(rising(REQUIRED_BARS - 1));
    expect(engineWarmedUp(short.state)).toBe(false);
    const exact = seed(rising(REQUIRED_BARS));
    expect(engineWarmedUp(exact.state)).toBe(true);
  });

  it('emits no signal for any historical bar, even a series that ends deep in the extreme-SELL region', () => {
    const { state, signals } = seed(rising(REQUIRED_BARS + 50));
    expect(signals).toBe(0);
    // The seed really did end extreme — otherwise this test proves nothing.
    expect(engineRsiNow(state)!).toBeGreaterThan(SPEC.thresholds.extremeSellCross);
  });

  it('emits no signal for a historical series that ends deep in the extreme-BUY region', () => {
    const { state, signals } = seed(falling(REQUIRED_BARS + 50));
    expect(signals).toBe(0);
    expect(engineRsiNow(state)!).toBeLessThan(SPEC.thresholds.extremeBuyCross);
  });

  it('leaves no pattern `previous` reading behind, so live detection starts clean', () => {
    const { state } = seed(rising(REQUIRED_BARS + 50));
    expect(state.pattern.previousRsi).toBeNull();
    expect(state.pattern.previousAtT).toBeNull();
    // Every sub-state starts in its "must reset first" phase, which is
    // stricter than IDLE: the engine has to see RSI leave the region before
    // it will arm at all, so a seed that ends inside one arms nothing.
    expect(state.pattern.sellRetest.phase).toBe('AWAITING_ARM_RESET');
    expect(state.pattern.buyRetest.phase).toBe('AWAITING_ARM_RESET');
    // Nothing part-formed that a first live tick could retest.
    expect(state.pattern.sellRetest.frozenExtreme).toBeNull();
    expect(state.pattern.buyRetest.frozenExtreme).toBeNull();
    expect(state.pattern.extremeSell.phase).toBe('AWAITING_RESET');
    expect(state.pattern.extremeBuy.phase).toBe('AWAITING_RESET');
  });
});

describe('The first live observation after warm-up', () => {
  it('does NOT produce an extreme-SELL order when the very first reading is already extreme', () => {
    const { state, lastT } = seed(rising(REQUIRED_BARS + 50));
    const rsiBefore = engineRsiNow(state)!;
    expect(rsiBefore).toBeGreaterThan(SPEC.thresholds.extremeSellCross);

    const atT = lastT + M1_MS + 1_000;
    const step = applyTick(state, { atT, bid: 4100, tickKey: 'first-live', nowT: atT });

    // Still extreme — this is a genuine already-extreme startup, not a lapse
    // back under the threshold that would make the test vacuous.
    expect(engineRsiNow(step.state)!).toBeGreaterThan(SPEC.thresholds.extremeSellCross);
    expect(step.signals).toHaveLength(0);
  });

  it('does NOT produce an extreme-BUY order when the very first reading is already extreme', () => {
    const { state, lastT } = seed(falling(REQUIRED_BARS + 50));
    expect(engineRsiNow(state)!).toBeLessThan(SPEC.thresholds.extremeBuyCross);

    const atT = lastT + M1_MS + 1_000;
    const step = applyTick(state, { atT, bid: 3800, tickKey: 'first-live', nowT: atT });

    expect(engineRsiNow(step.state)!).toBeLessThan(SPEC.thresholds.extremeBuyCross);
    expect(step.signals).toHaveLength(0);
  });

  it('still detects a genuine crossing that happens live, after `previous` is established', () => {
    // Warm up on an alternating series, so RSI sits mid-range and the extreme
    // sub-state can reset out of AWAITING_RESET on the first live reading.
    const closes = Array.from({ length: REQUIRED_BARS }, (_, i) => 2000 + (i % 2 === 0 ? 0.5 : -0.5));
    const { state, lastT } = seed(closes);
    let s = state;
    let minuteT = lastT + M1_MS;
    let emitted = 0;
    let price = 2000;

    // One live observation per MINUTE, so each one commits and the recursive
    // average actually advances — ticks inside one minute only re-project the
    // same forming bar.
    for (let i = 0; i < 30; i += 1) {
      const atT = minuteT + 1_000;
      const step = applyTick(s, { atT, bid: price, tickKey: `live-${i}`, nowT: atT });
      s = step.state;
      emitted += step.signals.filter((x) => x.evidence.triggered.some((t) => t.kind === 'EXTREME_SELL')).length;
      const committed = applyClosedBar(s, minuteT, price);
      s = committed.state;
      minuteT += M1_MS;
      price += 4;
    }

    expect(engineRsiNow(s)!).toBeGreaterThan(SPEC.thresholds.extremeSellCross);
    // Exactly one crossing: the engine must not re-fire while it stays extreme.
    expect(emitted).toBe(1);
  });
});
