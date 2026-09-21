// Spec §7 outcome engine. The reachability formula is checked against an
// independent brute-force oracle that simulates every piecewise-linear path
// (up to four turning points on the critical price values) compatible with
// the bar's OHLC — the oracle shares no code with the implementation.
import { describe, expect, it } from 'vitest';
import {
  entryCandleReachable,
  outcomeStatus,
  raceStep,
  startOutcome,
  applyRaceStep,
  ticksReconcile,
  type VerifiedTicks,
} from '../../../src/research/confirmed-retest/outcome';
import type { Bar, RaceState } from '../../../src/research/confirmed-retest/types';
import { M1, evalBar, gap, usd } from './helpers';

type R = 'WIN' | 'LOSS' | 'NONE';

/** BUY-orientation oracle: TP above entry, SL below. Returns every result some compatible path produces. */
function oracle(o: number, h: number, l: number, c: number, E: number, TP: number, SL: number): Set<R> {
  const crit = [...new Set([o, h, l, c, E, TP, SL].filter((v) => v >= l && v <= h))].sort((a, b) => a - b);
  const values = [...crit];
  for (let i = 0; i + 1 < crit.length; i++) values.push((crit[i] + crit[i + 1]) / 2);
  const results = new Set<R>();
  const simulate = (points: number[]): R | null => {
    let entered = false;
    for (let i = 0; i + 1 < points.length; i++) {
      let x = points[i];
      const y = points[i + 1];
      if (!entered) {
        if (Math.min(x, y) <= E && E <= Math.max(x, y)) {
          entered = true;
          x = E;
        } else continue;
      }
      if (y > x && y >= TP) return 'WIN';
      if (y < x && y <= SL) return 'LOSS';
    }
    return entered ? 'NONE' : null;
  };
  const inner: number[] = [];
  const recurse = (depth: number) => {
    const points = [o, ...inner, c];
    if (Math.max(...points) === h && Math.min(...points) === l) {
      const r = simulate(points);
      if (r) results.add(r);
    }
    if (depth === 4) return;
    for (const v of values) {
      if (inner.length && inner[inner.length - 1] === v) continue;
      inner.push(v);
      recurse(depth + 1);
      inner.pop();
    }
  };
  recurse(0);
  return results;
}

const b = (o: number, h: number, l: number, c: number): Bar => ({ t: 0, dur: M1, o, h, l, c });

describe('entry-candle reachability matches the brute-force path oracle', () => {
  const grid = [85, 90, 95, 100, 105, 110, 115];
  const E = 100;
  const TP = 110;
  const SL = 90;
  const cases: Array<[number, number, number, number]> = [];
  for (const o of grid.filter((v) => v >= E))
    for (const l of grid.filter((v) => v <= E))
      for (const h of grid.filter((v) => v >= o))
        for (const c of grid.filter((v) => v >= l && v <= h)) cases.push([o, h, l, c]);

  it(`BUY: all ${cases.length} grid bars`, () => {
    for (const [o, h, l, c] of cases) {
      const expected = [...oracle(o, h, l, c, E, TP, SL)].sort();
      const actual = [...entryCandleReachable(b(o, h, l, c), 'BUY', E, TP, SL)].sort();
      expect({ bar: [o, h, l, c], reach: actual }).toEqual({ bar: [o, h, l, c], reach: expected });
    }
  });

  it('SELL: mirrored grid bars give the mirrored result', () => {
    const M = 200; // mirror price p -> 200 - p; SELL entry 100, TP 90, SL 110
    for (const [o, h, l, c] of cases) {
      const expected = [...oracle(o, h, l, c, E, TP, SL)].sort();
      const actual = [...entryCandleReachable(b(M - o, M - l, M - h, M - c), 'SELL', M - E, M - TP, M - SL)].sort();
      expect({ bar: [o, h, l, c], reach: actual }).toEqual({ bar: [o, h, l, c], reach: expected });
    }
  });

  it('the previously published counterexample is ambiguous, not LOSS', () => {
    // BUY touch 4340, TP 4350, SL 4330, O=4345 H=4352 L=4328 C=4348
    expect(entryCandleReachable(b(4345, 4352, 4328, 4348), 'BUY', 4340, 4350, 4330).sort()).toEqual(['LOSS', 'WIN']);
  });
});

