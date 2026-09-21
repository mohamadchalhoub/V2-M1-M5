// Spec §6 first return + §9 selection metadata + restart determinism.
import { describe, expect, it } from 'vitest';
import { advance, cloneState, createReplayState, type ReplayData } from '../../../src/research/confirmed-retest/replay';
import type { Bar, EvalBar } from '../../../src/research/confirmed-retest/types';
import { H4, M1, evalBar, gap, h4Series, usd } from './helpers';

const START = '2025-01-06T00:00:00.000Z';
const START_T = Date.parse(START);
/** Resistance 2100 from pivots 3/13 → active from the close of bar 15. */
const ACTIVATION_T = START_T + 16 * H4; // 2025-01-08T16:00Z = 18:00 Beirut (winter, UTC+2)

function runSingle(stream: EvalBar[], h4: Bar[] = h4Series(START, 40, { 3: { h: 2100 }, 13: { h: 2100 } })) {
  const data: ReplayData = { h4, d1: [], stream };
  const state = createReplayState(START_T);
  advance(state, data, { endT: stream[stream.length - 1].t + stream[stream.length - 1].dur });
  return state;
}

describe('first return', () => {
  it('bars before activation (including the confirming H4 bar) never count as the return', () => {
    const state = runSingle([
      evalBar(ACTIVATION_T - M1, 2099, 2100, 2098, 2099), // inside the confirmation bar: level not active yet
      evalBar(ACTIVATION_T, 2095, 2096, 2094, 2095),
    ]);
    expect(state.eventOrder).toHaveLength(0);
    expect(Object.values(state.levels.levels)[0].status).toBe('ACTIVE');
  });

  it('a wick reaching the level is an ORDINARY touch even when the body does not', () => {
    const touchT = Date.parse('2025-01-09T02:00:00.000Z'); // 04:00 Beirut
    const state = runSingle([evalBar(touchT, 2095, 2100, 2094, 2096)]);
    const e = state.events[state.eventOrder[0]];
    expect(e).toMatchObject({ kind: 'ORDINARY', direction: 'SELL', inWindow: true, eligible: true, touchStartT: touchT, touchEndT: touchT + M1 });
    expect(Object.values(state.levels.levels)[0].status).toBe('CONSUMED');
  });

  it('a first return outside 04:00–12:00 Beirut consumes the level; a later in-window touch creates nothing', () => {
    const outside = Date.parse('2025-01-09T01:59:00.000Z'); // 03:59 Beirut
    const state = runSingle([evalBar(outside, 2095, 2100, 2094, 2096), evalBar(outside + 5 * M1, 2095, 2101, 2094, 2096)]);
    expect(state.eventOrder).toHaveLength(1);
    expect(state.events[state.eventOrder[0]]).toMatchObject({ inWindow: false, eligible: false, ineligibleReason: 'OUTSIDE_WINDOW', outcome: null });
  });

  it('noon Beirut is excluded and the window follows Beirut DST', () => {
    const winterNoon = Date.parse('2025-01-09T10:00:00.000Z'); // 12:00 Beirut (UTC+2)
    expect(runSingle([evalBar(winterNoon, 2095, 2100, 2094, 2096)]).events[`evt:${'lvl:R:210000:g1:1'}`].inWindow).toBe(false);
    const winterLast = Date.parse('2025-01-09T09:59:00.000Z');
    expect(runSingle([evalBar(winterLast, 2095, 2100, 2094, 2096)]).events['evt:lvl:R:210000:g1:1'].inWindow).toBe(true);

    const summerStart = '2025-07-07T00:00:00.000Z';
    const summerH4 = h4Series(summerStart, 40, { 3: { h: 2100 }, 13: { h: 2100 } });
    const summerFour = Date.parse('2025-07-10T01:00:00.000Z'); // 04:00 Beirut (UTC+3)
    const summerState = createReplayState(Date.parse(summerStart));
    advance(summerState, { h4: summerH4, d1: [], stream: [evalBar(summerFour, 2095, 2100, 2094, 2096)] }, { endT: summerFour + M1 });
    expect(summerState.events['evt:lvl:R:210000:g1:1'].inWindow).toBe(true);
  });

  it('opening beyond the level after a closure is a GAP_CROSS: consumed, no entry', () => {
    const reopen = Date.parse('2025-01-13T02:00:00.000Z');
    const state = runSingle([
      evalBar(Date.parse('2025-01-09T02:00:00.000Z'), 2095, 2096, 2094, 2095),
      evalBar(reopen, 2105, 2106, 2099, 2100, { gapBefore: gap(Date.parse('2025-01-09T02:01:00.000Z'), reopen, 'CONFIRMED_CLOSURE') }),
    ]);
    const e = state.events[state.eventOrder[0]];
    expect(e).toMatchObject({ kind: 'GAP_CROSS', eligible: false, ineligibleReason: 'GAP_CROSS', outcome: null });
  });

  it('an unconfirmed unbridged gap before the next bar makes the first return UNOBSERVABLE', () => {
    const t = Date.parse('2025-01-09T05:00:00.000Z');
    const state = runSingle([
      evalBar(Date.parse('2025-01-09T02:00:00.000Z'), 2095, 2096, 2094, 2095),
      evalBar(t, 2090, 2091, 2089, 2090, { gapBefore: gap(Date.parse('2025-01-09T02:01:00.000Z'), t, 'UNCONFIRMED_UNBRIDGED') }),
    ]);
    expect(state.events[state.eventOrder[0]]).toMatchObject({ kind: 'UNOBSERVABLE', eligible: false, inWindow: null, touchStartT: Date.parse('2025-01-09T02:01:00.000Z') });
  });

  it('a bridged gap whose M5 range excludes the level does not hide a return', () => {
    const t = Date.parse('2025-01-09T02:05:00.000Z');
    const state = runSingle([
      evalBar(Date.parse('2025-01-09T02:00:00.000Z'), 2095, 2096, 2094, 2095),
      evalBar(t, 2095, 2096, 2094, 2095, { gapBefore: gap(Date.parse('2025-01-09T02:01:00.000Z'), t, 'UNCONFIRMED_BRIDGED', [2093, 2097]) }),
    ]);
    expect(state.eventOrder).toHaveLength(0);
  });
});

