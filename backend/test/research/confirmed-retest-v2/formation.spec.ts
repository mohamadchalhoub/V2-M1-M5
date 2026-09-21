// v2 formation rule: retest of the original pivot price L (replaces v1's
// exact-price pivot pairing). Every expectation below is derived by hand
// from the fixture numbers, not by calling the code under test a second
// time. Pivot at H4 index 3 (resistance, L=2100) is used throughout;
// confirmed once bar index 5 closes (span 5, pivotBar = window[2]).
import { describe, expect, it } from 'vitest';
import { createLevelEngineState, onH4Close, type LevelEngineState } from '../../../src/research/confirmed-retest-v2/levels';
import type { Bar } from '../../../src/research/confirmed-retest-v2/types';
import { H4, h4Series, usd } from './helpers';

const START = '2025-01-06T00:00:00.000Z';

function feed(state: LevelEngineState, bars: Bar[]): string[][] {
  return bars.map((b) => onH4Close(state, b).activated);
}

describe('retest formation — basic activation', () => {
  it('a retest that itself closes $10 favorable activates immediately, at the retest bar', () => {
    const state = createLevelEngineState();
    // pivot index 3 (h=2100), retest index 8 (dist 5): touches 2100, closes 2000 (<=2090 required).
    const bars = h4Series(START, 20, { 3: { h: 2100 }, 8: { h: 2100 } });
    const activations = feed(state, bars);
    expect(activations[8]).toEqual(expect.arrayContaining([expect.stringContaining('lvl:R:')]));
    activations.forEach((ids, i) => expect(ids.length).toBe(i === 8 ? 1 : 0));

    const level = Object.values(state.levels)[0];
    expect(level.price).toBe(usd(2100));
    expect(level.role).toBe('RESISTANCE');
    expect(level.pivotIndex).toBe(3);
    expect(level.retestIndex).toBe(8);
    expect(level.confirmationH4Index).toBe(8);
    expect(level.activatedT).toBe(bars[8].t + H4);
  });

  it("the retest's own extreme need not equal L — support mirrors resistance", () => {
    const state = createLevelEngineState();
    const bars = h4Series(START, 20, { 3: { l: 1900 }, 8: { l: 1895 } }); // undershoots L, body still respects it
    feed(state, bars);
    const level = Object.values(state.levels)[0];
    expect(level.role).toBe('SUPPORT');
    expect(level.price).toBe(usd(1900)); // L frozen at the pivot's own price, not the retest's low
    expect(level.retestIndex).toBe(8);
  });
});

describe('a second wick that overshoots L and rejects without a body violation', () => {
  it('high beyond L is still a valid retest as long as open/close stay at or inside L', () => {
    const state = createLevelEngineState();
    // Retest bar 8: high 2110 (overshoots L=2100), open/close flat at 2000 (well inside L) — a genuine
    // rejection wick, not a body violation (body filter only checks open/close, per spec §formation).
    const bars = h4Series(START, 20, { 3: { h: 2100 }, 8: { h: 2110 } });
    feed(state, bars);
    expect(state.diagnostics.bodyViolationBeforeRetest.RESISTANCE).toBe(0);
    expect(state.diagnostics.retestFound.RESISTANCE).toBe(1);
    const level = Object.values(state.levels)[0];
    expect(level.retestIndex).toBe(8);
    expect(level.price).toBe(usd(2100)); // L unchanged by the overshoot
  });
});

describe('failed confirmation', () => {
  it('retest found, but none of R/R+1/R+2 close $10 favorable — retired, no level, no further search', () => {
    const state = createLevelEngineState();
    const bars = h4Series(START, 20, {
      3: { h: 2100 },
      8: { h: 2100, c: 2095 }, // R: touches, but close only 5 short of L, not $10
      9: { c: 2095 },
      10: { c: 2095 },
      // A second, later retest-shaped bar exists but must NOT be tried — v2 §5: "do not keep
      // searching later retests until one succeeds" once the first attempt (R=8) has failed.
      20: { h: 2100, c: 1000 },
    });
    feed(state, bars.slice(0, 21));
    expect(Object.keys(state.levels)).toHaveLength(0);
    expect(state.diagnostics.retestFound.RESISTANCE).toBe(1);
    expect(state.diagnostics.confirmationFailedAfterRetest.RESISTANCE).toBe(1);
    expect(state.diagnostics.levelsActivated.RESISTANCE).toBe(0);
  });
});

describe('activation timing — first qualifying close, never backdated to R', () => {
  it('activates at R+2 when R and R+1 both fail and only R+2 qualifies', () => {
    const state = createLevelEngineState();
    const bars = h4Series(START, 20, {
      3: { h: 2100 },
      8: { h: 2100, c: 2095 }, // R: fails ($5 short)
      9: { c: 2095 }, // R+1: fails
      10: { c: 2085 }, // R+2: qualifies ($15 away)
    });
    const activations = feed(state, bars.slice(0, 11));
    activations.forEach((ids, i) => expect(ids.length).toBe(i === 10 ? 1 : 0));
    const level = Object.values(state.levels)[0];
    expect(level.retestIndex).toBe(8);
    expect(level.confirmationH4Index).toBe(10);
    expect(level.activatedT).toBe(bars[10].t + H4); // not bars[8].t — never backdated to R
  });
});

