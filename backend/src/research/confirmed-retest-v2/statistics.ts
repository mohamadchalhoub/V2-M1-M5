/**
 * research/confirmed-retest-v2/statistics — Output A (event study) and Output B
 * (paper simulation) summaries (spec §11). Every bucket reports WIN, LOSS,
 * AMBIGUOUS, INDETERMINATE and UNRESOLVED separately; nothing is dropped.
 */
import type { PaperResult } from './paper';
import { SPEC } from './spec';
import type { FirstReturnEvent, OutcomeStatus } from './types';

export interface RateWithInterval {
  numerator: number;
  denominator: number;
  rate: number | null;
  wilson95: [number, number] | null;
}

export function wilson95(successes: number, n: number): [number, number] | null {
  if (n === 0) return null;
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export interface EventBucket {
  eligibleEvents: number;
  counts: Record<OutcomeStatus, number>;
  resolvedWinRate: RateWithInterval;
  /** Conservative all-eligible bounds: every uncertain event counted as a loss (low) or as a win (high). */
  allEligibleBounds: { low: number | null; high: number | null; lowFormula: string; highFormula: string };
  meanMaeUsdPerOz: number | null;
}

const emptyCounts = (): Record<OutcomeStatus, number> => ({ WIN: 0, LOSS: 0, AMBIGUOUS: 0, INDETERMINATE: 0, UNRESOLVED: 0 });

export function bucketStats(events: FirstReturnEvent[]): EventBucket {
  const eligible = events.filter((e) => e.eligible && e.outcome);
  const counts = emptyCounts();
  for (const e of eligible) counts[e.outcome!.status] += 1;
  const W = counts.WIN;
  const L = counts.LOSS;
  const N = eligible.length;
  const maes = eligible.map((e) => e.outcome!.maeUnits / 100);
  return {
    eligibleEvents: N,
    counts,
    resolvedWinRate: { numerator: W, denominator: W + L, rate: W + L ? W / (W + L) : null, wilson95: wilson95(W, W + L) },
    allEligibleBounds: {
      low: N ? W / N : null,
      high: N ? (N - L) / N : null,
      lowFormula: `W/N = ${W}/${N}`,
      highFormula: `(N-L)/N = ${N - L}/${N}`,
    },
    meanMaeUsdPerOz: maes.length ? maes.reduce((a, b) => a + b, 0) / maes.length : null,
  };
}

export interface EventStudySummary {
  scope: string;
  studyEventsByKind: Record<string, number>;
  ineligibleByReason: Record<string, number>;
  full: EventBucket;
  byDirection: { BUY: EventBucket; SELL: EventBucket };
  byYear: Record<string, EventBucket>;
  byHalfYear: Record<string, EventBucket>;
  withD1Agreement: EventBucket;
  withoutD1Agreement: EventBucket;
  dependence: {
    distinctBeirutDaysWithEligibleEvents: number;
    maxEligibleEventsOnOneDay: number;
    overlappingEligiblePairs: number;
    note: string;
  };
}

export function summarizeEventStudy(events: FirstReturnEvent[], endT: number): EventStudySummary {
  const study = events.filter((e) => e.period === 'STUDY');
  const eligible = study.filter((e) => e.eligible);
  const tally = (xs: string[]) => xs.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x]: (acc[x] ?? 0) + 1 }), {});
  const group = (key: (e: FirstReturnEvent) => string) => {
    const out: Record<string, EventBucket> = {};
    for (const k of [...new Set(study.map(key))].sort()) out[k] = bucketStats(study.filter((e) => key(e) === k));
    return out;
  };

  const perDay = tally(eligible.map((e) => e.beirut.date));
  const windows = eligible.map((e) => {
    const exits = (e.outcome?.alternatives ?? []).map((a) => (a.exitBarT ?? endT) + (a.exitBarDur ?? 0));
    const end = e.outcome?.pendingRace || exits.length === 0 ? endT : Math.max(...exits);
    return { start: e.touchStartT, end };
  });
  let overlaps = 0;
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      if (windows[i].start < windows[j].end && windows[j].start < windows[i].end) overlaps += 1;
    }
  }

  return {
    scope: 'Output A — every qualifying level first return (overlap allowed). Conditional historical price-movement statistics, NOT achievable account performance.',
    studyEventsByKind: tally(study.map((e) => e.kind)),
    ineligibleByReason: tally(study.filter((e) => !e.eligible).map((e) => e.ineligibleReason as string)),
    full: bucketStats(study),
    byDirection: { BUY: bucketStats(study.filter((e) => e.direction === 'BUY')), SELL: bucketStats(study.filter((e) => e.direction === 'SELL')) },
    byYear: group((e) => String(e.beirut.year)),
    byHalfYear: group((e) => e.beirut.half),
    withD1Agreement: bucketStats(study.filter((e) => e.d1Agreement)),
    withoutD1Agreement: bucketStats(study.filter((e) => !e.d1Agreement)),
    dependence: {
      distinctBeirutDaysWithEligibleEvents: Object.keys(perDay).length,
      maxEligibleEventsOnOneDay: Math.max(0, ...Object.values(perDay)),
      overlappingEligiblePairs: overlaps,
      note:
        'Wilson intervals assume independent events. Events sharing a day, a price regime or an open-trade window are not independent, ' +
        'so the true uncertainty is wider than shown. Previously inspected history is not a pristine holdout.',
    },
  };
}

type Range = [number, number] | null;
const range = (xs: number[]): Range => (xs.length ? [Math.min(...xs), Math.max(...xs)] : null);

