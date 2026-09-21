/**
 * research/confirmed-retest-v2/outcome — the idealized ±$10 race (spec §7).
 *
 * Model assumption, stated once: within a bar, price moves CONTINUOUSLY
 * along some path that starts at the open, ends at the close and visits
 * exactly the high and low as its extremes. OHLC does not say which path,
 * so every function here reasons about the set of results reachable by ANY
 * such path, and reports more than one as ambiguity rather than choosing.
 * Between bars (including across gaps) price may jump; that is handled
 * explicitly via the next bar's open and the gap classification.
 */
import { SPEC } from './spec';
import type { Bar, Direction, EvalBar, FinalResult, Outcome, OutcomeAlternative, OutcomeStatus, RaceState, Units } from './types';

export type EntryReach = 'WIN' | 'LOSS' | 'NONE';

export function exitLevels(direction: Direction, entry: Units): { tp: Units; sl: Units } {
  const tpd = SPEC.exits.takeProfitDistanceUnits;
  const sld = SPEC.exits.stopLossDistanceUnits;
  return direction === 'BUY' ? { tp: entry + tpd, sl: entry - sld } : { tp: entry - tpd, sl: entry + sld };
}

const sign = (direction: Direction) => (direction === 'BUY' ? 1 : -1);

/**
 * Exact reachable post-entry results for the bar in which an ORDINARY touch
 * of `entry` happens. Signed axis: TP is "up". Preconditions (guaranteed by
 * touch classification): adv ≤ sEntry ≤ sOpen ≤ fav.
 *
 * - adv (the stop-side extreme) is only reachable by crossing sEntry, and the
 *   first crossing IS the entry, so adv is always visited after entry:
 *   LOSS reachable ⇔ adv ≤ sSl (go straight from entry to adv).
 * - WIN reachable ⇔ fav ≥ sTp (entry, then fav, then adv, then close).
 * - NONE reachable ⇔ adv > sSl and the post-entry maximum can stay below sTp:
 *   if the open is strictly above entry, fav can be visited before entry, so
 *   the post-entry maximum is max(sEntry, sClose); if open == entry, fav is
 *   necessarily post-entry.
 */
export function entryCandleReachable(bar: Bar, direction: Direction, entry: Units, tp: Units, sl: Units): EntryReach[] {
  const s = sign(direction);
  const sOpen = bar.o * s;
  const sClose = bar.c * s;
  const sEntry = entry * s;
  const sTp = tp * s;
  const sSl = sl * s;
  const fav = Math.max(bar.h * s, bar.l * s);
  const adv = Math.min(bar.h * s, bar.l * s);
  if (!(adv <= sEntry && sEntry <= sOpen && sOpen <= fav)) {
    throw new Error(`entryCandleReachable precondition violated (bar t=${new Date(bar.t).toISOString()}, entry=${entry}, ${direction})`);
  }
  const out: EntryReach[] = [];
  if (fav >= sTp) out.push('WIN');
  if (adv <= sSl) out.push('LOSS');
  const postEntryMax = sOpen > sEntry ? Math.max(sEntry, sClose) : fav;
  if (adv > sSl && postEntryMax < sTp) out.push('NONE');
  return out;
}

export interface VerifiedTicks {
  /** Must be true only when the tick SOURCE attests completeness for this bar; a small inter-tick gap is not such evidence. */
  completenessAttested: boolean;
  source: string;
  bids: Array<{ t: number; bid: Units }>;
}

/** Ticks are usable for a bar only if attested complete AND their bids reproduce the bar's OHLC exactly. */
export function ticksReconcile(bar: Bar, ticks: VerifiedTicks | undefined): boolean {
  if (!ticks || !ticks.completenessAttested || ticks.bids.length === 0) return false;
  const seq = [...ticks.bids].sort((a, b) => a.t - b.t);
  if (seq[0].t < bar.t || seq[seq.length - 1].t >= bar.t + bar.dur) return false;
  let hi = -Infinity;
  let lo = Infinity;
  for (const x of seq) {
    hi = Math.max(hi, x.bid);
    lo = Math.min(lo, x.bid);
  }
  return seq[0].bid === bar.o && seq[seq.length - 1].bid === bar.c && hi === bar.h && lo === bar.l;
}