describe('event status combines entry-bar branches with the continuation', () => {
  const t0 = Date.parse('2025-03-04T07:00:00.000Z');

  it('WIN-now or NONE-then-WIN is a WIN (no ambiguity about the result)', () => {
    // BUY 2000: entry bar reaches TP (2010) but closes below it with room before entry → {WIN, NONE}
    const outcome = startOutcome('e1', evalBar(t0, 2005, 2010, 1999, 2004), 'BUY', usd(2000));
    expect(outcome.entryCandleReachable.sort()).toEqual(['NONE', 'WIN']);
    expect(outcome.status).toBe('UNRESOLVED');
    applyRaceStep(outcome, raceStep(outcome.pendingRace as RaceState, evalBar(t0 + M1, 2004, 2011, 2003, 2010)));
    expect(outcome.status).toBe('WIN');
    expect(outcome.alternatives.map((a) => a.exitBarT)).toEqual([t0, t0 + M1]);
  });

  it('WIN-now or NONE-then-LOSS is AMBIGUOUS', () => {
    const outcome = startOutcome('e2', evalBar(t0, 2005, 2010, 1999, 2004), 'BUY', usd(2000));
    applyRaceStep(outcome, raceStep(outcome.pendingRace as RaceState, evalBar(t0 + M1, 2004, 2004, 1989, 1990)));
    expect(outcome.status).toBe('AMBIGUOUS');
  });

  it('entry bar that can only continue stays UNRESOLVED at end of data', () => {
    const outcome = startOutcome('e3', evalBar(t0, 2003, 2004, 1999, 2001), 'BUY', usd(2000));
    expect(outcome.entryCandleReachable).toEqual(['NONE']);
    expect(outcome.status).toBe('UNRESOLVED');
  });

  it('outcomeStatus never picks the favourable branch', () => {
    expect(outcomeStatus({ status: 'UNRESOLVED', entry: 0, tp: 0, sl: 0, entryCandleReachable: [], pendingRace: null, maeUnits: 0, note: '', alternatives: [
      { result: 'WIN', exitBarT: 1, exitBarDur: 1, exitType: 'INTRABAR', exitPrice: 1, gapId: null, haltT: null, path: '' },
      { result: 'INDETERMINATE', exitBarT: null, exitBarDur: null, exitType: null, exitPrice: null, gapId: 'g', haltT: 5, path: '' },
    ] })).toBe('INDETERMINATE');
  });
});

