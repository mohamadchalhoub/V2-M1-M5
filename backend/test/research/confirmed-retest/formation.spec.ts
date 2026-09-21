// Spec §4–§5: pivots, exact-price pairs, rejection, body filter, activation
// timing and lifecycle. Every expectation below is derived by hand from the
// fixture numbers, not by calling the code under test a second time.
import { describe, expect, it } from 'vitest';
import { consumeLevel, createLevelEngineState, onD1Close, onH4Close, type LevelEngineState } from '../../../src/research/confirmed-retest/levels';
import type { Bar } from '../../../src/research/confirmed-retest/types';
import { D1, H4, bar, h4Series, usd } from './helpers';

const START = '2025-01-06T00:00:00.000Z';

function feed(state: LevelEngineState, bars: Bar[]): string[][] {
  return bars.map((b) => onH4Close(state, b).activated);
}

/** Two resistance pivots at 2100 at indices 3 and 3+distance; background closes at 2000 give the $10 rejection. */
function twoResistancePivots(distance: number, extra: Record<number, Partial<{ o: number; h: number; l: number; c: number }>> = {}, total = 3 + distance + 6) {
  return h4Series(START, total, { 3: { h: 2100 }, [3 + distance]: { h: 2100 }, ...extra });
}

describe('formation timing', () => {
  it('activates exactly at the close of the bar two after the second pivot — never earlier', () => {
    const state = createLevelEngineState();
    const bars = twoResistancePivots(10);
    const activations = feed(state, bars);
    // second pivot index 13; confirmation bar index 15
    activations.forEach((ids, index) => expect(ids.length).toBe(index === 15 ? 1 : 0));
    const level = Object.values(state.levels)[0];
    expect(level.activatedT).toBe(bars[15].t + H4);
    expect(level.price).toBe(usd(2100));
    expect(level.role).toBe('RESISTANCE');
    expect(level.firstPivotIndex).toBe(3);
    expect(level.secondPivotIndex).toBe(13);
  });

  it('a pivot is not knowable until its second following candle closes', () => {
    const state = createLevelEngineState();
    const bars = h4Series(START, 6, { 3: { h: 2100 } });
    feed(state, bars.slice(0, 5)); // bars 0..4: bar 3's second right neighbour (index 5) not yet closed
    expect(state.pivotLog.filter((p) => p.role === 'RESISTANCE')).toHaveLength(0);
    onH4Close(state, bars[5]);
    expect(state.pivotLog.filter((p) => p.role === 'RESISTANCE').map((p) => p.index)).toEqual([3]);
  });
});

describe('exact price and strictness', () => {
  it('pivot extremes one cent apart never form a level (no tolerance)', () => {
    const state = createLevelEngineState();
    feed(state, h4Series(START, 20, { 3: { h: 2100 }, 13: { h: 2100.01 } }));
    expect(Object.keys(state.levels)).toHaveLength(0);
    expect(state.diagnostics.exactPriceRepeatPairsAnyDistance.RESISTANCE).toBe(0);
  });

  it('a neighbour with an equal high means no strict pivot', () => {
    const state = createLevelEngineState();
    feed(state, h4Series(START, 20, { 3: { h: 2100 }, 4: { h: 2100 }, 13: { h: 2100 } }));
    expect(state.pivotLog.filter((p) => p.index === 3 || p.index === 4)).toHaveLength(0);
    expect(Object.keys(state.levels)).toHaveLength(0);
  });

  it('support mirrors resistance on exact equal lows', () => {
    const state = createLevelEngineState();
    feed(state, h4Series(START, 20, { 3: { l: 1900 }, 13: { l: 1900 } }));
    const levels = Object.values(state.levels);
    expect(levels).toHaveLength(1);
    expect(levels[0].role).toBe('SUPPORT');
    expect(levels[0].price).toBe(usd(1900));
  });
});

