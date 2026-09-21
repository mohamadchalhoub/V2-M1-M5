/**
 * research/confirmed-retest-v2/paper — Output B, the one-position paper
 * simulation (spec §9). It never changes the event study: it walks the
 * replay's STUDY events in order and decides, per scenario branch, whether a
 * flat account could have entered. Outcomes the data cannot pin down fork
 * branches (never an invented release time); an INDETERMINATE branch halts
 * at its gap with a stated limitation.
 */
import { SPEC } from './spec';
import { beirutDateKey, utcToWallClockMs } from './time';
import type { EvalBar, FirstReturnEvent, OutcomeAlternative, Units } from './types';

export type BalanceScenario = (typeof SPEC.paper.startingBalances)[number];
export type CostScenario = (typeof SPEC.costScenarios)[number];

export type Decision =
  | 'ENTERED'
  | 'NOT_ELIGIBLE_OUTSIDE_WINDOW'
  | 'NOT_ELIGIBLE_GAP_CROSS'
  | 'NOT_ELIGIBLE_UNOBSERVABLE'
  | 'NOT_SELECTED_NEAREST'
  | 'SELECTION_ORDER_UNKNOWN_OTHER_SIDE_BRANCH'
  | 'POSITION_OPEN'
  | 'SAME_MINUTE_AS_EXIT'
  | 'DRAWDOWN_BLOCK_ACTIVE'
  | 'DAILY_LOSS_BLOCK_ACTIVE'
  | 'STOP_RISK_EXCEEDS_0_5_PCT'
  | 'COMBINED_RISK_EXCEEDS_1_PCT'
  | 'SPREAD_ASSUMPTION_EXCEEDS_1_USD'
  | 'QUOTE_GATE_FAILED'
  | 'BRANCH_HALTED';

export interface PaperTrade {
  eventId: string;
  direction: 'BUY' | 'SELL';
  entryBarT: number;
  entryPrice: Units;
  result: OutcomeAlternative['result'];
  exitBarT: number | null;
  exitType: OutcomeAlternative['exitType'];
  exitPrice: Units | null;
  grossUsd: number | null;
  costsUsd: { spread: number; commission: number; slippage: number; swap: number } | null;
  netUsd: number | null;
  equityAfterUsd: number | null;
  branchChoice: string;
}

interface OpenPosition {
  event: FirstReturnEvent;
  alt: OutcomeAlternative;
  entryCostsUsd: number;
}

interface Branch {
  labels: string[];
  equity: number;
  peak: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  drawdownBlockedAtT: number | null;
  realizedHistory: Array<{ t: number; equity: number }>;
  dayStartMarks: Record<string, number>;
  position: OpenPosition | null;
  lastExitBarT: number | null;
  trades: PaperTrade[];
  decisions: Record<string, Decision>;
  exposureMs: number;
  halted: { t: number; reason: string } | null;
  openAtEnd: { eventId: string; floatingUsd: number } | null;
}

export interface PaperInput {
  events: FirstReturnEvent[];
  studyStream: EvalBar[];
  studyStartT: number;
  endT: number;
  balance: BalanceScenario;
  cost: CostScenario;
  /** User-set volume (watch-only, audited); defaults to the frozen 0.01 lot. Never changed by this module. */
  volumeLots?: number;
  /** Watch-only shadow track: true when the quote gate rejected this event at decision time (skip and consume). */
  entryVeto?: (event: FirstReturnEvent) => boolean;
}

const USD_PER_UNIT_PER_LOT_OZ = 0.01;

function lotsOz(volumeLots: number): number {
  return volumeLots * SPEC.paper.contractSizeOz;
}

function pnlUsd(direction: 'BUY' | 'SELL', entry: Units, price: Units, volumeLots: number): number {
  return (direction === 'BUY' ? price - entry : entry - price) * USD_PER_UNIT_PER_LOT_OZ * lotsOz(volumeLots);
}

const volumeOf = (input: PaperInput) => input.volumeLots ?? SPEC.paper.volumeLots;

