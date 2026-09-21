/**
 * research/confirmed-retest/audit — data-evidence checks reported with every
 * run (spec §3.2, §3.4). Pure functions over loaded bars.
 */
import type { ClassifiedGap, SeriesBar } from './gaps';
import { utcToWallClockMs } from './time';

export interface H4ConsistencyReport {
  h4BarsChecked: number;
  exactMatch: number;
  mismatch: number;
  mismatchWithM1HoleInside: number;
  noM1Inside: number;
  fieldMismatchCounts: { open: number; high: number; low: number; close: number };
  examples: string[];
}

/** Broker H4 bars vs the aggregate of stored M1 bars inside each H4 interval (study period). */
export function h4VsM1Consistency(h4: SeriesBar[], m1: SeriesBar[], fromT: number, toT: number, gaps: ClassifiedGap[]): H4ConsistencyReport {
  const report: H4ConsistencyReport = {
    h4BarsChecked: 0,
    exactMatch: 0,
    mismatch: 0,
    mismatchWithM1HoleInside: 0,
    noM1Inside: 0,
    fieldMismatchCounts: { open: 0, high: 0, low: 0, close: 0 },
    examples: [],
  };
  const unconfirmed = gaps.filter((g) => g.kind !== 'CONFIRMED_CLOSURE');
  let j = 0;
  for (const bar of h4) {
    if (bar.t < fromT || bar.t + bar.dur > toT) continue;
    while (j < m1.length && m1[j].t < bar.t) j++;
    let k = j;
    let o: number | null = null;
    let h = -Infinity;
    let l = Infinity;
    let c: number | null = null;
    while (k < m1.length && m1[k].t < bar.t + bar.dur) {
      if (o === null) o = m1[k].o;
      h = Math.max(h, m1[k].h);
      l = Math.min(l, m1[k].l);
      c = m1[k].c;
      k++;
    }
    report.h4BarsChecked += 1;
    if (o === null) {
      report.noM1Inside += 1;
      continue;
    }
    const diffs = { open: o !== bar.o, high: h !== bar.h, low: l !== bar.l, close: c !== bar.c };
    if (!Object.values(diffs).some(Boolean)) {
      report.exactMatch += 1;
      continue;
    }
    report.mismatch += 1;
    for (const [field, differs] of Object.entries(diffs)) if (differs) report.fieldMismatchCounts[field as keyof typeof diffs] += 1;
    const hole = unconfirmed.some((g) => g.startT < bar.t + bar.dur && g.endT > bar.t);
    if (hole) report.mismatchWithM1HoleInside += 1;
    if (report.examples.length < 15) {
      report.examples.push(
        `${new Date(bar.t).toISOString()} H4 o/h/l/c=${bar.o}/${bar.h}/${bar.l}/${bar.c} vs M1 agg ${o}/${h}/${l}/${c}${hole ? ' (unconfirmed M1 hole inside)' : ''}`,
      );
    }
  }
  return report;
}

/**
 * Time-basis evidence: New York wall-clock start of every confirmed daily
 * break (30–180 min closures), tallied per month. A correct server→UTC
 * conversion keeps this constant across the US/EU DST-mismatch weeks.
 */
export function dailyBreakNewYorkTimes(gaps: ClassifiedGap[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const g of gaps) {
    const minutes = (g.endT - g.startT) / 60_000;
    if (g.kind !== 'CONFIRMED_CLOSURE' || minutes < 30 || minutes > 180) continue;
    const ny = new Date(utcToWallClockMs('America/New_York', g.startT)).toISOString().slice(11, 16);
    const month = new Date(g.startT).toISOString().slice(0, 7);
    out[month] ??= {};
    out[month][ny] = (out[month][ny] ?? 0) + 1;
  }
  return out;
}

export interface GapInventory {
  byKind: Record<string, { count: number; missingMinutes: number }>;
  unconfirmedList: Array<{ id: string; startUtc: string; endUtc: string; minutes: number; kind: string; evidence: string; bridge: string | null }>;
}

export function gapInventory(gaps: ClassifiedGap[]): GapInventory {
  const byKind: GapInventory['byKind'] = {};
  const unconfirmedList: GapInventory['unconfirmedList'] = [];
  for (const g of gaps) {
    const minutes = Math.round((g.endT - g.startT) / 60_000);
    byKind[g.kind] ??= { count: 0, missingMinutes: 0 };
    byKind[g.kind].count += 1;
    byKind[g.kind].missingMinutes += minutes;
    if (g.kind !== 'CONFIRMED_CLOSURE') {
      unconfirmedList.push({
        id: g.id,
        startUtc: new Date(g.startT).toISOString(),
        endUtc: new Date(g.endT).toISOString(),
        minutes,
        kind: g.kind,
        evidence: g.evidence,
        bridge: g.bridgeLow !== null ? `${(g.bridgeLow / 100).toFixed(2)}..${((g.bridgeHigh as number) / 100).toFixed(2)}` : null,
      });
    }
  }
  return { byKind, unconfirmedList };
}