/** Walks a reconciled tick sequence: entry at the first tick reaching `entry` (null = already entered), then first TP/SL crossing. */
export function resolveWithTicks(ticks: VerifiedTicks, direction: Direction, entry: Units | null, tp: Units, sl: Units): { result: 'WIN' | 'LOSS' | 'NONE'; t: number | null } {
  const s = sign(direction);
  let entered = entry === null;
  for (const x of [...ticks.bids].sort((a, b) => a.t - b.t)) {
    const v = x.bid * s;
    if (!entered) {
      if (v <= (entry as number) * s) entered = true;
      else continue;
    }
    if (v >= tp * s) return { result: 'WIN', t: x.t };
    if (v <= sl * s) return { result: 'LOSS', t: x.t };
  }
  return { result: 'NONE', t: null };
}

export type TickLookup = (bar: Bar) => VerifiedTicks | undefined;

function alt(result: FinalResult, bar: Bar | null, exitType: 'INTRABAR' | 'GAP_OPEN' | null, exitPrice: Units | null, path: string): OutcomeAlternative {
  return {
    result,
    exitBarT: bar ? bar.t : null,
    exitBarDur: bar ? bar.dur : null,
    exitType,
    exitPrice,
    gapId: null,
    haltT: null,
    path,
  };
}

export type RaceStep = { done: false } | { done: true; alternatives: OutcomeAlternative[]; note: string };

/** Advances a running race (entry already behind it) by one evaluation bar. */
export function raceStep(race: RaceState, bar: EvalBar, ticks?: TickLookup): RaceStep {
  const s = sign(race.direction);
  const sTp = race.tp * s;
  const sSl = race.sl * s;
  const gap = bar.gapBefore;
  if (gap && gap.kind === 'UNCONFIRMED_UNBRIDGED') {
    return { done: true, alternatives: [{ ...alt('INDETERMINATE', null, null, null, 'unbridged-gap'), gapId: gap.id, haltT: gap.startT }], note: `unconfirmed, unbridged data gap ${gap.id} while the trade was open` };
  }
  if (gap && gap.kind === 'UNCONFIRMED_BRIDGED') {
    const lo = gap.bridgeLow as number;
    const hi = gap.bridgeHigh as number;
    if ((race.tp >= lo && race.tp <= hi) || (race.sl >= lo && race.sl <= hi)) {
      return { done: true, alternatives: [{ ...alt('INDETERMINATE', null, null, null, 'bridge-contains-exit'), gapId: gap.id, haltT: gap.startT }], note: `M5 bridge of gap ${gap.id} contains TP or SL` };
    }
  }

  const sOpen = bar.o * s;
  const fav = Math.max(bar.h * s, bar.l * s);
  const adv = Math.min(bar.h * s, bar.l * s);
  race.mae = Math.max(race.mae, race.entry * s - adv);
  race.lastBarT = bar.t;

  if (sOpen >= sTp) {
    return { done: true, alternatives: [alt('WIN', bar, sOpen > sTp ? 'GAP_OPEN' : 'INTRABAR', sOpen > sTp ? bar.o : race.tp, 'open-at-or-beyond-tp')], note: '' };
  }
  if (sOpen <= sSl) {
    return { done: true, alternatives: [alt('LOSS', bar, sOpen < sSl ? 'GAP_OPEN' : 'INTRABAR', sOpen < sSl ? bar.o : race.sl, 'open-at-or-beyond-sl')], note: '' };
  }
  const tpHit = fav >= sTp;
  const slHit = adv <= sSl;
  if (tpHit && slHit) {
    const verified = ticks?.(bar);
    if (verified && ticksReconcile(bar, verified)) {
      const r = resolveWithTicks(verified, race.direction, null, race.tp, race.sl);
      if (r.result !== 'NONE') {
        return { done: true, alternatives: [alt(r.result, bar, 'INTRABAR', r.result === 'WIN' ? race.tp : race.sl, 'verified-ticks')], note: `resolved by attested ticks (${verified.source})` };
      }
    }
    return {
      done: true,
      alternatives: [alt('WIN', bar, 'INTRABAR', race.tp, 'same-bar-both'), alt('LOSS', bar, 'INTRABAR', race.sl, 'same-bar-both')],
      note: `TP and SL both inside bar ${new Date(bar.t).toISOString()}; order unknown`,
    };
  }
  if (tpHit) return { done: true, alternatives: [alt('WIN', bar, 'INTRABAR', race.tp, 'tp-inside-bar')], note: '' };
  if (slHit) return { done: true, alternatives: [alt('LOSS', bar, 'INTRABAR', race.sl, 'sl-inside-bar')], note: '' };
  return { done: false };
}

