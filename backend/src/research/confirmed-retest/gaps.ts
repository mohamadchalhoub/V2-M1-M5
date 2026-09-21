/**
 * research/confirmed-retest/gaps — evidence-based M1 gap classification and
 * the chronological evaluation stream (spec §3.3). Pure: callers pass
 * already-loaded, already-UTC-converted bars (see data-source.ts).
 */
import { SPEC } from './spec';
import { MINUTE_MS } from './time';
import type { Bar, EvalBar, GapInfo, GapKind, Timeframe } from './types';

/** A stored bar with both its true UTC open (`t`) and its raw broker-server wall-clock open (`serverT`). */
export interface SeriesBar extends Bar {
  serverT: number;
}

export type SeriesMap = Partial<Record<Timeframe, SeriesBar[]>>;

export interface RawGap {
  startT: number;
  endT: number;
  startServerT: number;
  endServerT: number;
}

export interface ClassifiedGap extends RawGap {
  id: string;
  kind: GapKind;
  closureChecks: { longEnough: boolean; noFinerBarInside: boolean; reopenRecurs: boolean; closeRecurs: boolean } | null;
  bridgeLow: number | null;
  bridgeHigh: number | null;
  evidence: string;
  /** Minutes of M5 substitute bars inserted into this gap (0 if none). */
  substitutedM5Bars: number;
}

const DAY_MS = 86_400_000;

export function findGaps(bars: SeriesBar[]): RawGap[] {
  const gaps: RawGap[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];
    if (cur.t <= prev.t) throw new Error(`series not strictly increasing at ${new Date(cur.t).toISOString()}`);
    if (cur.t > prev.t + prev.dur) {
      gaps.push({ startT: prev.t + prev.dur, endT: cur.t, startServerT: prev.serverT + prev.dur, endServerT: cur.serverT });
    }
  }
  return gaps;
}

const minuteOfDay = (serverT: number) => Math.floor((((serverT % DAY_MS) + DAY_MS) % DAY_MS) / MINUTE_MS);
const serverDate = (serverT: number) => new Date(serverT).toISOString().slice(0, 10);
const circularDistance = (a: number, b: number) => {
  const d = Math.abs(a - b) % 1440;
  return Math.min(d, 1440 - d);
};