export interface PaperSummary {
  balanceId: string;
  costId: string;
  startingBalanceUsd: number;
  branches: number;
  branchCapHit: boolean;
  haltedBranches: number;
  openAtEndBranches: number;
  tradesEntered: Range;
  wins: Range;
  losses: Range;
  netPnlUsd: Range;
  netExpectancyUsdPerTrade: Range;
  profitFactor: Range;
  maxEquityDrawdownUsd: Range;
  maxEquityDrawdownPct: Range;
  exposurePct: Range;
  decisionTally: Record<string, Range>;
  exact: boolean;
}

export function summarizePaper(result: PaperResult): PaperSummary {
  const leaves = result.leaves;
  const perLeaf = leaves.map((leaf) => {
    const closed = leaf.trades.filter((t) => t.netUsd !== null);
    const wins = closed.filter((t) => (t.netUsd as number) > 0);
    const losses = closed.filter((t) => (t.netUsd as number) <= 0);
    const grossWin = wins.reduce((a, t) => a + (t.netUsd as number), 0);
    const grossLoss = -losses.reduce((a, t) => a + (t.netUsd as number), 0);
    return {
      trades: leaf.trades.length,
      wins: leaf.trades.filter((t) => t.result === 'WIN').length,
      losses: leaf.trades.filter((t) => t.result === 'LOSS').length,
      net: leaf.netPnlUsd,
      expectancy: closed.length ? closed.reduce((a, t) => a + (t.netUsd as number), 0) / closed.length : null,
      pf: grossLoss > 0 ? grossWin / grossLoss : null,
      dd: leaf.maxDrawdownUsd,
      ddPct: leaf.maxDrawdownPct * 100,
      exposure: leaf.exposurePct,
    };
  });
  const decisionKinds = new Set(leaves.flatMap((l) => Object.values(l.decisions)));
  const decisionTally: Record<string, Range> = {};
  for (const kind of [...decisionKinds].sort()) {
    decisionTally[kind] = range(leaves.map((l) => Object.values(l.decisions).filter((d) => d === kind).length));
  }
  const nonNull = (xs: Array<number | null>) => xs.filter((x): x is number => x !== null);
  return {
    balanceId: result.balanceId,
    costId: result.costId,
    startingBalanceUsd: result.startingBalanceUsd,
    branches: leaves.length,
    branchCapHit: result.branchCapHit,
    haltedBranches: leaves.filter((l) => l.halted).length,
    openAtEndBranches: leaves.filter((l) => l.openAtEnd).length,
    tradesEntered: range(perLeaf.map((x) => x.trades)),
    wins: range(perLeaf.map((x) => x.wins)),
    losses: range(perLeaf.map((x) => x.losses)),
    netPnlUsd: range(perLeaf.map((x) => x.net)),
    netExpectancyUsdPerTrade: range(nonNull(perLeaf.map((x) => x.expectancy))),
    profitFactor: range(nonNull(perLeaf.map((x) => x.pf))),
    maxEquityDrawdownUsd: range(perLeaf.map((x) => x.dd)),
    maxEquityDrawdownPct: range(perLeaf.map((x) => x.ddPct)),
    exposurePct: range(perLeaf.map((x) => x.exposure)),
    decisionTally,
    exact: leaves.length === 1 && !leaves[0].halted,
  };
}

export type Conclusion = 'INSUFFICIENT_EVIDENCE' | 'LOSING_UNDER_TESTED_ASSUMPTIONS' | 'PROMISING_BUT_UNPROVEN';

/** Applies the pre-declared `SPEC.conclusionRule` mechanically. */
export function classifyConclusion(full: EventBucket, sensitivityBase: PaperSummary | null): { conclusion: Conclusion; reason: string } {
  const rule = SPEC.conclusionRule;
  const p = rule.breakevenWinRateAssumedBase;
  const { numerator: W, denominator: resolved, wilson95: ci } = full.resolvedWinRate;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  if (resolved < rule.minResolvedEvents) {
    return { conclusion: 'INSUFFICIENT_EVIDENCE', reason: `only ${resolved} resolved eligible events (W+L); the pre-declared minimum is ${rule.minResolvedEvents}` };
  }
  const [lo, hi] = ci as [number, number];
  if (hi < p) {
    return { conclusion: 'LOSING_UNDER_TESTED_ASSUMPTIONS', reason: `Wilson 95% upper bound ${pct(hi)} of ${W}/${resolved} is below the ${pct(p)} ASSUMED_BASE breakeven` };
  }
  const conservativeLow = full.allEligibleBounds.low ?? 0;
  const worstBranch = sensitivityBase?.netPnlUsd?.[0] ?? null;
  if (lo > p && conservativeLow > p && worstBranch !== null && worstBranch > 0) {
    return { conclusion: 'PROMISING_BUT_UNPROVEN', reason: `Wilson lower bound ${pct(lo)} and W/N ${pct(conservativeLow)} exceed ${pct(p)}; worst sensitivity branch nets $${worstBranch.toFixed(2)}` };
  }
  return { conclusion: 'INSUFFICIENT_EVIDENCE', reason: `inconclusive: W/(W+L) = ${W}/${resolved}, Wilson 95% ${pct(lo)}–${pct(hi)} straddles or does not clear the ${pct(p)} breakeven with the required margins` };
}

/** Per-event decision across all branches, e.g. { ENTERED: 1, POSITION_OPEN: 3 } — the dashboard's skip-reason view. */
export function eventDecisionMatrix(result: PaperResult): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const leaf of result.leaves) {
    for (const [eventId, decision] of Object.entries(leaf.decisions)) {
      out[eventId] ??= {};
      out[eventId][decision] = (out[eventId][decision] ?? 0) + 1;
    }
  }
  return out;
}