describe('pivot distance', () => {
  it('distance 4 is rejected, 5 is accepted', () => {
    const s4 = createLevelEngineState();
    feed(s4, twoResistancePivots(4));
    expect(Object.keys(s4.levels)).toHaveLength(0);
    expect(s4.diagnostics.pairOutcomes.DISTANCE_LT_5).toBe(1);
    const s5 = createLevelEngineState();
    feed(s5, twoResistancePivots(5));
    expect(Object.keys(s5.levels)).toHaveLength(1);
  });

  it('distance 120 is accepted, 121 is not', () => {
    const s120 = createLevelEngineState();
    feed(s120, twoResistancePivots(120));
    expect(Object.keys(s120.levels)).toHaveLength(1);
    const s121 = createLevelEngineState();
    feed(s121, twoResistancePivots(121));
    expect(Object.keys(s121.levels)).toHaveLength(0);
  });
});

describe('meaningful rejection ($10 close by confirmation)', () => {
  const noRejection = (closeAfter: number) => ({ 4: { c: closeAfter, h: 2099, o: 2000 }, 5: { c: closeAfter, h: 2099, o: 2000 } });

  it('closes exactly $10 below resistance qualify; $9.99 below does not', () => {
    const exact = createLevelEngineState();
    feed(exact, twoResistancePivots(10, noRejection(2090)));
    expect(exact.pivotLog.find((p) => p.index === 3)?.qualified).toBe(true);
    expect(Object.keys(exact.levels)).toHaveLength(1);

    const short = createLevelEngineState();
    feed(short, twoResistancePivots(10, noRejection(2090.01)));
    expect(short.pivotLog.find((p) => p.index === 3)?.qualified).toBe(false);
    expect(Object.keys(short.levels)).toHaveLength(0);
    expect(short.diagnostics.pairOutcomes.FIRST_NOT_QUALIFIED).toBe(1);
  });

  it('a $10 close only after the confirmation bar does not qualify the pivot', () => {
    const state = createLevelEngineState();
    feed(state, twoResistancePivots(10, { ...noRejection(2095), 6: { c: 2000 } }));
    expect(state.pivotLog.find((p) => p.index === 3)?.qualified).toBe(false);
  });
});

describe('body filter', () => {
  it('a body top one cent above resistance between the pivots invalidates the pair', () => {
    const state = createLevelEngineState();
    feed(state, twoResistancePivots(10, { 8: { o: 2000, c: 2100.01, h: 2100.01 } }));
    expect(Object.keys(state.levels)).toHaveLength(0);
    expect(state.diagnostics.pairOutcomes.BODY_FILTER).toBe(1);
  });

  it('a body top exactly at the level is allowed, and a wick above the level is allowed', () => {
    const state = createLevelEngineState();
    // bar 8 closes exactly at 2100; bar 9's wick reaches 2150 (making bar 8 a non-pivot) with its body at 2000
    feed(state, twoResistancePivots(10, { 8: { o: 2000, c: 2100, h: 2100 }, 9: { o: 2000, c: 2000, h: 2150 } }));
    const levels = Object.values(state.levels);
    expect(levels.map((l) => l.price)).toEqual([usd(2100)]);
    expect([levels[0].firstPivotIndex, levels[0].secondPivotIndex]).toEqual([3, 13]);
  });

  it('support: a body bottom one cent below the level between the pivots invalidates the pair', () => {
    const state = createLevelEngineState();
    feed(state, h4Series(START, 20, { 3: { l: 1900 }, 13: { l: 1900 }, 8: { o: 2000, c: 1899.99, l: 1899.99 } }));
    expect(Object.keys(state.levels)).toHaveLength(0);
    expect(state.diagnostics.pairOutcomes.BODY_FILTER).toBe(1);
  });
});

describe('multiple partners', () => {
  it('records the earliest valid first pivot and lists the other valid partners', () => {
    const state = createLevelEngineState();
    // 3 and 7 are too close (distance 4); pivot 17 then has two valid partners
    feed(state, h4Series(START, 25, { 3: { h: 2100 }, 7: { h: 2100 }, 17: { h: 2100 } }));
    const levels = Object.values(state.levels);
    expect(levels).toHaveLength(1);
    expect(levels[0].firstPivotIndex).toBe(3);
    expect(levels[0].secondPivotIndex).toBe(17);
    expect(levels[0].alternativeFirstPivotIds).toEqual(['pv:RESISTANCE:7']);
  });
});