function lowerBound(bars: EvalBar[], t: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function swapNights(entryT: number, exitT: number): number {
  const day = 86_400_000;
  const serverEntryDay = Math.floor(utcToWallClockMs(SPEC.data.brokerServerTimezone, entryT) / day);
  const serverExitDay = Math.floor(utcToWallClockMs(SPEC.data.brokerServerTimezone, exitT) / day);
  let nights = 0;
  for (let d = serverEntryDay; d < serverExitDay; d++) {
    const weekday = new Date(d * day).getUTCDay();
    nights += weekday === SPEC.swapProxy.tripleRolloverWeekdayServer ? 3 : 1;
  }
  return nights;
}

function tradeCosts(cost: CostScenario, direction: 'BUY' | 'SELL', alt: OutcomeAlternative, entryT: number, exitEndT: number, volumeLots: number) {
  const spread = cost.spreadUsdPerOz * lotsOz(volumeLots);
  const commission = cost.commissionUsdPerLotRoundTrip * volumeLots;
  const slippage = alt.result === 'LOSS' || alt.exitType === 'GAP_OPEN' ? cost.stopAndGapSlippageUsdPerOz * lotsOz(volumeLots) : 0;
  let swap = 0;
  if (cost.swap === 'CURRENT_BROKER_SWAP_AS_PROXY') {
    const points = direction === 'BUY' ? SPEC.swapProxy.longPointsPerLotNight : SPEC.swapProxy.shortPointsPerLotNight;
    swap = swapNights(entryT, exitEndT) * points * SPEC.swapProxy.pointUsd * SPEC.paper.contractSizeOz * volumeLots;
  }
  return { spread, commission, slippage, swap };
}

function cloneBranch(b: Branch): Branch {
  return JSON.parse(JSON.stringify(b)) as Branch;
}

function realizedEquityAt(b: Branch, t: number): number {
  let eq = b.realizedHistory[0].equity;
  for (const x of b.realizedHistory) if (x.t <= t) eq = x.equity;
  return eq;
}

/** Walks the bars a position was open for: floating marks for peak, drawdown (adverse extremes) and the drawdown block. */
function markPosition(b: Branch, input: PaperInput, pos: OpenPosition, untilT: number, exitBarT: number | null): void {
  const { event, alt } = pos;
  const outcome = event.outcome!;
  const stream = input.studyStream;
  let prevKey: string | null = null;
  let prevCloseMark = b.equity - pos.entryCostsUsd;
  for (let i = lowerBound(stream, event.touchStartT); i < stream.length && stream[i].t <= untilT; i++) {
    const bar = stream[i];
    const isExit = exitBarT !== null && bar.t === exitBarT;
    const key = beirutDateKey(bar.t);
    // A Beirut day that began while this position was open starts from the last floating mark before it.
    if (prevKey !== null && key !== prevKey && b.dayStartMarks[key] === undefined) b.dayStartMarks[key] = prevCloseMark;
    prevKey = key;
    let adverse = event.direction === 'BUY' ? bar.l : bar.h;
    if (isExit) {
      const bound = alt.result === 'LOSS' ? (alt.exitPrice as number) : outcome.sl;
      adverse = event.direction === 'BUY' ? Math.max(adverse, bound) : Math.min(adverse, bound);
    }
    const adverseEquity = b.equity - pos.entryCostsUsd + pnlUsd(event.direction, outcome.entry, adverse, volumeOf(input));
    if (!isExit) {
      const closeMark = b.equity - pos.entryCostsUsd + pnlUsd(event.direction, outcome.entry, bar.c, volumeOf(input));
      prevCloseMark = closeMark;
      b.peak = Math.max(b.peak, closeMark);
      if (b.drawdownBlockedAtT === null && closeMark <= b.peak * (1 - SPEC.paper.drawdownBlockPct / 100)) b.drawdownBlockedAtT = bar.t + bar.dur;
    }
    const dd = b.peak - adverseEquity;
    if (dd > b.maxDrawdownUsd) b.maxDrawdownUsd = dd;
    if (b.peak > 0 && dd / b.peak > b.maxDrawdownPct) b.maxDrawdownPct = dd / b.peak;
  }
}

function closePosition(b: Branch, input: PaperInput): void {
  const pos = b.position!;
  const { event, alt } = pos;
  const exitEndT = (alt.exitBarT as number) + (alt.exitBarDur as number);
  markPosition(b, input, pos, alt.exitBarT as number, alt.exitBarT);
  const costs = tradeCosts(input.cost, event.direction, alt, event.touchStartT, exitEndT, volumeOf(input));
  const gross = pnlUsd(event.direction, event.outcome!.entry, alt.exitPrice as number, volumeOf(input));
  const net = gross - costs.spread - costs.commission - costs.slippage + costs.swap;
  b.equity += net;
  b.realizedHistory.push({ t: exitEndT, equity: b.equity });
  b.peak = Math.max(b.peak, b.equity);
  const dd = b.peak - b.equity;
  if (dd > b.maxDrawdownUsd) b.maxDrawdownUsd = dd;
  if (b.peak > 0 && dd / b.peak > b.maxDrawdownPct) b.maxDrawdownPct = dd / b.peak;
  if (b.drawdownBlockedAtT === null && b.equity <= b.peak * (1 - SPEC.paper.drawdownBlockPct / 100)) b.drawdownBlockedAtT = exitEndT;
  b.exposureMs += exitEndT - event.touchStartT;
  const trade = b.trades[b.trades.length - 1];
  Object.assign(trade, { grossUsd: gross, costsUsd: costs, netUsd: net, equityAfterUsd: b.equity });
  b.lastExitBarT = alt.exitBarT;
  b.position = null;
}

function alternativesOf(event: FirstReturnEvent): OutcomeAlternative[] {
  const o = event.outcome!;
  const alts = [...o.alternatives];
  if (o.pendingRace) alts.push({ result: 'UNRESOLVED', exitBarT: null, exitBarDur: null, exitType: null, exitPrice: null, gapId: null, haltT: null, path: 'pending' });
  return alts;
}

/** Settles the open position as of time t (exits strictly before t). Returns false if the branch halted. */
function settleBefore(b: Branch, input: PaperInput, t: number): boolean {
  const pos = b.position;
  if (!pos) return true;
  if (pos.alt.result === 'INDETERMINATE' && (pos.alt.haltT as number) <= t) {
    markPosition(b, input, pos, pos.alt.haltT as number, null);
    b.exposureMs += (pos.alt.haltT as number) - pos.event.touchStartT;
    b.halted = { t: pos.alt.haltT as number, reason: `position state unknown after unconfirmed data gap ${pos.alt.gapId}` };
    return false;
  }
  if ((pos.alt.result === 'WIN' || pos.alt.result === 'LOSS') && (pos.alt.exitBarT as number) < t) closePosition(b, input);
  return true;
}

function gateDecision(b: Branch, input: PaperInput, event: FirstReturnEvent): Decision | null {
  const t = event.touchStartT;
  if (b.position) return b.position.alt.exitBarT === t ? 'SAME_MINUTE_AS_EXIT' : 'POSITION_OPEN';
  if (b.lastExitBarT === t) return 'SAME_MINUTE_AS_EXIT';
  if (b.drawdownBlockedAtT !== null && b.drawdownBlockedAtT <= t) return 'DRAWDOWN_BLOCK_ACTIVE';
  const dayKey = beirutDateKey(t);
  const dayStart = b.dayStartMarks[dayKey] ?? realizedEquityAt(b, beirutMidnightBefore(t));
  if (b.equity - dayStart <= -(SPEC.paper.dailyLossBlockPct / 100) * dayStart) return 'DAILY_LOSS_BLOCK_ACTIVE';
  const stopRiskUsd = SPEC.exits.stopLossDistanceUnits * USD_PER_UNIT_PER_LOT_OZ * lotsOz(volumeOf(input));
  if (stopRiskUsd > (SPEC.paper.maxStopRiskPctOfEquity / 100) * b.equity) return 'STOP_RISK_EXCEEDS_0_5_PCT';
  if (stopRiskUsd > (SPEC.paper.maxCombinedRiskPctOfEquity / 100) * b.equity) return 'COMBINED_RISK_EXCEEDS_1_PCT';
  if (input.cost.spreadUsdPerOz > SPEC.shadowQuotes.maxSpreadUsd) return 'SPREAD_ASSUMPTION_EXCEEDS_1_USD';
  return null;
}

function beirutMidnightBefore(t: number): number {
  // Step back minute-by-hour until the Beirut date changes; offsets are whole hours so hour steps suffice.
  const key = beirutDateKey(t);
  let probe = t - (t % 3_600_000);
  while (beirutDateKey(probe - 1) === key) probe -= 3_600_000;
  return probe;
}

export interface PaperLeaf {
  labels: string[];
  trades: PaperTrade[];
  decisions: Record<string, Decision>;
  finalEquityUsd: number;
  netPnlUsd: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  exposurePct: number;
  drawdownBlockedAtT: number | null;
  halted: { t: number; reason: string } | null;
  openAtEnd: { eventId: string; floatingUsd: number } | null;
}

export interface PaperResult {
  balanceId: string;
  costId: string;
  startingBalanceUsd: number;
  leaves: PaperLeaf[];
  branchCapHit: boolean;
}

export function runPaperSimulation(input: PaperInput): PaperResult {
  const events = orderEvents(input.events.filter((e) => e.period === 'STUDY'));
  const leaves: PaperLeaf[] = [];
  let branchCapHit = false;
  const root: Branch = {
    labels: [],
    equity: input.balance.usd,
    peak: input.balance.usd,
    maxDrawdownUsd: 0,
    maxDrawdownPct: 0,
    drawdownBlockedAtT: null,
    realizedHistory: [{ t: Number.MIN_SAFE_INTEGER, equity: input.balance.usd }],
    dayStartMarks: {},
    position: null,
    lastExitBarT: null,
    trades: [],
    decisions: {},
    exposureMs: 0,
    halted: null,
    openAtEnd: null,
  };

  const finish = (b: Branch) => {
    if (!b.halted && b.position) {
      const pos = b.position;
      if (pos.alt.result === 'WIN' || pos.alt.result === 'LOSS') {
        closePosition(b, input);
      } else if (pos.alt.result === 'INDETERMINATE') {
        settleBefore(b, input, Number.MAX_SAFE_INTEGER);
      } else {
        markPosition(b, input, pos, input.endT, null);
        const last = input.studyStream[input.studyStream.length - 1];
        b.openAtEnd = { eventId: pos.event.id, floatingUsd: pnlUsd(pos.event.direction, pos.event.outcome!.entry, last.c, volumeOf(input)) - pos.entryCostsUsd };
        b.exposureMs += input.endT - pos.event.touchStartT;
      }
    }
    const span = Math.max(1, input.endT - input.studyStartT);
    leaves.push({
      labels: b.labels,
      trades: b.trades,
      decisions: b.decisions,
      finalEquityUsd: b.equity,
      netPnlUsd: b.equity - input.balance.usd,
      maxDrawdownUsd: b.maxDrawdownUsd,
      maxDrawdownPct: b.maxDrawdownPct,
      exposurePct: (b.exposureMs / span) * 100,
      drawdownBlockedAtT: b.drawdownBlockedAtT,
      halted: b.halted,
      openAtEnd: b.openAtEnd,
    });
  };

  const walk = (b: Branch, index: number) => {
    for (let i = index; i < events.length; i++) {
      const event = events[i];
      if (b.halted) {
        b.decisions[event.id] = 'BRANCH_HALTED';
        continue;
      }
      if (!settleBefore(b, input, event.touchStartT)) {
        b.decisions[event.id] = 'BRANCH_HALTED';
        continue;
      }
      if (!event.eligible) {
        b.decisions[event.id] = event.ineligibleReason === 'GAP_CROSS' ? 'NOT_ELIGIBLE_GAP_CROSS' : event.ineligibleReason === 'UNOBSERVABLE' ? 'NOT_ELIGIBLE_UNOBSERVABLE' : 'NOT_ELIGIBLE_OUTSIDE_WINDOW';
        continue;
      }
      if (!event.selection?.isSelected) {
        b.decisions[event.id] = 'NOT_SELECTED_NEAREST';
        continue;
      }
      if (input.entryVeto?.(event)) {
        b.decisions[event.id] = 'QUOTE_GATE_FAILED';
        continue;
      }
      const gate = gateDecision(b, input, event);
      if (gate) {
        b.decisions[event.id] = gate;
        continue;
      }

      const sel = event.selection;
      if (sel.bothSelectedSidesTouched && sel.orderKnown === false && !b.labels.some((l) => l.startsWith(`order@${event.touchStartT}:`))) {
        const other = events.find((e) => e.id !== event.id && e.touchStartT === event.touchStartT && e.selection?.isSelected && e.selection.bothSelectedSidesTouched);
        if (other && other.eligible) {
          // Fork: this side first vs. the other side first.
          if (leaves.length + 2 > SPEC.paper.branchCap) {
            branchCapHit = true;
            b.halted = { t: event.touchStartT, reason: 'branch cap reached at a selection-order ambiguity' };
            b.decisions[event.id] = 'BRANCH_HALTED';
            continue;
          }
          const otherFirst = cloneBranch(b);
          otherFirst.labels.push(`order@${event.touchStartT}:${other.levelId}-first`);
          otherFirst.decisions[event.id] = 'SELECTION_ORDER_UNKNOWN_OTHER_SIDE_BRANCH';
          walk(otherFirst, i + 1);
          b.labels.push(`order@${event.touchStartT}:${event.levelId}-first`);
        }
      }
      if (b.labels.some((l) => l === `order@${event.touchStartT}:${otherLevelIdAtSameBar(events, event)}-first`)) {
        b.decisions[event.id] = 'SELECTION_ORDER_UNKNOWN_OTHER_SIDE_BRANCH';
        continue;
      }

      const alts = alternativesOf(event);
      b.decisions[event.id] = 'ENTERED';
      const entryCostsUsd = input.cost.spreadUsdPerOz * lotsOz(volumeOf(input)) + input.cost.commissionUsdPerLotRoundTrip * volumeOf(input);
      if (alts.length > 1 && leaves.length + alts.length > SPEC.paper.branchCap) {
        branchCapHit = true;
        b.halted = { t: event.touchStartT, reason: 'branch cap reached at an uncertain outcome' };
        continue;
      }
      for (let k = alts.length - 1; k >= 0; k--) {
        const target = k === 0 ? b : cloneBranch(b);
        const a = alts[k];
        const label = `${event.id}=>${a.result}${a.exitBarT !== null ? `@${new Date(a.exitBarT).toISOString()}` : ''}`;
        if (alts.length > 1) target.labels.push(label);
        target.position = { event, alt: a, entryCostsUsd };
        target.trades.push({
          eventId: event.id,
          direction: event.direction,
          entryBarT: event.touchStartT,
          entryPrice: event.outcome!.entry,
          result: a.result,
          exitBarT: a.exitBarT,
          exitType: a.exitType,
          exitPrice: a.exitPrice,
          grossUsd: null,
          costsUsd: null,
          netUsd: null,
          equityAfterUsd: null,
          branchChoice: alts.length > 1 ? label : 'determinate',
        });
        if (k > 0) walk(target, i + 1);
      }
    }
    finish(b);
  };

  walk(root, 0);
  return { balanceId: input.balance.id, costId: input.cost.id, startingBalanceUsd: input.balance.usd, leaves, branchCapHit };
}

function otherLevelIdAtSameBar(events: FirstReturnEvent[], event: FirstReturnEvent): string | null {
  const other = events.find((e) => e.id !== event.id && e.touchStartT === event.touchStartT && e.selection?.isSelected && e.selection.bothSelectedSidesTouched);
  return other?.levelId ?? null;
}

/** Chronological, with a known first side ahead of the other side within the same bar. */
function orderEvents(events: FirstReturnEvent[]): FirstReturnEvent[] {
  return [...events].sort((a, b) => {
    if (a.touchStartT !== b.touchStartT) return a.touchStartT - b.touchStartT;
    const af = a.selection?.firstSideLevelId === a.levelId ? 0 : 1;
    const bf = b.selection?.firstSideLevelId === b.levelId ? 0 : 1;
    return af - bf || a.id.localeCompare(b.id);
  });
}
