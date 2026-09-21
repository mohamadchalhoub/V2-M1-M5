/**
 * research/first-touch/statistics — pure descriptive stats over a list of
 * `OutcomeEvent`s produced by `engine.ts`. No DB, no NestJS, no import from
 * either live trading strategy.
 *
 * Every breakdown below is UNFILTERED: `byEntryHour` always has all 24
 * buckets (0-23), `byYear` has one entry per year actually present in the
 * input (never only the "good" ones) — per the spec's explicit requirement
 * that these never be curated down to only favorable buckets.
 */
import type { OutcomeEvent, OutcomeResolution } from './types';

export interface OutcomeCounts {
  win: number;
  loss: number;
  unresolved: number;
  ambiguous: number;
  indeterminate: number;
}

/**
 * Win rate among strictly resolved events (wins / (wins + losses)) with a
 * Wilson score 95% confidence interval — chosen over a plain normal
 * approximation because it stays well-behaved at small sample sizes and at
 * rates near 0/1, both of which are realistic for an early gold study; not
 * overengineered beyond that (no continuity correction, no other CI
 * families).
 */
export interface WinRateEstimate {
  wins: number;
  losses: number;
  rate: number | null; // null when wins + losses === 0 — never fabricated as 0
  ciLow: number | null;
  ciHigh: number | null;
  method: 'WILSON_SCORE_95';
}

export interface BucketStatistics {
  counts: OutcomeCounts;
  winRate: WinRateEstimate;
  /** Plain descriptive numbers — never framed as exit rules. Null when the bucket is empty. */
  meanAdverseExcursion: number | null;
  meanHoldingDurationMs: number | null;
}

export interface FirstTouchStatisticsSummary {
  overall: BucketStatistics;
  bySupportBuyVsResistanceSell: { supportBuy: BucketStatistics; resistanceSell: BucketStatistics };
  byYear: Record<number, BucketStatistics>;
  /** Always all 24 hours, 0-23, Asia/Beirut — empty buckets still appear with counts.win===0 etc., never omitted. */
  byEntryHour: Record<number, BucketStatistics>;
}

const WILSON_Z_95 = 1.96;