describe('lifecycle', () => {
  const activatedAt = 15; // index of the confirmation bar for pivots 3/13

  it('expires after 120 further completed H4 bars', () => {
    const state = createLevelEngineState();
    const bars = twoResistancePivots(10, {}, activatedAt + 1 + 121);
    feed(state, bars.slice(0, activatedAt + 1 + 119));
    const id = Object.keys(state.levels)[0];
    expect(state.levels[id].status).toBe('ACTIVE');
    onH4Close(state, bars[activatedAt + 120]);
    expect(state.levels[id].status).toBe('EXPIRED');
    expect(state.levels[id].statusT).toBe(bars[activatedAt + 120].t + H4);
  });

  it('a close exactly at the level is not a break; one cent beyond is', () => {
    const state = createLevelEngineState();
    const bars = twoResistancePivots(10, { 17: { o: 2000, h: 2100, c: 2100 }, 18: { o: 2000, h: 2101, c: 2100.01 } }, 20);
    feed(state, bars.slice(0, 18));
    const id = Object.keys(state.levels)[0];
    expect(state.levels[id].status).toBe('ACTIVE');
    onH4Close(state, bars[18]);
    expect(state.levels[id].status).toBe('BROKEN');
  });

  it('a consumed key stays retired until a later break, and then needs two pivots after that break', () => {
    const state = createLevelEngineState();
    const bars = h4Series(START, 80, {
      3: { h: 2100 }, 13: { h: 2100 }, // generation 1 activates at close of 15
      23: { h: 2100 }, 33: { h: 2100 }, // valid pair while retired → blocked
      40: { o: 2000, h: 2110, c: 2100.5 }, // break (close beyond) after retirement
      45: { h: 2100 }, 55: { h: 2100 }, // two new pivots after the break → generation 2 at 57
    });
    feed(state, bars.slice(0, 17));
    const gen1 = Object.values(state.levels)[0];
    consumeLevel(state, gen1.id, bars[16].t + 60_000, 'evt:test');
    feed(state, bars.slice(17, 40));
    expect(Object.keys(state.levels)).toHaveLength(1);
    // pivot 23 (partners 3, 13) and pivot 33 (partners 3, 13, 23) each form valid pairs that are blocked
    expect(state.diagnostics.activationsBlocked.RETIRED_UNTIL_BREAK).toBe(2);
    feed(state, bars.slice(40));
    const levels = Object.values(state.levels).sort((a, b) => a.generation - b.generation);
    expect(levels.map((l) => l.generation)).toEqual([1, 2]);
    expect(levels[1].firstPivotIndex).toBe(45);
    expect(levels[1].activatedT).toBe(bars[57].t + H4);
    expect(levels[0].laterBreakT).toBe(bars[40].t + H4);
  });

  it('a level broken while active is not resurrected by a later same-price pivot pairing across the break', () => {
    const state = createLevelEngineState();
    const bars = h4Series(START, 60, {
      3: { h: 2100 }, 13: { h: 2100 },
      18: { o: 2000, h: 2105, c: 2101 }, // breaks the ACTIVE level
      24: { h: 2100 },
    });
    feed(state, bars);
    const levels = Object.values(state.levels);
    expect(levels).toHaveLength(1);
    expect(levels[0].status).toBe('BROKEN');
  });
});

describe('D1 agreement tag (metadata only)', () => {
  it('tags only when a same-price D1 pivot was confirmed at or before activation', () => {
    const state = createLevelEngineState();
    const d1Start = Date.parse('2024-12-20T00:00:00.000Z');
    const d1 = Array.from({ length: 5 }, (_, i) => bar(d1Start + i * D1, 2000, i === 2 ? 2100 : 2010, 1990, 2000, D1));
    for (const b of d1) onD1Close(state, b); // pivot at index 2 confirmed at close of index 4 (2024-12-25)
    feed(state, twoResistancePivots(10));
    expect(Object.values(state.levels)[0].d1Agreement).toBe(true);

    const late = createLevelEngineState();
    feed(late, twoResistancePivots(10));
    expect(Object.values(late.levels)[0].d1Agreement).toBe(false);
  });
});
