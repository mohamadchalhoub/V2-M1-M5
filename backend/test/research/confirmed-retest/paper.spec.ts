// Spec §9 one-position paper simulation: gates, one position, same-minute
// re-entry, uncertainty forks/halts, risk and loss blocks, costs.
import { describe, expect, it } from 'vitest';
import { runPaperSimulation, type BalanceScenario, type CostScenario } from '../../../src/research/confirmed-retest/paper';
import { SPEC } from '../../../src/research/confirmed-retest/spec';
import { eventDecisionMatrix, summarizePaper } from '../../../src/research/confirmed-retest/statistics';
import type { EvalBar, FirstReturnEvent, OutcomeAlternative } from '../../../src/research/confirmed-retest/types';
import { M1, usd } from './helpers';

const T0 = Date.parse('2025-02-04T03:00:00.000Z'); // 05:00 Beirut
const PRIMARY = SPEC.paper.startingBalances[0] as BalanceScenario;
const TEN_K = SPEC.paper.startingBalances[1] as BalanceScenario;
const GROSS = SPEC.costScenarios[0] as CostScenario;
const STRESS = SPEC.costScenarios[3] as CostScenario;

function flatStream(minutes: number, price = 2000): EvalBar[] {
  return Array.from({ length: minutes }, (_, i) => ({ t: T0 + i * M1, dur: M1, o: usd(price), h: usd(price + 1), l: usd(price - 1), c: usd(price), res: 'M1' as const, gapBefore: null }));
}

const win = (minute: number, price: number): OutcomeAlternative => ({ result: 'WIN', exitBarT: T0 + minute * M1, exitBarDur: M1, exitType: 'INTRABAR', exitPrice: usd(price), gapId: null, haltT: null, path: 'fixture' });
const loss = (minute: number, price: number): OutcomeAlternative => ({ ...win(minute, price), result: 'LOSS' });

function event(id: string, minute: number, opts: Partial<FirstReturnEvent> & { alternatives?: OutcomeAlternative[]; pending?: boolean; direction?: 'BUY' | 'SELL' } = {}): FirstReturnEvent {
  const direction = opts.direction ?? 'BUY';
  const entry = usd(2000);
  const alternatives = opts.alternatives ?? [win(minute + 5, direction === 'BUY' ? 2010 : 1990)];
  return {
    id,
    levelId: `lvl:${id}`,
    role: direction === 'BUY' ? 'SUPPORT' : 'RESISTANCE',
    levelPrice: entry,
    generation: 1,
    kind: 'ORDINARY',
    period: 'STUDY',
    touchStartT: T0 + minute * M1,
    touchEndT: T0 + (minute + 1) * M1,
    touchResolution: 'M1',
    beirut: { date: '2025-02-04', year: 2025, half: '2025-H1', hour: 5, minute },
    inWindow: true,
    direction,
    eligible: true,
    ineligibleReason: null,
    gapId: null,
    selection: { knownPrice: entry, selectedResistanceId: null, selectedSupportId: `lvl:${id}`, isSelected: true, bothSelectedSidesTouched: false, orderKnown: null, firstSideLevelId: null },
    d1Agreement: false,
    levelActivatedT: T0 - 3_600_000,
    outcome: {
      status: 'WIN',
      entry,
      tp: direction === 'BUY' ? usd(2010) : usd(1990),
      sl: direction === 'BUY' ? usd(1990) : usd(2010),
      entryCandleReachable: ['NONE'],
      alternatives,
      pendingRace: opts.pending ? { eventId: id, direction, entry, tp: usd(2010), sl: usd(1990), mae: 0, lastBarT: T0 } : null,
      maeUnits: 0,
      note: '',
    },
    observedAtT: null,
    ...opts,
  } as FirstReturnEvent;
}

const run = (events: FirstReturnEvent[], balance = TEN_K, cost = GROSS, minutes = 240) =>
  runPaperSimulation({ events, studyStream: flatStream(minutes), studyStartT: T0, endT: T0 + minutes * M1, balance, cost });

describe('gates', () => {
  it('assumed $1,000: 0.01 lot x $10 stop = $10 = 1% > 0.5%, so every entry is skipped for stop risk', () => {
    const result = run([event('a', 1), event('b', 30)], PRIMARY);
    expect(result.leaves).toHaveLength(1);
    expect(result.leaves[0].decisions).toEqual({ a: 'STOP_RISK_EXCEEDS_0_5_PCT', b: 'STOP_RISK_EXCEEDS_0_5_PCT' });
    expect(result.leaves[0].trades).toHaveLength(0);
  });

  it('only one position: a touch while a trade is open is skipped but recorded', () => {
    const leaf = run([event('a', 1, { alternatives: [win(20, 2010)] }), event('b', 10)]).leaves[0];
    expect(leaf.decisions).toEqual({ a: 'ENTERED', b: 'POSITION_OPEN' });
    expect(leaf.netPnlUsd).toBeCloseTo(10, 10);
  });

  it('no re-entry in the minute of an exit; the next minute is allowed', () => {
    const leaf = run([event('a', 1, { alternatives: [win(10, 2010)] }), event('b', 10), event('c', 11)]).leaves[0];
    expect(leaf.decisions).toEqual({ a: 'ENTERED', b: 'SAME_MINUTE_AS_EXIT', c: 'ENTERED' });
  });

  it('ineligible and non-selected events never enter', () => {
    const outside = event('o', 1, { eligible: false, inWindow: false, ineligibleReason: 'OUTSIDE_WINDOW', outcome: null });
    const gapCross = event('g', 2, { eligible: false, kind: 'GAP_CROSS', ineligibleReason: 'GAP_CROSS', outcome: null });
    const notNearest = event('n', 3);
    notNearest.selection = { ...notNearest.selection!, isSelected: false };
    expect(run([outside, gapCross, notNearest]).leaves[0].decisions).toEqual({ o: 'NOT_ELIGIBLE_OUTSIDE_WINDOW', g: 'NOT_ELIGIBLE_GAP_CROSS', n: 'NOT_SELECTED_NEAREST' });
  });

  it('daily loss block after -2% of the Beirut day start equity; drawdown block does not reset', () => {
    // $10,000 scenario: 20 straight $10 losses = -$200 = -2% of the day's starting equity → the 21st touch is blocked
    const losses = Array.from({ length: 21 }, (_, i) => event(`l${i}`, 1 + i * 3, { alternatives: [loss(2 + i * 3, 1990)] }));
    const leaf = run(losses).leaves[0];
    const entered = Object.values(leaf.decisions).filter((d) => d === 'ENTERED').length;
    expect(entered).toBe(20);
    expect(leaf.decisions.l20).toBe('DAILY_LOSS_BLOCK_ACTIVE');
    expect(leaf.netPnlUsd).toBeCloseTo(-200, 10);
  });
});