describe('race on later bars', () => {
  const t0 = Date.parse('2025-03-04T07:00:00.000Z');
  const race = (): RaceState => ({ eventId: 'e', direction: 'SELL', entry: usd(2100), tp: usd(2090), sl: usd(2110), mae: 0, lastBarT: t0 });

  it('a bar opening beyond TP resolves WIN at the open, with the observed gap price recorded', () => {
    const step = raceStep(race(), evalBar(t0 + M1, 2085, 2086, 2080, 2083, { gapBefore: gap(t0 + M1 - 3_600_000, t0 + M1, 'CONFIRMED_CLOSURE') }));
    expect(step).toMatchObject({ done: true, alternatives: [{ result: 'WIN', exitType: 'GAP_OPEN', exitPrice: usd(2085) }] });
  });

  it('a bar opening exactly at SL is an ordinary fill at SL, not a gap', () => {
    const step = raceStep(race(), evalBar(t0 + M1, 2110, 2111, 2105, 2106));
    expect(step).toMatchObject({ done: true, alternatives: [{ result: 'LOSS', exitType: 'INTRABAR', exitPrice: usd(2110) }] });
  });

  it('open checked first: a reopen beyond SL whose range also spans TP is a LOSS, not ambiguous', () => {
    const step = raceStep(race(), evalBar(t0 + M1, 2112, 2113, 2089, 2095));
    expect(step).toMatchObject({ done: true, alternatives: [{ result: 'LOSS', exitType: 'GAP_OPEN' }] });
  });

  it('TP and SL both inside a later bar with a neutral open is AMBIGUOUS', () => {
    const step = raceStep(race(), evalBar(t0 + M1, 2100, 2111, 2089, 2100));
    expect(step.done && step.alternatives.map((a) => a.result).sort()).toEqual(['LOSS', 'WIN']);
  });

  it('an unconfirmed unbridged gap makes the trade INDETERMINATE, even if the next bar is far beyond TP', () => {
    const g = gap(t0 + M1, t0 + 10 * M1, 'UNCONFIRMED_UNBRIDGED');
    const step = raceStep(race(), evalBar(t0 + 10 * M1, 2050, 2051, 2049, 2050, { gapBefore: g }));
    expect(step).toMatchObject({ done: true, alternatives: [{ result: 'INDETERMINATE', gapId: g.id, haltT: g.startT }] });
  });

  it('a bridged gap continues only when its M5 range excludes both TP and SL', () => {
    const clean = raceStep(race(), evalBar(t0 + 4 * M1, 2100, 2101, 2099, 2100, { gapBefore: gap(t0 + M1, t0 + 4 * M1, 'UNCONFIRMED_BRIDGED', [2095, 2105]) }));
    expect(clean.done).toBe(false);
    const dirty = raceStep(race(), evalBar(t0 + 4 * M1, 2100, 2101, 2099, 2100, { gapBefore: gap(t0 + M1, t0 + 4 * M1, 'UNCONFIRMED_BRIDGED', [2089.5, 2105]) }));
    expect(dirty).toMatchObject({ done: true, alternatives: [{ result: 'INDETERMINATE' }] });
  });

  it('a confirmed closure alone does not end the trade', () => {
    const step = raceStep(race(), evalBar(t0 + 3 * 86_400_000, 2101, 2104, 2096, 2100, { gapBefore: gap(t0 + M1, t0 + 3 * 86_400_000, 'CONFIRMED_CLOSURE') }));
    expect(step.done).toBe(false);
  });
});

describe('ticks', () => {
  const t0 = Date.parse('2025-03-04T07:00:00.000Z');
  const bothBar = evalBar(t0 + M1, 2100, 2111, 2089, 2100);
  const race = (): RaceState => ({ eventId: 'e', direction: 'SELL', entry: usd(2100), tp: usd(2090), sl: usd(2110), mae: 0, lastBarT: t0 });
  const ticks = (attested: boolean, prices: number[]): VerifiedTicks => ({
    completenessAttested: attested,
    source: 'fixture',
    bids: prices.map((p, i) => ({ t: t0 + M1 + i * 1000, bid: usd(p) })),
  });

  it('dense but unattested ticks are ignored (a small inter-tick gap is not proof)', () => {
    const step = raceStep(race(), bothBar, () => ticks(false, [2100, 2111, 2089, 2100]));
    expect(step.done && step.alternatives.length).toBe(2);
  });

  it('attested ticks that do not reproduce the bar OHLC are ignored', () => {
    expect(ticksReconcile(bothBar, ticks(true, [2100, 2111, 2090, 2100]))).toBe(false);
    const step = raceStep(race(), bothBar, () => ticks(true, [2100, 2111, 2090, 2100]));
    expect(step.done && step.alternatives.length).toBe(2);
  });

  it('attested, reconciled ticks resolve the order', () => {
    const step = raceStep(race(), bothBar, () => ticks(true, [2100, 2089, 2111, 2100]));
    expect(step).toMatchObject({ done: true, alternatives: [{ result: 'WIN' }] });
  });
});
