import { describe, expect, it } from 'vitest';
import { createLevelEngineState, levelKey, type LevelEngineState } from '../../src/research/confirmed-retest-v2/levels';
import type { Level, Role } from '../../src/research/confirmed-retest-v2/types';
import { createLiveTouchTrackerState, detectLiveTouches } from '../../src/gold-execution/gold-live-touch';

const HOUR_MS = 3_600_000;
// 2026-09-15 is a Tuesday; 06:00 UTC = 09:00 Asia/Beirut (UTC+3 in September) — inside the 04:00-12:00 window.
const IN_WINDOW_T = Date.parse('2026-09-15T06:00:00.000Z');
// 14:00 UTC = 17:00 Beirut — outside the window.
const OUTSIDE_WINDOW_T = Date.parse('2026-09-15T14:00:00.000Z');
const ACTIVATED_T = IN_WINDOW_T - HOUR_MS;

function addActiveLevel(state: LevelEngineState, overrides: Partial<Level> = {}): Level {
  const role: Role = overrides.role ?? 'SUPPORT';
  const price = overrides.price ?? 265000; // $2650.00 in integer cents
  const key = levelKey(role, price);
  const level: Level = {
    id: overrides.id ?? `lvl:${role}:${price}:g1`,
    key,
    role,
    price,
    generation: 1,
    pivotId: 'pivot-1',
    pivotIndex: 1,
    pivotT: ACTIVATED_T - HOUR_MS,
    retestId: 'retest-1',
    retestIndex: 2,
    retestT: ACTIVATED_T - HOUR_MS / 2,
    confirmationH4Index: 3,
    confirmationT: ACTIVATED_T,
    activationH4Index: 3,
    activatedT: ACTIVATED_T,
    d1Agreement: false,
    d1AgreementPivotT: null,
    status: 'ACTIVE',
    statusT: null,
    barsSinceActivation: 0,
    firstReturnEventId: null,
    laterBreakT: null,
    ...overrides,
  };
  state.levels[level.id] = level;
  state.activeLevelIds.push(level.id);
  state.keys[key] = { key, role, price, phase: 'ACTIVE', generation: 1, levelId: level.id, breakH4Index: null, breakT: null, retiredT: null };
  return level;
}

const MAX_STALENESS_MS = 30_000;
const MAX_GAP_MS = 150_000;