describe('no future-data use', () => {
  it('the level does not exist in state until the confirming bar is actually fed', () => {
    const state = createLevelEngineState();
    const bars = h4Series(START, 20, {
      3: { h: 2100 },
      8: { h: 2100, c: 2095 },
      9: { c: 2095 },
      10: { c: 2085 },
    });
    feed(state, bars.slice(0, 10)); // through R+1 (index 9) only — confirming bar (10) not yet fed
    expect(Object.keys(state.levels)).toHaveLength(0);
    expect(state.diagnostics.levelsActivated.RESISTANCE).toBe(0);
    onH4Close(state, bars[10]);
    expect(Object.keys(state.levels)).toHaveLength(1); // activates exactly once bar 10 closes, not before
  });
});

describe('retest distance window', () => {
  it('a bar 4 indices after the pivot is not eligible as a retest even if it satisfies the OHLC condition; 5 is', () => {
    const state = createLevelEngineState();
    // index 7 (dist 4) satisfies the retest condition but must be skipped; index 8 (dist 5) is the real retest.
    const bars = h4Series(START, 20, { 3: { h: 2100 }, 7: { h: 2100 }, 8: { h: 2100 } });
    feed(state, bars);
    const level = Object.values(state.levels)[0];
    expect(level.retestIndex).toBe(8);
  });

  it('no qualifying bar within 120 indices retires the candidate', () => {
    const state = createLevelEngineState();
    const bars = h4Series(START, 130, { 3: { h: 2100 } }); // flat background never touches 2100 again
    feed(state, bars);
    expect(Object.keys(state.levels)).toHaveLength(0);
    expect(state.diagnostics.noRetestWithinWindow.RESISTANCE).toBe(1);
  });
});

describe('body filter between pivot and confirmation', () => {
  it('a body (open/close) beyond L before the retest invalidates the candidate — no later retest is tried', () => {
    const state = createLevelEngineState();
    const bars = h4Series(START, 20, {
      3: { h: 2100 },
      6: { o: 2105, c: 2110 }, // body strictly beyond L=2100 — invalidates
      8: { h: 2100 }, // would otherwise be a valid retest — must be ignored
    });
    feed(state, bars);
    expect(Object.keys(state.levels)).toHaveLength(0);
    expect(state.diagnostics.bodyViolationBeforeRetest.RESISTANCE).toBe(1);
    expect(state.diagnostics.retestFound.RESISTANCE).toBe(0);
  });

  it('equality at the body edge is allowed, not a violation', () => {
    const state = createLevelEngineState();
    const bars = h4Series(START, 20, {
      3: { h: 2100 },
      6: { o: 2100, c: 2100 }, // body exactly AT L — allowed per spec ("equality at a body edge is allowed")
      8: { h: 2100 },
    });
    feed(state, bars);
    expect(state.diagnostics.bodyViolationBeforeRetest.RESISTANCE).toBe(0);
    expect(Object.keys(state.levels)).toHaveLength(1);
  });

  it('a body violation during the R+1/R+2 confirmation window also invalidates — counted separately from a pre-retest violation', () => {
    const state = createLevelEngineState();
    const bars = h4Series(START, 20, {
      3: { h: 2100 },
      8: { h: 2100, c: 2095 }, // R: touches, doesn't confirm yet
      9: { o: 2105, c: 2110 }, // R+1: body beyond L — invalidates before ever reaching R+2
    });
    feed(state, bars.slice(0, 10));
    expect(Object.keys(state.levels)).toHaveLength(0);
    expect(state.diagnostics.retestFound.RESISTANCE).toBe(1); // the retest itself was still found
    expect(state.diagnostics.bodyViolationDuringConfirmation.RESISTANCE).toBe(1);
    expect(state.diagnostics.bodyViolationBeforeRetest.RESISTANCE).toBe(0); // distinct counter — not conflated
    expect(state.diagnostics.confirmationFailedAfterRetest.RESISTANCE).toBe(0); // this is a body violation, not a plain confirmation timeout
  });
});

describe('same-price/same-role dedup', () => {
  it('a second pivot at the same price while the first is still ACTIVE does not form a new level', () => {
    const state = createLevelEngineState();
    const bars = h4Series(START, 30, {
      3: { h: 2100 },
      8: { h: 2100 }, // confirms + activates the first pivot's level at index 8
      15: { h: 2100 }, // a second, later pivot at the exact same price
      20: { h: 2100 }, // its own would-be retest
    });
    feed(state, bars);
    expect(Object.keys(state.levels)).toHaveLength(1); // only the earliest candidate owns the level
    expect(state.diagnostics.activationsBlocked.REDUNDANT_WHILE_ACTIVE).toBeGreaterThanOrEqual(1);
  });
});

describe('pivot qualification (unchanged from v1)', () => {
  it('a pivot with no $10 rejection close on its two confirming bars never starts a watch', () => {
    const state = createLevelEngineState();
    // pivot at 3 (h=2100), but bars 4-5 (the confirming pair) close only 2098 — well short of $10.
    // (No bar 8 override here — a second unrelated bar touching 2100 would itself form its own
    // independent strict pivot and confound the count; this test is about pivot 3 alone.)
    const bars = h4Series(START, 20, { 3: { h: 2100 }, 4: { c: 2098 }, 5: { c: 2098 } });
    feed(state, bars);
    expect(state.diagnostics.rejectedNoRejectionClose.RESISTANCE).toBe(1);
    expect(state.diagnostics.qualifiedPivots.RESISTANCE).toBe(0);
    expect(Object.keys(state.levels)).toHaveLength(0);
  });
});
