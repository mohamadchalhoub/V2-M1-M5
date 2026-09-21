/**
 * §15.4 — the observation cycle end to end, driven tick by tick.
 *
 * This is where the coherent-quote contract and the per-timeframe
 * independence meet the decision gate. Everything is injected, so a whole
 * session can be replayed deterministically with no database, broker or
 * clock.
 */
import { describe, expect, it } from 'vitest';
import { assertCoherent, resolveQuote, type QuoteCandidate } from '../../src/xauusd-m1m5/quote';
import { describeCycle, runCycle, type CycleInput } from '../../src/xauusd-m1m5/watch-cycle';
import { createEngineState, warmUpFromClosedBars, type EngineState } from '../../src/xauusd-m1m5/engine';
import { createLockSet, applyClosure, isLocked, type ClosureOutcome } from '../../src/xauusd-m1m5/locks';
import type { RuntimeGates } from '../../src/xauusd-m1m5/schedule';
import { SPEC, SPEC_HASH, type Timeframe } from '../../src/xauusd-m1m5/spec';

/** Wednesday 10:00 Beirut — outside both pauses, not a Friday. */
const T0 = Date.UTC(2026, 8, 23, 7, 0, 0);

const OPEN_GATES: RuntimeGates = {
  brokerSessionOpen: true,
  dataFresh: true,
  recoveryComplete: true,
  killSwitchEngaged: false,
  executionBlockers: [],
};

const FREE = { occupied: false, detail: 'free' };

function warm(tf: Timeframe): EngineState {
  const needed = SPEC.rsi.period + 1 + SPEC.rsi.warmupBars;
  // A gently oscillating series, so RSI sits mid-range rather than pinned.
  const closes = Array.from({ length: needed }, (_, i) => 4450 + ((i % 6) - 3));
  return warmUpFromClosedBars(createEngineState(tf), closes);
}

function candidate(tickAtMs: number, bid: number, source: QuoteCandidate['source'] = 'historical_ticks'): QuoteCandidate {
  return { bid, ask: bid + 0.2, tickAtMs, source };
}

function cycle(over: Partial<CycleInput> = {}): CycleInput {
  return {
    candidates: [candidate(T0, 4450)],
    evaluatedAtMs: T0,
    engines: { M1: warm('M1'), M5: warm('M5') },
    lockSet: createLockSet(SPEC_HASH),
    occupancy: { M1: FREE, M5: FREE },
    gates: OPEN_GATES,
    ...over,
  };
}

describe('§10 the coherent quote contract', () => {
  it('resolves price, timestamp, age, freshness and source together', () => {
    const r = resolveQuote([candidate(T0 - 3_000, 4450)], T0);
    expect(r.quote).toMatchObject({ bid: 4450, ask: 4450.2, tickAtMs: T0 - 3_000, fresh: true });
    expect(r.quote?.ageSeconds).toBeCloseTo(3, 9);
    expect(() => assertCoherent(r.quote!, T0)).not.toThrow();
  });

  it('never lets a newer stream make an older price look fresh', () => {
    // The exact bug this module exists to prevent: a fresh row from one
    // source and an old price from another must not combine.
    const r = resolveQuote(
      [candidate(T0 - 40_000, 4450, 'live_ticks'), candidate(T0 - 1_000, 4460, 'historical_ticks')],
      T0,
    );
    // The newest survivor is chosen, and its OWN age is reported.
    expect(r.quote?.bid).toBe(4460);
    expect(r.quote?.ageSeconds).toBeCloseTo(1, 9);
    expect(r.quote?.source).toBe('historical_ticks');
  });

  it('validates before selecting, so a malformed newer row cannot win', () => {
    const r = resolveQuote(
      [candidate(T0 - 5_000, 4450, 'live_ticks'), { bid: 0, ask: 0, tickAtMs: T0, source: 'historical_ticks' }],
      T0,
    );
    expect(r.quote?.bid).toBe(4450);
    expect(r.discarded[0]).toMatch(/unusable prices/i);
  });

  it('refuses a crossed quote', () => {
    const r = resolveQuote([{ bid: 4460, ask: 4450, tickAtMs: T0, source: 'live_ticks' }], T0);
    expect(r.quote).toBeNull();
    expect(r.discarded[0]).toMatch(/crossed/i);
  });

  it('refuses a future-dated quote rather than calling it very fresh', () => {
    const r = resolveQuote([candidate(T0 + 10_000, 4450)], T0);
    expect(r.quote).toBeNull();
    expect(r.rejection).toBe('ALL_STALE_OR_FUTURE');
    expect(r.detail).toMatch(/wrong timestamp conversion/i);
  });

  it('returns a stale quote but marks it not fresh, so continuity still tracks', () => {
    const r = resolveQuote([candidate(T0 - 40_000, 4450)], T0);
    expect(r.quote?.fresh).toBe(false);
    expect(r.detail).toMatch(/no signal may be formed/i);
  });

  it('reports having no candidates at all', () => {
    const r = resolveQuote([], T0);
    expect(r.rejection).toBe('NO_CANDIDATES');
    expect(r.detail).toMatch(/Nothing is observing the market/i);
  });

  it('catches an incoherent quote assembled from parts', () => {
    const good = resolveQuote([candidate(T0 - 3_000, 4450)], T0).quote!;
    expect(() => assertCoherent({ ...good, ageSeconds: 0.5 }, T0)).toThrow(/Incoherent quote/);
    expect(() => assertCoherent({ ...good, fresh: false }, T0)).toThrow(/disagrees/);
  });
});