describe('selection metadata for the one-position simulation', () => {
  // resistance 2100 (pivots 3/13) and support 1900 (pivots 4/14) both active from the close of bar 16
  const h4 = h4Series(START, 40, { 3: { h: 2100 }, 13: { h: 2100 }, 4: { l: 1900 }, 14: { l: 1900 } });
  const t = Date.parse('2025-01-09T04:00:00.000Z');

  it('both selected sides inside one bar with a neutral open → order unknown', () => {
    const state = runSingle([evalBar(t - M1, 2000, 2001, 1999, 2000), evalBar(t, 2000, 2100, 1900, 2000)], h4);
    const events = state.eventOrder.map((id) => state.events[id]);
    expect(events).toHaveLength(2);
    for (const e of events) expect(e.selection).toMatchObject({ isSelected: true, bothSelectedSidesTouched: true, orderKnown: false, knownPrice: usd(2000) });
  });

  it('one side reached at the open → order known, that side first', () => {
    const state = runSingle([evalBar(t - M1, 2099, 2099, 2098, 2099), evalBar(t, 2100, 2100, 1900, 1950)], h4);
    const r = Object.values(state.events).find((e) => e.role === 'RESISTANCE')!;
    expect(r.selection).toMatchObject({ orderKnown: true, firstSideLevelId: r.levelId });
  });

  it('only the nearest level on each side is selected', () => {
    const three = h4Series(START, 40, { 3: { h: 2100 }, 13: { h: 2100 }, 6: { h: 2150 }, 16: { h: 2150 } });
    const state = runSingle([evalBar(t - M1, 2000, 2001, 1999, 2000), evalBar(t, 2000, 2160, 1999, 2155)], three);
    const byPrice = Object.fromEntries(Object.values(state.events).map((e) => [e.levelPrice, e.selection?.isSelected]));
    expect(byPrice).toEqual({ [usd(2100)]: true, [usd(2150)]: false });
  });
});

describe('restart determinism', () => {
  function lcg(seed: number) {
    let s = seed;
    return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  }

  function scenario() {
    const h4 = h4Series(START, 80, {
      3: { h: 2030 }, 13: { h: 2030 },
      22: { l: 1980 }, 30: { l: 1980 },
      25: { h: 2060 }, 35: { h: 2060 },
      41: { l: 1960 }, 52: { l: 1960 },
    });
    const rnd = lcg(42);
    const stream: EvalBar[] = [];
    let price = usd(2000);
    let t = START_T + 20 * H4;
    for (let i = 0; i < 12_000; i++) {
      const o = price;
      const c = o + Math.round((rnd() - 0.5) * 400);
      const h = Math.max(o, c) + Math.round(rnd() * 300);
      const l = Math.min(o, c) - Math.round(rnd() * 300);
      let gapBefore = null;
      if (i > 0 && i % 1500 === 0) {
        const kind = i % 4500 === 0 ? 'UNCONFIRMED_UNBRIDGED' : 'CONFIRMED_CLOSURE';
        gapBefore = { id: `gap:${i}`, startT: t, endT: t + 30 * M1, kind, bridgeLow: null, bridgeHigh: null, evidence: 'fixture' } as const;
        t += 30 * M1;
      }
      stream.push({ t, dur: M1, o, h, l, c, res: 'M1', gapBefore });
      price = c;
      t += M1;
    }
    return { h4, d1: [], stream } satisfies ReplayData;
  }

  it('splitting the replay at arbitrary bars and resuming from JSON state gives identical results', () => {
    const data = scenario();
    const endT = data.stream[data.stream.length - 1].t + M1;
    const full = createReplayState(START_T);
    advance(full, data, { endT });
    expect(full.eventOrder.length).toBeGreaterThan(0);
    expect(Object.values(full.events).some((e) => e.outcome)).toBe(true);

    let resumed = createReplayState(START_T);
    for (let i = 97; i < data.stream.length; i += 997) {
      const bar = data.stream[i];
      advance(resumed, data, { endT: bar.t + bar.dur });
      resumed = JSON.parse(JSON.stringify(resumed));
    }
    advance(resumed, data, { endT });
    expect(JSON.stringify(resumed)).toBe(JSON.stringify(full));
  });

  it('advancing again with no new data changes nothing', () => {
    const data = scenario();
    const endT = data.stream[data.stream.length - 1].t + M1;
    const state = createReplayState(START_T);
    advance(state, data, { endT });
    const before = JSON.stringify(cloneState(state));
    advance(state, data, { endT });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('refuses to resume state produced under a different spec hash', () => {
    const state = createReplayState(START_T);
    state.specHash = 'something-else';
    expect(() => advance(state, scenario(), { endT: START_T })).toThrow(/refusing to mix rule versions/);
  });
});