/** Builds the outcome for an eligible ORDINARY touch on `bar`; a NONE branch leaves a pending race. */
export function startOutcome(eventId: string, bar: EvalBar, direction: Direction, entry: Units, ticks?: TickLookup): Outcome {
  const { tp, sl } = exitLevels(direction, entry);
  const s = sign(direction);
  let reach = entryCandleReachable(bar, direction, entry, tp, sl);
  let note = '';
  const verified = ticks?.(bar);
  if (reach.length > 1 && verified && ticksReconcile(bar, verified)) {
    reach = [resolveWithTicks(verified, direction, entry, tp, sl).result];
    note = `entry bar resolved by attested ticks (${verified.source})`;
  }
  const adv = Math.min(bar.h * s, bar.l * s);
  const alternatives: OutcomeAlternative[] = [];
  if (reach.includes('WIN')) alternatives.push(alt('WIN', bar, 'INTRABAR', tp, 'entry-bar-win'));
  if (reach.includes('LOSS')) alternatives.push(alt('LOSS', bar, 'INTRABAR', sl, 'entry-bar-loss'));
  const pendingRace: RaceState | null = reach.includes('NONE')
    ? { eventId, direction, entry, tp, sl, mae: Math.max(0, entry * s - adv), lastBarT: bar.t }
    : null;
  if (reach.length > 1) note = note || `entry bar admits ${reach.join('/')}`;
  const outcome: Outcome = {
    status: 'UNRESOLVED',
    entry,
    tp,
    sl,
    entryCandleReachable: reach,
    alternatives,
    pendingRace,
    maeUnits: Math.max(0, entry * s - adv),
    note,
  };
  outcome.status = outcomeStatus(outcome);
  return outcome;
}

export function applyRaceStep(outcome: Outcome, step: RaceStep): void {
  if (!step.done || !outcome.pendingRace) return;
  outcome.maeUnits = Math.max(outcome.maeUnits, outcome.pendingRace.mae);
  outcome.alternatives.push(...step.alternatives.map((a) => ({ ...a, path: `continuation:${a.path}` })));
  if (step.note) outcome.note = outcome.note ? `${outcome.note}; ${step.note}` : step.note;
  outcome.pendingRace = null;
  outcome.status = outcomeStatus(outcome);
}

/** Spec §7 event status: WIN+LOSS reachable → AMBIGUOUS (final); else pending → UNRESOLVED; else INDETERMINATE; else the single result. */
export function outcomeStatus(outcome: Outcome): OutcomeStatus {
  const results = new Set(outcome.alternatives.map((a) => a.result));
  if (results.has('WIN') && results.has('LOSS')) return 'AMBIGUOUS';
  if (outcome.pendingRace || results.has('UNRESOLVED')) return 'UNRESOLVED';
  if (results.has('INDETERMINATE')) return 'INDETERMINATE';
  if (results.has('WIN')) return 'WIN';
  if (results.has('LOSS')) return 'LOSS';
  throw new Error('outcome has no alternatives and no pending race');
}