function wilsonInterval(wins: number, n: number): { low: number; high: number } {
  const p = wins / n;
  const z2 = WILSON_Z_95 * WILSON_Z_95;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (WILSON_Z_95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function computeWinRate(wins: number, losses: number): WinRateEstimate {
  const n = wins + losses;
  if (n === 0) {
    return { wins, losses, rate: null, ciLow: null, ciHigh: null, method: 'WILSON_SCORE_95' };
  }
  const { low, high } = wilsonInterval(wins, n);
  return { wins, losses, rate: wins / n, ciLow: low, ciHigh: high, method: 'WILSON_SCORE_95' };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function computeBucketStatistics(resolutions: OutcomeResolution[]): BucketStatistics {
  const counts: OutcomeCounts = { win: 0, loss: 0, unresolved: 0, ambiguous: 0, indeterminate: 0 };
  for (const r of resolutions) {
    if (r.status === 'WIN') counts.win += 1;
    else if (r.status === 'LOSS') counts.loss += 1;
    else if (r.status === 'UNRESOLVED') counts.unresolved += 1;
    else if (r.status === 'AMBIGUOUS') counts.ambiguous += 1;
    else counts.indeterminate += 1;
  }
  return {
    counts,
    winRate: computeWinRate(counts.win, counts.loss),
    meanAdverseExcursion: mean(resolutions.map((r) => r.adverseExcursion)),
    meanHoldingDurationMs: mean(resolutions.filter((r) => r.holdingDurationMs !== null).map((r) => r.holdingDurationMs as number)),
  };
}

type ResolutionSelector = (event: OutcomeEvent) => OutcomeResolution;

function summarize(events: OutcomeEvent[], select: ResolutionSelector): FirstTouchStatisticsSummary {
  const overall = computeBucketStatistics(events.map(select));

  const supportBuy = events.filter((e) => e.role === 'SUPPORT' && e.entryDirection === 'BUY');
  const resistanceSell = events.filter((e) => e.role === 'RESISTANCE' && e.entryDirection === 'SELL');

  const byYear: Record<number, BucketStatistics> = {};
  for (const year of new Set(events.map((e) => e.beirutYear))) {
    byYear[year] = computeBucketStatistics(events.filter((e) => e.beirutYear === year).map(select));
  }

  const byEntryHour: Record<number, BucketStatistics> = {};
  for (let hour = 0; hour < 24; hour++) {
    byEntryHour[hour] = computeBucketStatistics(events.filter((e) => e.beirutHour === hour).map(select));
  }

  return {
    overall,
    bySupportBuyVsResistanceSell: {
      supportBuy: computeBucketStatistics(supportBuy.map(select)),
      resistanceSell: computeBucketStatistics(resistanceSell.map(select)),
    },
    byYear,
    byEntryHour,
  };
}

/** The idealized-price-level statistics path — entry assumed exactly at the level price. Structurally separate from the executable path below; never conflated. */
export function computeIdealizedStatistics(events: OutcomeEvent[]): FirstTouchStatisticsSummary {
  return summarize(events, (e) => e.idealized);
}

export interface ExecutableStatisticsCosts {
  commissionPerTrade?: number;
  swapPerDay?: number;
}

export interface ExecutableStatisticsSummary extends FirstTouchStatisticsSummary {
  /**
   * A simple descriptive estimate — commission + swapPerDay * holding-days,
   * averaged over resolved trades. Only computed when `costs` is supplied;
   * null otherwise (never a fabricated default). This is NOT full account
   * P&L: the study works in fixed $10 price-distance terms, not
   * position-sized currency P&L, so this number is informational only.
   */
  meanEstimatedCostPerTrade: number | null;
}

/** The executable, bid/ask-costed statistics path — entry at the actual reachable price (buy-at-ask / sell-at-bid when a spread was supplied to `resolveOutcome`). Structurally separate from the idealized path above. */
export function computeExecutableStatistics(events: OutcomeEvent[], costs?: ExecutableStatisticsCosts): ExecutableStatisticsSummary {
  const base = summarize(events, (e) => e.executable);

  let meanEstimatedCostPerTrade: number | null = null;
  if (costs) {
    const holdingDurationsMs = events.map((e) => e.executable.holdingDurationMs).filter((ms): ms is number => ms !== null);
    if (holdingDurationsMs.length === 0) {
      meanEstimatedCostPerTrade = 0;
    } else {
      const totalCost = holdingDurationsMs.reduce((sum, ms) => {
        const days = ms / (1000 * 60 * 60 * 24);
        return sum + (costs.commissionPerTrade ?? 0) + (costs.swapPerDay ?? 0) * days;
      }, 0);
      meanEstimatedCostPerTrade = totalCost / holdingDurationsMs.length;
    }
  }

  return { ...base, meanEstimatedCostPerTrade };
}

// ---------------------------------------------------------------------------
// Overlap flagging — no position-limit suppression. Every qualifying event
// is kept; overlapping events (same or different level) are flagged, never
// dropped.
// ---------------------------------------------------------------------------

/** eventId -> ids of other events whose active window overlaps it. O(n^2) — fine at research scale; revisit with a sweep-line if event counts ever get large. */
export function flagOverlappingEvents(events: OutcomeEvent[]): Record<string, string[]> {
  const flags: Record<string, string[]> = {};
  for (const e of events) flags[e.id] = [];

  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i];
      const b = events[j];
      const overlaps =
        a.activeWindow.startUtc.getTime() < b.activeWindow.endUtc.getTime() &&
        b.activeWindow.startUtc.getTime() < a.activeWindow.endUtc.getTime();
      if (overlaps) {
        flags[a.id].push(b.id);
        flags[b.id].push(a.id);
      }
    }
  }
  return flags;
}
