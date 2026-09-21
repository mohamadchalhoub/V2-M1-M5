/**
 * The automatic 24-hour performance report (§13.1).
 *
 * Pure aggregation, kept free of I/O so the classification rules — which are
 * the part that can silently misreport — are exhaustively testable.
 *
 * ## What a "completed position" is
 *
 * A position, not a deal. §13.1 is explicit that partial-exit deals are
 * aggregated into their owning position and that multiple exit deals must
 * never be counted as multiple completed positions. A position that exited
 * in three tranches is one row here, classified once, by the sum of its
 * attributable deals.
 *
 * ## Four buckets, not two
 *
 * Wins and losses are the two the user asked to see per timeframe, but they
 * are not exhaustive and reporting them as though they were would overstate
 * one of them:
 *
 * - **zero** — a net realized result of exactly 0 is neither a win nor a
 *   loss, and §6.4 already refuses to treat it as a loss for locking. It is
 *   reported on its own line.
 * - **unresolved** — a position whose deals are not yet fully reconciled has
 *   no trustworthy result at all. Counting it anywhere would be a guess, so
 *   it is reported separately until it resolves and is picked up by a later
 *   interval.
 *
 * ## Interval ownership
 *
 * A position belongs to the interval its broker-confirmed CLOSURE falls in,
 * on a half-open `[start, end)` boundary. Half-open is what makes
 * consecutive intervals non-overlapping without a gap, so a closure landing
 * exactly on a boundary is counted once, by the later interval.
 */
import { classifyClosure, type ClosureOutcome, type LossClassification } from './locks';
import { TIMEFRAMES, type Timeframe } from './spec';

export interface ReportInterval {
  /** Inclusive start, UTC ms. */
  readonly startT: number;
  /** Exclusive end, UTC ms. */
  readonly endT: number;
}

export interface TimeframeTally {
  readonly wins: number;
  readonly losses: number;
  readonly zero: number;
  readonly unresolved: number;
  /** Net realized across the resolved positions in this bucket. */
  readonly netRealized: number;
}

export interface PerformanceReport {
  readonly strategyVersion: string;
  readonly accountLabel: string;
  readonly interval: ReportInterval;
  readonly byTimeframe: Readonly<Record<Timeframe, TimeframeTally>>;
  readonly combined: TimeframeTally;
  /** Position identities included, persisted so a rerun cannot double-count (§13.1). */
  readonly includedPositionIds: readonly string[];
}

const EMPTY: TimeframeTally = { wins: 0, losses: 0, zero: 0, unresolved: 0, netRealized: 0 };

function add(tally: TimeframeTally, classification: LossClassification, netRealized: number): TimeframeTally {
  switch (classification) {
    case 'WIN':
      return { ...tally, wins: tally.wins + 1, netRealized: tally.netRealized + netRealized };
    case 'LOSS':
      return { ...tally, losses: tally.losses + 1, netRealized: tally.netRealized + netRealized };
    case 'ZERO':
      return { ...tally, zero: tally.zero + 1 };
    case 'UNRESOLVED':
      // Deliberately contributes nothing to netRealized: its result is not
      // known, and folding an unreconciled figure into a reported total is
      // exactly the false precision §13.1 guards against.
      return { ...tally, unresolved: tally.unresolved + 1 };
  }
}

function merge(a: TimeframeTally, b: TimeframeTally): TimeframeTally {
  return {
    wins: a.wins + b.wins,
    losses: a.losses + b.losses,
    zero: a.zero + b.zero,
    unresolved: a.unresolved + b.unresolved,
    netRealized: a.netRealized + b.netRealized,
  };
}

/** A closure belongs to `[startT, endT)`. */
export function closureFallsInInterval(closedAt: number, interval: ReportInterval): boolean {
  return closedAt >= interval.startT && closedAt < interval.endT;
}

export interface BuildReportInput {
  readonly strategyVersion: string;
  readonly accountLabel: string;
  readonly interval: ReportInterval;
  /**
   * Broker-confirmed closures of positions THIS strategy owned. Ownership
   * and foreign-position filtering happen upstream, by magic number; anything
   * reaching here is already known to be ours. Each entry is one POSITION,
   * with its deals already aggregated into `netRealized`.
   */
  readonly closures: readonly ClosureOutcome[];
}

export function buildReport(input: BuildReportInput): PerformanceReport {
  const byTimeframe: Record<Timeframe, TimeframeTally> = { M1: EMPTY, M5: EMPTY };
  const includedPositionIds: string[] = [];
  const seenPositionIds = new Set<string>();

  for (const closure of input.closures) {
    if (!closureFallsInInterval(closure.closedAt, input.interval)) continue;
    // A position appearing twice in the input — because two workers both
    // fetched it, or a broker page overlapped — is counted once.
    if (seenPositionIds.has(closure.positionId)) continue;
    seenPositionIds.add(closure.positionId);
    includedPositionIds.push(closure.positionId);

    const classification = classifyClosure(closure);
    byTimeframe[closure.timeframe] = add(byTimeframe[closure.timeframe], classification, closure.netRealized);
  }

  const combined = TIMEFRAMES.reduce<TimeframeTally>((acc, tf) => merge(acc, byTimeframe[tf]), EMPTY);

  return {
    strategyVersion: input.strategyVersion,
    accountLabel: input.accountLabel,
    interval: input.interval,
    byTimeframe,
    combined,
    includedPositionIds,
  };
}

/**
 * The next reporting interval after `previousEnd`, one period long.
 *
 * Intervals are derived from the previous END rather than from "now", so a
 * late run does not silently skip the period it missed, and two workers
 * computing the next interval independently arrive at the same answer —
 * which is what makes the persisted non-overlap property hold without a
 * lock (§13.1).
 */
export const REPORT_PERIOD_MS = 24 * 60 * 60 * 1000;

export function nextInterval(previousEnd: number, periodMs: number = REPORT_PERIOD_MS): ReportInterval {
  return { startT: previousEnd, endT: previousEnd + periodMs };
}

/** True when `interval` is ready to be reported at `nowT`. */
export function intervalIsComplete(interval: ReportInterval, nowT: number): boolean {
  return nowT >= interval.endT;
}

/**
 * Renders the report for Telegram (§13.1 — identify the bot, the account and
 * the interval; separate M1, M5 and combined; report zero and unresolved on
 * their own lines).
 */
export function renderReport(report: PerformanceReport): string {
  const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');
  const line = (label: string, t: TimeframeTally) =>
    `${label}: ${t.wins} win${t.wins === 1 ? '' : 's'}, ${t.losses} loss${t.losses === 1 ? '' : 'es'}` +
    (t.zero > 0 ? `, ${t.zero} zero-result` : '') +
    (t.unresolved > 0 ? `, ${t.unresolved} unresolved` : '') +
    ` — net ${t.netRealized >= 0 ? '+' : ''}${t.netRealized.toFixed(2)}`;

  return [
    `${report.strategyVersion} — 24h performance`,
    `Account: ${report.accountLabel}`,
    `Interval: ${iso(report.interval.startT)} to ${iso(report.interval.endT)}`,
    '',
    line('M1', report.byTimeframe.M1),
    line('M5', report.byTimeframe.M5),
    line('Combined', report.combined),
    '',
    `Positions counted: ${report.includedPositionIds.length}. Broker-confirmed, fully closed positions only; ` +
      'open positions, pending requests and positions belonging to any other application are excluded. ' +
      'Zero-result and unresolved closures are listed separately and are not counted as wins or losses.',
  ].join('\n');
}
