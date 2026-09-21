/**
 * §15.7 — the 24-hour performance report.
 *
 * The failure modes worth testing here are all forms of miscounting:
 * counting a multi-deal exit as several positions, folding a zero result
 * into wins or losses, reporting an unreconciled position as though its
 * number were known, double-counting across a restart, and letting a closure
 * on an interval boundary land in two periods at once.
 */
import { describe, expect, it } from 'vitest';
import type { ClosureOutcome } from '../../src/xauusd-m1m5/locks';
import {
  buildReport,
  closureFallsInInterval,
  intervalIsComplete,
  nextInterval,
  REPORT_PERIOD_MS,
  renderReport,
  type ReportInterval,
} from '../../src/xauusd-m1m5/reporting';
import { XAUUSD_M1M5_STRATEGY_VERSION, type Direction, type Timeframe } from '../../src/xauusd-m1m5/spec';

const START = Date.UTC(2026, 8, 21, 0, 0, 0);
const INTERVAL: ReportInterval = { startT: START, endT: START + REPORT_PERIOD_MS };

let seq = 0;
function closed(
  timeframe: Timeframe,
  netRealized: number,
  overrides: Partial<ClosureOutcome> = {},
): ClosureOutcome {
  seq += 1;
  const direction: Direction = netRealized >= 0 ? 'SELL' : 'BUY';
  return {
    closureEventId: `evt-${seq}`,
    positionId: `pos-${seq}`,
    timeframe,
    direction,
    netRealized,
    fullyClosed: true,
    closedAt: START + 3_600_000,
    closureReason: 'TP',
    rsiAtClosure: 50,
    ...overrides,
  };
}

function build(closures: ClosureOutcome[], interval = INTERVAL) {
  return buildReport({
    strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
    accountLabel: 'DEMO 12345678 (MetaQuotes-Demo)',
    interval,
    closures,
  });
}

describe('§13.1 per-timeframe and combined counts', () => {
  it('counts wins and losses separately for M1 and M5', () => {
    const r = build([
      closed('M1', 12),
      closed('M1', 8),
      closed('M1', -5),
      closed('M5', 20),
      closed('M5', -3),
      closed('M5', -7),
    ]);

    expect(r.byTimeframe.M1).toMatchObject({ wins: 2, losses: 1 });
    expect(r.byTimeframe.M5).toMatchObject({ wins: 1, losses: 2 });
    expect(r.combined).toMatchObject({ wins: 3, losses: 3 });
  });

  it('combined totals are the sum of the two timeframes', () => {
    const r = build([closed('M1', 5), closed('M5', -2), closed('M1', 0), closed('M5', 7)]);
    expect(r.combined.wins).toBe(r.byTimeframe.M1.wins + r.byTimeframe.M5.wins);
    expect(r.combined.losses).toBe(r.byTimeframe.M1.losses + r.byTimeframe.M5.losses);
    expect(r.combined.zero).toBe(r.byTimeframe.M1.zero + r.byTimeframe.M5.zero);
  });

  it('sums net realized across resolved positions only', () => {
    const r = build([
      closed('M1', 10),
      closed('M1', -4),
      closed('M1', -100, { fullyClosed: false }), // unresolved: contributes nothing
    ]);
    expect(r.byTimeframe.M1.netRealized).toBe(6);
    expect(r.byTimeframe.M1.unresolved).toBe(1);
  });

  it('an empty interval reports zeroes rather than omitting a timeframe', () => {
    const r = build([]);
    expect(r.byTimeframe.M1).toEqual({ wins: 0, losses: 0, zero: 0, unresolved: 0, netRealized: 0 });
    expect(r.byTimeframe.M5).toEqual({ wins: 0, losses: 0, zero: 0, unresolved: 0, netRealized: 0 });
    expect(r.combined.wins).toBe(0);
  });
});

describe('§13.1 zero and unresolved are reported separately', () => {
  it('a zero result is neither a win nor a loss', () => {
    const r = build([closed('M1', 0)]);
    expect(r.byTimeframe.M1).toMatchObject({ wins: 0, losses: 0, zero: 1 });
  });

  it('an unresolved closure is counted in neither, and does not move the total', () => {
    const r = build([closed('M5', -50, { fullyClosed: false })]);
    expect(r.byTimeframe.M5).toMatchObject({ wins: 0, losses: 0, zero: 0, unresolved: 1, netRealized: 0 });
  });

  it('classification is by net realized result, whatever the closure reason', () => {
    // A Friday liquidation that happened to be profitable is a win; an SL
    // that happened to be profitable (gap in our favour) is also a win.
    const r = build([
      closed('M1', 3, { closureReason: 'FRIDAY_LIQUIDATION' }),
      closed('M1', -3, { closureReason: 'USER_AUTHORIZED_CLOSE' }),
      closed('M5', 1, { closureReason: 'SL' }),
      closed('M5', -1, { closureReason: 'TP' }),
    ]);
    expect(r.combined).toMatchObject({ wins: 2, losses: 2 });
  });

  it('commissions and swap are already folded into the net figure', () => {
    // A gross-positive trade taken negative by costs is a LOSS, because the
    // number reaching this module is the net.
    const r = build([closed('M1', -0.35)]);
    expect(r.byTimeframe.M1.losses).toBe(1);
    expect(r.byTimeframe.M1.wins).toBe(0);
  });
});