describe('detectLiveTouches', () => {
  it('does not detect a touch when price never reaches the level', () => {
    const state = createLevelEngineState();
    addActiveLevel(state); // SUPPORT at $2650.00
    const tracker = createLiveTouchTrackerState();

    const r1 = detectLiveTouches({
      levels: state, tracker, currentTick: { bid: 2660, atT: IN_WINDOW_T }, nowT: IN_WINDOW_T,
      maxTickStalenessMs: MAX_STALENESS_MS, maxObservationGapMs: MAX_GAP_MS,
    });
    expect(r1.events).toHaveLength(0);
    expect(state.activeLevelIds).toHaveLength(1); // still active — first observation is only a baseline

    const r2 = detectLiveTouches({
      levels: state, tracker: r1.tracker, currentTick: { bid: 2655, atT: IN_WINDOW_T + 30_000 }, nowT: IN_WINDOW_T + 30_000,
      maxTickStalenessMs: MAX_STALENESS_MS, maxObservationGapMs: MAX_GAP_MS,
    });
    expect(r2.events).toHaveLength(0);
    expect(state.activeLevelIds).toHaveLength(1);
  });

  it('detects a first touch when the current tick has reached/crossed a SUPPORT level (BUY)', () => {
    const state = createLevelEngineState();
    const level = addActiveLevel(state, { role: 'SUPPORT', price: 265000 });
    const tracker = createLiveTouchTrackerState();

    const baseline = detectLiveTouches({
      levels: state, tracker, currentTick: { bid: 2655, atT: IN_WINDOW_T }, nowT: IN_WINDOW_T,
      maxTickStalenessMs: MAX_STALENESS_MS, maxObservationGapMs: MAX_GAP_MS,
    });
    expect(baseline.events).toHaveLength(0);

    const touchT = IN_WINDOW_T + 60_000;
    const result = detectLiveTouches({
      levels: state, tracker: baseline.tracker, currentTick: { bid: 2649.9, atT: touchT }, nowT: touchT,
      maxTickStalenessMs: MAX_STALENESS_MS, maxObservationGapMs: MAX_GAP_MS,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].levelId).toBe(level.id);
    expect(result.events[0].direction).toBe('BUY');
    expect(result.events[0].inWindow).toBe(true);
    expect(result.events[0].touchAtT).toBe(touchT);
    expect(state.levels[level.id].status).toBe('CONSUMED');
    expect(state.activeLevelIds).not.toContain(level.id);
  });

  it('detects a first touch on a RESISTANCE level as SELL', () => {
    const state = createLevelEngineState();
    const level = addActiveLevel(state, { role: 'RESISTANCE', price: 265000 });
    const tracker = createLiveTouchTrackerState();

    const baseline = detectLiveTouches({
      levels: state, tracker, currentTick: { bid: 2645, atT: IN_WINDOW_T }, nowT: IN_WINDOW_T,
      maxTickStalenessMs: MAX_STALENESS_MS, maxObservationGapMs: MAX_GAP_MS,
    });
    const touchT = IN_WINDOW_T + 60_000;
    const result = detectLiveTouches({
      levels: state, tracker: baseline.tracker, currentTick: { bid: 2650.1, atT: touchT }, nowT: touchT,
      maxTickStalenessMs: MAX_STALENESS_MS, maxObservationGapMs: MAX_GAP_MS,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].levelId).toBe(level.id);
    expect(result.events[0].direction).toBe('SELL');
  });

  it('does NOT detect a brief touch-and-reversal that completes entirely between two observations (disclosed sampling limitation — left to M1 replay)', () => {
    const state = createLevelEngineState();
    const level = addActiveLevel(state, { role: 'SUPPORT', price: 265000 });
    const tracker = createLiveTouchTrackerState();

    // Baseline: clearly above the level.
    const baseline = detectLiveTouches({
      levels: state, tracker, currentTick: { bid: 2655, atT: IN_WINDOW_T }, nowT: IN_WINDOW_T,
      maxTickStalenessMs: MAX_STALENESS_MS, maxObservationGapMs: MAX_GAP_MS,
    });

    // Between polls, price hypothetically dipped to $2649 and fully reversed — but the next
    // observation this module actually samples is back above the level, exactly like a touch
    // never happened, because latest-tick sampling cannot see anything between two polls.
    const nextT = IN_WINDOW_T + 60_000;
    const result = detectLiveTouches({
      levels: state, tracker: baseline.tracker, currentTick: { bid: 2656, atT: nextT }, nowT: nextT,
      maxTickStalenessMs: MAX_STALENESS_MS, maxObservationGapMs: MAX_GAP_MS,
    });

    expect(result.events).toHaveLength(0);
    expect(state.levels[level.id].status).toBe('ACTIVE'); // still active — the level remains fully visible to the M1 replay layer, which uses real wick highs/lows and would still catch this
  });

  it('treats a large observation gap as unresolved and defers rather than guessing (reconnect backlog)', () => {
    const state = createLevelEngineState();
    const level = addActiveLevel(state, { role: 'SUPPORT', price: 265000 });
    const tracker = createLiveTouchTrackerState();

    const baseline = detectLiveTouches({
      levels: state, tracker, currentTick: { bid: 2655, atT: IN_WINDOW_T }, nowT: IN_WINDOW_T,
      maxTickStalenessMs: MAX_STALENESS_MS, maxObservationGapMs: MAX_GAP_MS,
    });

    // A long outage (e.g. collector down), then a fresh tick that HAS crossed the level.
    const resumeT = IN_WINDOW_T + MAX_GAP_MS + 60_000;
    const result = detectLiveTouches({
      levels: state, tracker: baseline.tracker, currentTick: { bid: 2649, atT: resumeT }, nowT: resumeT,
      maxTickStalenessMs: MAX_STALENESS_MS, maxObservationGapMs: MAX_GAP_MS,
    });

    expect(result.events).toHaveLength(0); // never manufactures a touch across an unresolved gap
    expect(result.notes.some((n) => n.includes('observation gap'))).toBe(true);
    expect(state.levels[level.id].status).toBe('ACTIVE'); // left for the M1 layer to resolve, not guessed here

    // A subsequent, normal-gap observation on the far side still works as a fresh baseline.
    const afterT = resumeT + 60_000;
    const followUp = detectLiveTouches({
      levels: state, tracker: result.tracker, currentTick: { bid: 2648, atT: afterT }, nowT: afterT,
      maxTickStalenessMs: MAX_STALENESS_MS, maxObservationGapMs: MAX_GAP_MS,
    });
    expect(followUp.events).toHaveLength(1); // now correctly detected against the re-established baseline
  });

  it('detects and consumes a touch outside the entry window without it being submittable — level is retired, inWindow is false', () => {
    const state = createLevelEngineState();
    const level = addActiveLevel(state, { role: 'SUPPORT', price: 265000, activatedT: OUTSIDE_WINDOW_T - HOUR_MS });
    const tracker = createLiveTouchTrackerState();

    const baseline = detectLiveTouches({
      levels: state, tracker, currentTick: { bid: 2655, atT: OUTSIDE_WINDOW_T }, nowT: OUTSIDE_WINDOW_T,
      maxTickStalenessMs: MAX_STALENESS_MS, maxObservationGapMs: MAX_GAP_MS,
    });
    const touchT = OUTSIDE_WINDOW_T + 60_000;
    const result = detectLiveTouches({
      levels: state, tracker: baseline.tracker, currentTick: { bid: 2649, atT: touchT }, nowT: touchT,
      maxTickStalenessMs: MAX_STALENESS_MS, maxObservationGapMs: MAX_GAP_MS,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].inWindow).toBe(false);
    expect(state.levels[level.id].status).toBe('CONSUMED'); // still consumed — outsideWindowFirstReturnConsumesLevel
    expect(state.activeLevelIds).not.toContain(level.id);
  });

  it('never uses a stale tick to declare a touch', () => {
    const state = createLevelEngineState();
    addActiveLevel(state, { role: 'SUPPORT', price: 265000 });
    const tracker = createLiveTouchTrackerState();

    const baseline = detectLiveTouches({
      levels: state, tracker, currentTick: { bid: 2655, atT: IN_WINDOW_T }, nowT: IN_WINDOW_T,
      maxTickStalenessMs: MAX_STALENESS_MS, maxObservationGapMs: MAX_GAP_MS,
    });
    const staleTickAtT = IN_WINDOW_T + 60_000;
    const nowFarLater = staleTickAtT + MAX_STALENESS_MS + 5000; // the tick itself is now stale relative to "now"
    const result = detectLiveTouches({
      levels: state, tracker: baseline.tracker, currentTick: { bid: 2649, atT: staleTickAtT }, nowT: nowFarLater,
      maxTickStalenessMs: MAX_STALENESS_MS, maxObservationGapMs: MAX_GAP_MS,
    });
    expect(result.events).toHaveLength(0);
    expect(result.notes.some((n) => n.includes('stale') || n.includes('old'))).toBe(true);
  });

  it('handles no live tick available at all', () => {
    const state = createLevelEngineState();
    addActiveLevel(state);
    const tracker = createLiveTouchTrackerState();
    const result = detectLiveTouches({
      levels: state, tracker, currentTick: null, nowT: IN_WINDOW_T,
      maxTickStalenessMs: MAX_STALENESS_MS, maxObservationGapMs: MAX_GAP_MS,
    });
    expect(result.events).toHaveLength(0);
  });
});