describe('uncertain outcomes', () => {
  it('an ambiguous WIN/LOSS outcome forks two branches reported as bounds', () => {
    const result = run([event('a', 1, { alternatives: [win(5, 2010), loss(5, 1990)] })]);
    const summary = summarizePaper(result);
    expect(summary.branches).toBe(2);
    expect(summary.netPnlUsd).toEqual([-10, 10]);
    expect(summary.exact).toBe(false);
  });

  it('a release-time-uncertain outcome forks, and the later event is entered in only one branch', () => {
    const result = run([event('a', 1, { alternatives: [win(1, 2010), win(50, 2010)] }), event('b', 20)]);
    expect(eventDecisionMatrix(result).b).toEqual({ ENTERED: 1, POSITION_OPEN: 1 });
  });

  it('an INDETERMINATE branch halts at its gap instead of inventing a release time', () => {
    const indeterminate: OutcomeAlternative = { result: 'INDETERMINATE', exitBarT: null, exitBarDur: null, exitType: null, exitPrice: null, gapId: 'gap:x', haltT: T0 + 30 * M1, path: 'fixture' };
    const leaf = run([event('a', 1, { alternatives: [indeterminate] }), event('b', 40)]).leaves[0];
    expect(leaf.halted).toMatchObject({ t: T0 + 30 * M1 });
    expect(leaf.decisions.b).toBe('BRANCH_HALTED');
  });

  it('a pending race keeps the position open to the end of data', () => {
    const leaf = run([event('a', 1, { alternatives: [], pending: true }), event('b', 100)]).leaves[0];
    expect(leaf.decisions.b).toBe('POSITION_OPEN');
    expect(leaf.openAtEnd?.eventId).toBe('a');
  });

  it('both selected sides with unknown order fork into each side entering first', () => {
    const r = event('r', 7, { direction: 'SELL' });
    const s = event('s', 7);
    for (const e of [r, s]) e.selection = { ...e.selection!, isSelected: true, bothSelectedSidesTouched: true, orderKnown: false };
    const matrix = eventDecisionMatrix(run([r, s]));
    expect(matrix.r).toEqual({ ENTERED: 1, SELECTION_ORDER_UNKNOWN_OTHER_SIDE_BRANCH: 1 });
    expect(matrix.s).toEqual({ ENTERED: 1, POSITION_OPEN: 1 });
  });
});

describe('costs and drawdown', () => {
  it('stress costs: spread $0.60 + commission $0.07 on a win; plus $0.25 slippage on a stop', () => {
    const w = run([event('a', 1, { alternatives: [win(5, 2010)] })], TEN_K, STRESS).leaves[0].trades[0];
    expect(w.grossUsd).toBeCloseTo(10, 10);
    expect(w.netUsd).toBeCloseTo(10 - 0.6 - 0.07, 10);
    const l = run([event('a', 1, { alternatives: [loss(5, 1990)] })], TEN_K, STRESS).leaves[0].trades[0];
    expect(l.netUsd).toBeCloseTo(-10 - 0.6 - 0.07 - 0.25, 10);
  });

  it('a gap-open stop fills at the observed open, not the nominal stop', () => {
    const gapLoss: OutcomeAlternative = { ...loss(5, 1985), exitType: 'GAP_OPEN' };
    const t = run([event('a', 1, { alternatives: [gapLoss] })]).leaves[0].trades[0];
    expect(t.grossUsd).toBeCloseTo(-15, 10);
  });

  it('floating losses count toward equity drawdown even when the trade later wins', () => {
    const stream = flatStream(240);
    stream[3] = { ...stream[3], l: usd(1992), c: usd(1995) }; // -$8 floating low, -$5 close mark
    const result = runPaperSimulation({ events: [event('a', 1, { alternatives: [win(6, 2010)] })], studyStream: stream, studyStartT: T0, endT: T0 + 240 * M1, balance: TEN_K, cost: GROSS });
    // peak stays $10,000 (close marks never exceed entry); worst adverse mark is bar 3's low 1992 → -$8
    expect(result.leaves[0].maxDrawdownUsd).toBeCloseTo(8, 10);
    expect(result.leaves[0].netPnlUsd).toBeCloseTo(10, 10);
  });
});
