// Spec §3.3: closures must be evidenced (recurring close/reopen, no finer
// broker bar inside, ≥ 30 min); everything else is unconfirmed, filled with
// M5 where M5 exists inside the hole, and bridged or left unbridged.
import { describe, expect, it } from 'vitest';
import { buildEvaluationStream, type SeriesBar } from '../../../src/research/confirmed-retest/gaps';
import { H4, M1, usd } from './helpers';

// Fixture convention: server wall clock = UTC + 2h (EET winter), so serverT = t + 2h.
const OFFSET = 2 * 3_600_000;
const sb = (t: number, dur: number, price = 2000): SeriesBar => ({ t, serverT: t + OFFSET, dur, o: usd(price), h: usd(price + 1), l: usd(price - 1), c: usd(price) });

/** Weekday M1 sessions 01:00–24:00 server (23:00–22:00 UTC) for `days` consecutive weekdays, with optional holes. */
function m1Days(firstDayUtcMidnight: number, days: number, holes: Array<[number, number]> = []): SeriesBar[] {
  const out: SeriesBar[] = [];
  for (let d = 0; d < days; d++) {
    const sessionStart = firstDayUtcMidnight + d * 86_400_000 - OFFSET + 3_600_000; // 01:00 server
    for (let m = 0; m < 23 * 60; m++) {
      const t = sessionStart + m * M1;
      if (holes.some(([s, e]) => t >= s && t < e)) continue;
      out.push(sb(t, M1));
    }
  }
  return out;
}

describe('closure evidence', () => {
  const day0 = Date.parse('2025-01-07T00:00:00.000Z'); // Tuesday
  const days = 22;

  it('a daily break that recurs on many dates is a confirmed closure; a one-off mid-session hole is not', () => {
    const holeStart = day0 + 3 * 86_400_000 + 8 * 3_600_000; // 10:00 server on day 3
    const hole: [number, number] = [holeStart, holeStart + 45 * M1];
    const m1 = m1Days(day0, days, [hole]);
    const warmupStart = day0 - OFFSET - 8 * H4;
    const h4 = Array.from({ length: 8 }, (_, i) => sb(warmupStart + i * H4, H4));
    const studyStart = warmupStart + 8 * H4;
    const result = buildEvaluationStream({ series: { M1: m1, H4: h4 }, warmupStartT: warmupStart, studyStartT: studyStart, endT: m1[m1.length - 1].t + M1 });
    const breaks = result.m1Gaps.filter((g) => g.endT - g.startT === 60 * M1);
    expect(breaks.length).toBeGreaterThanOrEqual(20);
    expect(breaks.every((g) => g.kind === 'CONFIRMED_CLOSURE')).toBe(true);
    const oneOff = result.m1Gaps.find((g) => g.startT === hole[0]);
    expect(oneOff?.kind).toBe('UNCONFIRMED_UNBRIDGED');
    expect(oneOff?.closureChecks?.reopenRecurs).toBe(false);
  });

  it('with fewer than 20 recurring reopen dates the same break is NOT confirmed', () => {
    const m1 = m1Days(day0, 10);
    const result = buildEvaluationStream({ series: { M1: m1 }, warmupStartT: m1[0].t, studyStartT: m1[0].t, endT: m1[m1.length - 1].t + M1 });
    expect(result.m1Gaps.every((g) => g.kind !== 'CONFIRMED_CLOSURE')).toBe(true);
  });

  it('a recurring-looking hole with an M5 bar fully inside is not a closure; M5 bars are substituted', () => {
    const holeStart = day0 + 5 * 86_400_000 + 8 * 3_600_000;
    const m1 = m1Days(day0, days, [[holeStart, holeStart + 60 * M1]]);
    const m5 = [sb(holeStart + 10 * M1, 5 * M1, 2003), sb(holeStart + 15 * M1, 5 * M1, 2004)];
    const result = buildEvaluationStream({ series: { M1: m1, M5: m5 }, warmupStartT: m1[0].t, studyStartT: m1[0].t, endT: m1[m1.length - 1].t + M1 });
    const substitutes = result.stream.filter((b) => b.res === 'M5_SUBSTITUTE');
    expect(substitutes.map((b) => b.t)).toEqual([holeStart + 10 * M1, holeStart + 15 * M1]);
    expect(result.substitutedM5Count).toBe(2);
    // the remaining sub-gaps before/after the substitutes are not closures and not fully M5-covered
    const subGaps = result.m1Gaps.filter((g) => g.startT >= holeStart && g.endT <= holeStart + 60 * M1);
    expect(subGaps.map((g) => g.kind)).toEqual(['UNCONFIRMED_UNBRIDGED', 'UNCONFIRMED_UNBRIDGED']);
  });

  it('a short hole is never a closure; it is bridged when every missing minute lies inside an existing M5 bar', () => {
    const holeStart = day0 + 2 * 86_400_000 + 8 * 3_600_000 + 6 * M1; // xx:06..xx:09
    const m1 = m1Days(day0, days, [[holeStart, holeStart + 3 * M1]]);
    const covering = sb(holeStart - M1, 5 * M1, 2000);
    covering.h = usd(2007);
    covering.l = usd(1996);
    const result = buildEvaluationStream({ series: { M1: m1, M5: [covering] }, warmupStartT: m1[0].t, studyStartT: m1[0].t, endT: m1[m1.length - 1].t + M1 });
    const g = result.m1Gaps.find((x) => x.startT === holeStart);
    expect(g).toMatchObject({ kind: 'UNCONFIRMED_BRIDGED', bridgeLow: usd(1996), bridgeHigh: usd(2007) });
    const after = result.stream.find((b) => b.t === holeStart + 3 * M1);
    expect(after?.gapBefore?.kind).toBe('UNCONFIRMED_BRIDGED');
  });
});