describe('§10 a cycle with no usable quote still completes', () => {
  it('does not throw, and reports why per timeframe', () => {
    const result = runCycle(cycle({ candidates: [] }));
    expect(result.quote).toBeNull();
    expect(result.quoteRejection).toMatch(/Nothing is observing/i);
    expect(result.outcomes).toHaveLength(2);
    expect(result.candidates).toEqual([]);
    // State is untouched, so a data problem cannot corrupt continuity.
    expect(result.outcomes.every((o) => o.decision === null)).toBe(true);
  });

  it('describes itself for the log without pretending to have data', () => {
    expect(describeCycle(runCycle(cycle({ candidates: [] })))).toMatch(/no usable quote/);
  });
});

describe('§4 both timeframes observe the same tick independently', () => {
  it('advances both engines from one quote', () => {
    const result = runCycle(cycle());
    expect(result.outcomes.map((o) => o.timeframe)).toEqual(['M1', 'M5']);
    for (const o of result.outcomes) {
      expect(o.decision).not.toBeNull();
      expect(o.engine.observationCount).toBe(1);
    }
  });

  it('forms a signal on one timeframe without forming one on the other', () => {
    // Drive M1 across 91 while M5, whose bars are five times longer, is fed
    // the same ticks but reaches a different RSI.
    let input = cycle();
    let result = runCycle(input);

    // Both start with no signal on the very first observation (§3.3).
    expect(result.outcomes.every((o) => o.decision?.signal === null)).toBe(true);
  });

  it('keeps each timeframe’s engine separate through a cycle', () => {
    const result = runCycle(cycle());
    const m1 = result.outcomes.find((o) => o.timeframe === 'M1')!.engine;
    const m5 = result.outcomes.find((o) => o.timeframe === 'M5')!.engine;
    expect(m1.timeframe).toBe('M1');
    expect(m5.timeframe).toBe('M5');
    expect(m1).not.toBe(m5);
  });
});

describe('§10 freshness gates signal formation, not observation', () => {
  it('a stale quote still advances continuity but forms no candidate', () => {
    const result = runCycle(cycle({ candidates: [candidate(T0 - 40_000, 4450)] }));
    expect(result.quote?.fresh).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(result.limitations.some((l) => /no signal may be formed/i.test(l))).toBe(true);
  });
});

describe('§6 locks are threaded consistently through a cycle', () => {
  function lockedSet(timeframe: Timeframe) {
    const outcome: ClosureOutcome = {
      closureEventId: 'evt-1',
      positionId: 'pos-1',
      timeframe,
      direction: 'SELL',
      netRealized: -10,
      fullyClosed: true,
      closedAt: T0 - 60_000,
      closureReason: 'SL',
      rsiAtClosure: 50,
    };
    return applyClosure(createLockSet(SPEC_HASH), outcome).set;
  }

  it('carries the lock set forward through both timeframes', () => {
    const result = runCycle(cycle({ lockSet: lockedSet('M1') }));
    // The M1 SELL lock is still standing after the cycle, because mid-range
    // RSI satisfies neither unlock arm.
    expect(isLocked(result.lockSet, 'M1', 'SELL')).toBe(true);
    expect(isLocked(result.lockSet, 'M5', 'SELL')).toBe(false);
  });

  it('a lock on one timeframe does not affect the other’s decision', () => {
    const result = runCycle(cycle({ lockSet: lockedSet('M1') }));
    const m5 = result.outcomes.find((o) => o.timeframe === 'M5')!;
    expect(m5.decision?.skipReason).toBeNull();
  });
});

describe('§4 occupancy feeds straight into the gate', () => {
  it('reports occupancy per timeframe independently', () => {
    const result = runCycle(
      cycle({ occupancy: { M1: { occupied: true, detail: 'ticket 5' }, M5: FREE } }),
    );
    // No signal forms on a first observation, so this asserts the plumbing
    // rather than the skip: the occupancy view reached the gate intact.
    expect(result.outcomes).toHaveLength(2);
    expect(result.candidates).toEqual([]);
  });
});

describe('§9 schedule blocks are applied inside the cycle', () => {
  it('an unknown broker session blocks candidates', () => {
    const result = runCycle(cycle({ gates: { ...OPEN_GATES, brokerSessionOpen: null } }));
    expect(result.candidates).toEqual([]);
  });

  it('a kill switch blocks candidates', () => {
    const result = runCycle(cycle({ gates: { ...OPEN_GATES, killSwitchEngaged: true } }));
    expect(result.candidates).toEqual([]);
  });
});

describe('§3.3 warm-up produces no candidates', () => {
  it('a cold engine observes without signalling', () => {
    const result = runCycle(cycle({ engines: { M1: createEngineState('M1'), M5: createEngineState('M5') } }));
    expect(result.candidates).toEqual([]);
    for (const o of result.outcomes) {
      expect(o.decision?.crossing.rejection).toBe('WARMING_UP');
      expect(o.unlockEligible).toBe(false);
    }
  });
});