function lowerBound(bars: Bar[], t: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** True when some bar of the series lies entirely within [startT, endT). */
export function hasBarFullyInside(series: Bar[] | undefined, startT: number, endT: number): boolean {
  if (!series) return false;
  for (let i = lowerBound(series, startT); i < series.length && series[i].t < endT; i++) {
    if (series[i].t + series[i].dur <= endT) return true;
  }
  return false;
}

export interface RecurrenceEvidence {
  closes: Array<{ minute: number; date: string }>;
  reopens: Array<{ minute: number; date: string }>;
}

function longEnough(g: RawGap): boolean {
  return g.endT - g.startT >= SPEC.data.closureEvidence.minClosureMinutes * MINUTE_MS;
}

function noFinerBarInside(g: RawGap, series: SeriesMap): boolean {
  return SPEC.data.closureEvidence.noFullyContainedFinerBarTimeframes.every((tf) => !hasBarFullyInside(series[tf as Timeframe], g.startT, g.endT));
}

/** Recurrence evidence pool: gaps that are long enough and have no finer broker bar fully inside. */
export function buildRecurrenceEvidence(gaps: RawGap[], series: SeriesMap): RecurrenceEvidence {
  const pool = gaps.filter((g) => longEnough(g) && noFinerBarInside(g, series));
  return {
    closes: pool.map((g) => ({ minute: minuteOfDay(g.startServerT), date: serverDate(g.startServerT) })),
    reopens: pool.map((g) => ({ minute: minuteOfDay(g.endServerT), date: serverDate(g.endServerT) })),
  };
}

function distinctDatesNear(samples: Array<{ minute: number; date: string }>, minute: number, tolerance: number): number {
  const dates = new Set<string>();
  for (const s of samples) if (circularDistance(s.minute, minute) <= tolerance) dates.add(s.date);
  return dates.size;
}

export function closureChecks(g: RawGap, series: SeriesMap, evidence: RecurrenceEvidence) {
  const ce = SPEC.data.closureEvidence;
  return {
    longEnough: longEnough(g),
    noFinerBarInside: noFinerBarInside(g, series),
    reopenRecurs: distinctDatesNear(evidence.reopens, minuteOfDay(g.endServerT), ce.reopenToleranceMinutes) >= ce.reopenRecurrenceMinDates,
    closeRecurs: distinctDatesNear(evidence.closes, minuteOfDay(g.startServerT), ce.closeToleranceMinutes) >= ce.closeRecurrenceMinDates,
  };
}

const gapId = (g: RawGap) => `gap:${new Date(g.startT).toISOString()}`;

/**
 * M5 bridge for a remaining unconfirmed (sub-)gap: every missing minute must
 * fall inside an existing M5 bar; the bridge range is the min low / max high
 * of those bars (prices the broker recorded, order unknown).
 */
export function bridgeGap(g: RawGap, m5ByT: Map<number, Bar>): { low: number; high: number } | null {
  let low = Infinity;
  let high = -Infinity;
  const seen = new Set<number>();
  for (let t = g.startT; t < g.endT; t += MINUTE_MS) {
    const slot = t - (((t % (5 * MINUTE_MS)) + 5 * MINUTE_MS) % (5 * MINUTE_MS));
    const bar = m5ByT.get(slot);
    if (!bar) return null;
    if (!seen.has(slot)) {
      seen.add(slot);
      low = Math.min(low, bar.l);
      high = Math.max(high, bar.h);
    }
  }
  return { low, high };
}

export interface StreamBuildInput {
  series: SeriesMap;
  /** Replay warm-up starts at this UTC ms (first H4 bar used as an evaluation bar). */
  warmupStartT: number;
  studyStartT: number;
  /** Frozen end: only bars with close ≤ endT are used. */
  endT: number;
  /** Recurrence evidence; defaults to evidence computed from all M1 gaps with start < endT. */
  evidence?: RecurrenceEvidence;
}

export interface StreamBuildResult {
  stream: EvalBar[];
  m1Gaps: ClassifiedGap[];
  warmupGaps: ClassifiedGap[];
  evidence: RecurrenceEvidence;
  substitutedM5Count: number;
}

/**
 * Warm-up H4 evaluation bars (pre-study consumption tracking only): a gap is
 * a closure when it lies inside a server Friday-close..Monday-open weekend or
 * is an H4-grid-aligned gap of at most two broker days with no finer bar
 * inside (holiday pattern); anything else is unbridged.
 */
function classifyWarmupGap(g: RawGap, series: SeriesMap): ClassifiedGap {
  const startDow = new Date(g.startServerT).getUTCDay();
  const endDow = new Date(g.endServerT).getUTCDay();
  const spanDays = (g.endT - g.startT) / DAY_MS;
  const weekend = spanDays <= 2.5 && (startDow === 6 || startDow === 5) && (endDow === 1 || endDow === 0);
  const holidayLike = spanDays <= 2 && minuteOfDay(g.startServerT) % 240 === 0 && minuteOfDay(g.endServerT) % 240 === 0 && noFinerBarInside(g, series);
  const weekendHoliday = spanDays <= 4.5 && (endDow === 1 || endDow === 2) && minuteOfDay(g.endServerT) === 0 && minuteOfDay(g.startServerT) === 0 && noFinerBarInside(g, series);
  const closure = weekend || holidayLike || weekendHoliday;
  return {
    ...g,
    id: gapId(g),
    kind: closure ? 'CONFIRMED_CLOSURE' : 'UNCONFIRMED_UNBRIDGED',
    closureChecks: null,
    bridgeLow: null,
    bridgeHigh: null,
    evidence: closure ? `warm-up H4 gap: ${weekend ? 'weekend' : 'day-aligned holiday pattern'}` : 'warm-up H4 gap without closure pattern',
    substitutedM5Bars: 0,
  };
}

const toEval = (b: Bar, res: EvalBar['res']): EvalBar => ({ t: b.t, dur: b.dur, o: b.o, h: b.h, l: b.l, c: b.c, res, gapBefore: null });

const toGapInfo = (g: ClassifiedGap): GapInfo => ({
  id: g.id,
  startT: g.startT,
  endT: g.endT,
  kind: g.kind,
  bridgeLow: g.bridgeLow,
  bridgeHigh: g.bridgeHigh,
  evidence: g.evidence,
});

export function buildEvaluationStream(input: StreamBuildInput): StreamBuildResult {
  const { series, warmupStartT, studyStartT, endT } = input;
  const m1All = (series.M1 ?? []).filter((b) => b.t + b.dur <= endT);
  const m5 = (series.M5 ?? []).filter((b) => b.t + b.dur <= endT);
  const h4 = (series.H4 ?? []).filter((b) => b.t >= warmupStartT && b.t + b.dur <= studyStartT);
  const m5ByT = new Map(m5.map((b) => [b.t, b] as const));

  const rawM1Gaps = findGaps(m1All);
  const evidence = input.evidence ?? buildRecurrenceEvidence(rawM1Gaps, series);

  const classify = (g: RawGap): ClassifiedGap => {
    const checks = closureChecks(g, series, evidence);
    const closure = checks.longEnough && checks.noFinerBarInside && checks.reopenRecurs && checks.closeRecurs;
    if (closure) {
      return { ...g, id: gapId(g), kind: 'CONFIRMED_CLOSURE', closureChecks: checks, bridgeLow: null, bridgeHigh: null, evidence: 'recurring close/reopen, no finer broker bar inside', substitutedM5Bars: 0 };
    }
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k).join(',');
    const bridge = bridgeGap(g, m5ByT);
    return {
      ...g,
      id: gapId(g),
      kind: bridge ? 'UNCONFIRMED_BRIDGED' : 'UNCONFIRMED_UNBRIDGED',
      closureChecks: checks,
      bridgeLow: bridge?.low ?? null,
      bridgeHigh: bridge?.high ?? null,
      evidence: `not a confirmed closure (failed: ${failed})${bridge ? '; every missing minute covered by M5' : '; not fully covered by M5'}`,
      substitutedM5Bars: 0,
    };
  };

  // Warm-up section (H4 evaluation bars).
  const stream: EvalBar[] = [];
  const warmupGaps: ClassifiedGap[] = [];
  for (let i = 0; i < h4.length; i++) {
    const bar = toEval(h4[i], 'H4_WARMUP');
    if (i > 0 && h4[i].t > h4[i - 1].t + h4[i - 1].dur) {
      const g = classifyWarmupGap({ startT: h4[i - 1].t + h4[i - 1].dur, endT: h4[i].t, startServerT: h4[i - 1].serverT + h4[i - 1].dur, endServerT: h4[i].serverT }, series);
      warmupGaps.push(g);
      bar.gapBefore = toGapInfo(g);
    }
    stream.push(bar);
  }
  const lastWarmupClose = h4.length ? h4[h4.length - 1].t + h4[h4.length - 1].dur : studyStartT;
  if (h4.length && lastWarmupClose !== studyStartT) {
    throw new Error(`last warm-up H4 bar must close exactly at study start (closes ${new Date(lastWarmupClose).toISOString()})`);
  }

  // Study section: M1 plus M5 substitutes inside unconfirmed M1 holes.
  const m1Study = m1All.filter((b) => b.t >= studyStartT);
  const m1Gaps: ClassifiedGap[] = [];
  let substitutedM5Count = 0;
  let prevClose = studyStartT;
  let prevServerClose: number | null = null;
  const firstStudyIndex = lowerBound(m1All, studyStartT);
  if (firstStudyIndex > 0) {
    // The last M1 bar before the study start defines where the first study gap really begins.
    const before = m1All[firstStudyIndex - 1];
    if (before.t + before.dur > studyStartT) throw new Error('an M1 bar straddles the study start');
    prevClose = before.t + before.dur;
    prevServerClose = before.serverT + before.dur;
  }

  const pushWithGap = (bar: SeriesBar, res: EvalBar['res'], nextPrevClose: number) => {
    const ev = toEval(bar, res);
    if (bar.t > prevClose) {
      const serverStart = prevServerClose ?? bar.serverT - (bar.t - prevClose);
      const g = classify({ startT: prevClose, endT: bar.t, startServerT: serverStart, endServerT: bar.serverT });
      m1Gaps.push(g);
      ev.gapBefore = toGapInfo(g);
    }
    stream.push(ev);
    prevClose = nextPrevClose;
    prevServerClose = bar.serverT + bar.dur;
  };

  for (const bar of m1Study) {
    if (bar.t > prevClose) {
      const hole: RawGap = { startT: prevClose, endT: bar.t, startServerT: prevServerClose ?? bar.serverT - (bar.t - prevClose), endServerT: bar.serverT };
      const checks = closureChecks(hole, series, evidence);
      const isClosure = checks.longEnough && checks.noFinerBarInside && checks.reopenRecurs && checks.closeRecurs;
      if (!isClosure) {
        for (let i = lowerBound(m5, Math.max(hole.startT, studyStartT)); i < m5.length && m5[i].t < hole.endT; i++) {
          if (m5[i].t + m5[i].dur > hole.endT) continue;
          pushWithGap(m5[i], 'M5_SUBSTITUTE', m5[i].t + m5[i].dur);
          substitutedM5Count += 1;
        }
      }
    }
    pushWithGap(bar, 'M1', bar.t + bar.dur);
  }

  return { stream, m1Gaps, warmupGaps, evidence, substitutedM5Count };
}