describe('§13.1 a position is counted once, not once per deal', () => {
  it('does not count the same position twice when it appears twice', () => {
    // Two workers each fetched the position, or two broker pages overlapped.
    const position = closed('M1', 9, { positionId: 'pos-dup' });
    const r = build([position, { ...position, closureEventId: 'evt-other' }]);
    expect(r.byTimeframe.M1.wins).toBe(1);
    expect(r.includedPositionIds).toEqual(['pos-dup']);
  });

  it('a multi-tranche exit is one position with one aggregated result', () => {
    // The aggregation happens upstream; what this asserts is that the report
    // consumes one row per position and never inflates the count.
    const r = build([closed('M5', 4.5, { positionId: 'pos-partial' })]);
    expect(r.byTimeframe.M5.wins).toBe(1);
    expect(r.combined.wins + r.combined.losses + r.combined.zero + r.combined.unresolved).toBe(1);
  });

  it('records the identities it included, for persistence', () => {
    const r = build([closed('M1', 1, { positionId: 'a' }), closed('M5', -1, { positionId: 'b' })]);
    expect(r.includedPositionIds).toEqual(['a', 'b']);
  });
});

describe('§13.1 interval boundaries are half-open and non-overlapping', () => {
  it('includes a closure exactly at the start and excludes one exactly at the end', () => {
    expect(closureFallsInInterval(INTERVAL.startT, INTERVAL)).toBe(true);
    expect(closureFallsInInterval(INTERVAL.endT, INTERVAL)).toBe(false);
    expect(closureFallsInInterval(INTERVAL.endT - 1, INTERVAL)).toBe(true);
    expect(closureFallsInInterval(INTERVAL.startT - 1, INTERVAL)).toBe(false);
  });

  it('a closure on the boundary is counted by exactly one of two consecutive intervals', () => {
    const first = INTERVAL;
    const second = nextInterval(first.endT);
    const onBoundary = closed('M1', 5, { closedAt: first.endT });

    expect(build([onBoundary], first).byTimeframe.M1.wins).toBe(0);
    expect(build([onBoundary], second).byTimeframe.M1.wins).toBe(1);
  });

  it('excludes closures outside the interval entirely', () => {
    const r = build([
      closed('M1', 5, { closedAt: INTERVAL.startT - 1 }),
      closed('M1', 5, { closedAt: INTERVAL.endT + 1 }),
      closed('M1', 5, { closedAt: INTERVAL.startT }),
    ]);
    expect(r.byTimeframe.M1.wins).toBe(1);
  });

  it('derives the next interval from the previous end, so a late run skips nothing', () => {
    const second = nextInterval(INTERVAL.endT);
    expect(second.startT).toBe(INTERVAL.endT);
    expect(second.endT).toBe(INTERVAL.endT + REPORT_PERIOD_MS);
    // Even computed hours late, the answer is the same — which is what keeps
    // two workers and a restart from producing different periods.
    expect(nextInterval(INTERVAL.endT)).toEqual(second);
  });

  it('a period is only reported once it is complete', () => {
    expect(intervalIsComplete(INTERVAL, INTERVAL.endT - 1)).toBe(false);
    expect(intervalIsComplete(INTERVAL, INTERVAL.endT)).toBe(true);
  });

  it('the period is 24 hours', () => {
    expect(REPORT_PERIOD_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('§13.1 rendering', () => {
  it('identifies the bot, the account and the interval', () => {
    const text = renderReport(build([closed('M1', 5)]));
    expect(text).toContain(XAUUSD_M1M5_STRATEGY_VERSION);
    expect(text).toContain('DEMO 12345678 (MetaQuotes-Demo)');
    expect(text).toMatch(/Interval: .+ to .+/);
  });

  it('shows M1, M5 and combined on separate lines', () => {
    const text = renderReport(build([closed('M1', 5), closed('M5', -2)]));
    expect(text).toMatch(/^M1: 1 win, 0 losses/m);
    expect(text).toMatch(/^M5: 0 wins, 1 loss/m);
    expect(text).toMatch(/^Combined: 1 win, 1 loss/m);
  });

  it('surfaces zero and unresolved counts only when they are non-zero', () => {
    // Scoped to the tally lines: the closing paragraph always explains how
    // zero-result and unresolved closures are treated, whether or not any
    // occurred, so asserting against the whole message would test nothing.
    const tallyLines = (text: string) => text.split('\n').filter((l) => /^(M1|M5|Combined):/.test(l)).join('\n');

    const plain = tallyLines(renderReport(build([closed('M1', 5)])));
    expect(plain).not.toMatch(/zero-result/);
    expect(plain).not.toMatch(/unresolved/i);

    const mixed = tallyLines(renderReport(build([closed('M1', 0), closed('M1', -1, { fullyClosed: false })])));
    expect(mixed).toMatch(/1 zero-result/);
    expect(mixed).toMatch(/1 unresolved/);
  });

  it('states what is excluded, so the numbers cannot be misread', () => {
    const text = renderReport(build([]));
    expect(text).toMatch(/open positions, pending requests/i);
    expect(text).toMatch(/any other application are excluded/i);
    expect(text).toMatch(/not counted as wins or losses/i);
  });
});
