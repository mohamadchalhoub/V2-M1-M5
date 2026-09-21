/**
 * research/confirmed-retest/replay — the chronological replay engine (spec
 * §4–§7). One JSON-serializable state object; `advance()` consumes
 * evaluation bars strictly in time order and, before each bar, every H4/D1
 * bar that has CLOSED by that bar's open. The same function drives the
 * historical study and the watch-only runner, so a replay split at any bar
 * boundary and resumed from serialized state produces identical results.
 */
import { consumeLevel, createLevelEngineState, onD1Close, onH4Close, type LevelEngineState } from './levels';
import { applyRaceStep, raceStep, startOutcome, type TickLookup } from './outcome';
import { SPEC, SPEC_HASH } from './spec';
import { beirutSecondsOfDay, beirutStamp } from './time';
import type { Bar, EvalBar, FirstReturnEvent, Level, SelectionInfo, TouchKind } from './types';

export interface ReplayState {
  specHash: string;
  studyStartT: number;
  levels: LevelEngineState;
  lastEvalBar: { t: number; dur: number; c: number } | null;
  events: Record<string, FirstReturnEvent>;
  eventOrder: string[];
  /** Event ids whose outcome still has a pending race. */
  pendingRaceEventIds: string[];
  /** Everything with a close ≤ clockT has been processed. */
  clockT: number;
  counters: {
    evalBarsProcessed: number;
    evalBarsByResolution: Record<string, number>;
    selectionBothSidesTouched: number;
  };
}

export function createReplayState(studyStartT: number): ReplayState {
  return {
    specHash: SPEC_HASH,
    studyStartT,
    levels: createLevelEngineState(),
    lastEvalBar: null,
    events: {},
    eventOrder: [],
    pendingRaceEventIds: [],
    clockT: Number.NEGATIVE_INFINITY,
    counters: { evalBarsProcessed: 0, evalBarsByResolution: {}, selectionBothSidesTouched: 0 },
  };
}

export interface ReplayData {
  h4: Bar[];
  d1: Bar[];
  stream: EvalBar[];
}

export interface AdvanceOptions {
  /** Process data with close ≤ endT. */
  endT: number;
  ticks?: TickLookup;
  /** Stamped on newly created events (watch-only forward observations). */
  observedAtT?: number | null;
}

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

/** Processes every D1 and H4 bar with close ≤ untilT that is newer than what the state has seen (D1 before H4 at equal close times). */
function processHigherTimeframes(state: ReplayState, data: ReplayData, untilT: number): void {
  const lv = state.levels;
  let hi = lv.lastH4T === null ? 0 : lowerBound(data.h4, lv.lastH4T + 1);
  let di = lv.lastD1T === null ? 0 : lowerBound(data.d1, lv.lastD1T + 1);
  for (;;) {
    const h = hi < data.h4.length && data.h4[hi].t + data.h4[hi].dur <= untilT ? data.h4[hi] : null;
    const d = di < data.d1.length && data.d1[di].t + data.d1[di].dur <= untilT ? data.d1[di] : null;
    if (!h && !d) break;
    if (d && (!h || d.t + d.dur <= h.t + h.dur)) {
      onD1Close(lv, d);
      di += 1;
    } else if (h) {
      onH4Close(lv, h);
      hi += 1;
    }
  }
}

function classifyTouch(level: Level, bar: EvalBar): TouchKind | null {
  const gap = bar.gapBefore;
  if (gap && gap.endT > level.activatedT) {
    if (gap.kind === 'UNCONFIRMED_UNBRIDGED') return 'UNOBSERVABLE';
    if (gap.kind === 'UNCONFIRMED_BRIDGED' && level.price >= (gap.bridgeLow as number) && level.price <= (gap.bridgeHigh as number)) return 'UNOBSERVABLE';
  }
  const L = level.price;
  if (level.role === 'RESISTANCE') {
    if (bar.o > L) return 'GAP_CROSS';
    if (bar.o === L || bar.h >= L) return 'ORDINARY';
    return null;
  }
  if (bar.o < L) return 'GAP_CROSS';
  if (bar.o === L || bar.l <= L) return 'ORDINARY';
  return null;
}

function selectionAtBarStart(state: ReplayState): { knownPrice: number | null; resistanceId: string | null; supportId: string | null } {
  const known = state.lastEvalBar?.c ?? null;
  if (known === null) return { knownPrice: null, resistanceId: null, supportId: null };
  let r: Level | null = null;
  let s: Level | null = null;
  for (const id of state.levels.activeLevelIds) {
    const lvl = state.levels.levels[id];
    if (lvl.role === 'RESISTANCE' && lvl.price >= known && (!r || lvl.price < r.price)) r = lvl;
    if (lvl.role === 'SUPPORT' && lvl.price <= known && (!s || lvl.price > s.price)) s = lvl;
  }
  return { knownPrice: known, resistanceId: r?.id ?? null, supportId: s?.id ?? null };
}

function processEvalBar(state: ReplayState, data: ReplayData, bar: EvalBar, opts: AdvanceOptions): void {
  processHigherTimeframes(state, data, bar.t);
  const lv = state.levels;
  const sel = selectionAtBarStart(state);

  // Races already running (created on earlier bars).
  for (const eventId of [...state.pendingRaceEventIds]) {
    const outcome = state.events[eventId].outcome;
    if (!outcome?.pendingRace || outcome.pendingRace.lastBarT >= bar.t) continue;
    const step = raceStep(outcome.pendingRace, bar, opts.ticks);
    if (step.done) {
      applyRaceStep(outcome, step);
      state.pendingRaceEventIds = state.pendingRaceEventIds.filter((id) => id !== eventId);
    }
  }

  // First returns of active levels.
  const created: FirstReturnEvent[] = [];
  const activeIds = [...lv.activeLevelIds].sort((a, b) => lv.levels[a].activatedT - lv.levels[b].activatedT || a.localeCompare(b));
  for (const id of activeIds) {
    const level = lv.levels[id];
    if (bar.t < level.activatedT) continue;
    const kind = classifyTouch(level, bar);
    if (!kind) continue;
    const gap = bar.gapBefore;
    const touchStartT = kind === 'UNOBSERVABLE' ? Math.max((gap as NonNullable<typeof gap>).startT, level.activatedT) : bar.t;
    const period = touchStartT >= state.studyStartT ? 'STUDY' : 'PRE_STUDY';
    const secs = beirutSecondsOfDay(bar.t);
    const inWindow = kind === 'UNOBSERVABLE' ? null : secs >= SPEC.session.entryWindowStartSecondsBeirut && secs < SPEC.session.entryWindowEndSecondsBeirutExclusive;
    const eligible = kind === 'ORDINARY' && period === 'STUDY' && inWindow === true;
    const ineligibleReason = eligible
      ? null
      : period === 'PRE_STUDY'
        ? 'PRE_STUDY'
        : kind === 'GAP_CROSS'
          ? 'GAP_CROSS'
          : kind === 'UNOBSERVABLE'
            ? 'UNOBSERVABLE'
            : 'OUTSIDE_WINDOW';
    const event: FirstReturnEvent = {
      id: `evt:${level.id}`,
      levelId: level.id,
      role: level.role,
      levelPrice: level.price,
      generation: level.generation,
      kind,
      period,
      touchStartT,
      touchEndT: bar.t + bar.dur,
      touchResolution: bar.res,
      beirut: beirutStamp(touchStartT),
      inWindow,
      direction: level.role === 'SUPPORT' ? 'BUY' : 'SELL',
      eligible,
      ineligibleReason,
      gapId: kind === 'UNOBSERVABLE' ? (gap?.id ?? null) : null,
      selection: null,
      d1Agreement: level.d1Agreement,
      levelActivatedT: level.activatedT,
      outcome: null,
      observedAtT: opts.observedAtT ?? null,
    };
    if (period === 'STUDY') {
      const selection: SelectionInfo = {
        knownPrice: sel.knownPrice,
        selectedResistanceId: sel.resistanceId,
        selectedSupportId: sel.supportId,
        isSelected: level.id === sel.resistanceId || level.id === sel.supportId,
        bothSelectedSidesTouched: false,
        orderKnown: null,
        firstSideLevelId: null,
      };
      event.selection = selection;
    }
    created.push(event);
  }

  // Both selected sides returned in the same bar: order is known only if exactly one side was reached at the open.
  const rEvent = created.find((e) => e.selection && e.levelId === sel.resistanceId && e.kind !== 'UNOBSERVABLE');
  const sEvent = created.find((e) => e.selection && e.levelId === sel.supportId && e.kind !== 'UNOBSERVABLE');
  if (rEvent && sEvent) {
    const rAtOpen = bar.o >= rEvent.levelPrice;
    const sAtOpen = bar.o <= sEvent.levelPrice;
    const orderKnown = rAtOpen !== sAtOpen;
    const first = orderKnown ? (rAtOpen ? rEvent.levelId : sEvent.levelId) : null;
    for (const e of [rEvent, sEvent]) {
      const s = e.selection as SelectionInfo;
      s.bothSelectedSidesTouched = true;
      s.orderKnown = orderKnown;
      s.firstSideLevelId = first;
    }
    state.counters.selectionBothSidesTouched += 1;
  }

  for (const event of created) {
    consumeLevel(lv, event.levelId, event.touchStartT, event.id);
    if (event.eligible) {
      event.outcome = startOutcome(event.id, bar, event.direction, event.levelPrice, opts.ticks);
      if (event.outcome.pendingRace) state.pendingRaceEventIds.push(event.id);
    }
    state.events[event.id] = event;
    state.eventOrder.push(event.id);
  }

  state.lastEvalBar = { t: bar.t, dur: bar.dur, c: bar.c };
  state.clockT = bar.t + bar.dur;
  state.counters.evalBarsProcessed += 1;
  state.counters.evalBarsByResolution[bar.res] = (state.counters.evalBarsByResolution[bar.res] ?? 0) + 1;
}

/** Advances the replay through every evaluation bar with close ≤ endT not yet processed, then every H4/D1 bar with close ≤ endT. */
export function advance(state: ReplayState, data: ReplayData, opts: AdvanceOptions): void {
  if (state.specHash !== SPEC_HASH) {
    throw new Error(`replay state was produced by spec ${state.specHash}, current spec is ${SPEC_HASH} — refusing to mix rule versions`);
  }
  const lastT = state.lastEvalBar?.t ?? Number.NEGATIVE_INFINITY;
  for (let i = lowerBound(data.stream, lastT + 1); i < data.stream.length; i++) {
    const bar = data.stream[i];
    if (bar.t + bar.dur > opts.endT) break;
    processEvalBar(state, data, bar, opts);
  }
  processHigherTimeframes(state, data, opts.endT);
  state.clockT = Math.max(state.clockT, opts.endT);
}

export function cloneState(state: ReplayState): ReplayState {
  return JSON.parse(JSON.stringify(state)) as ReplayState;
}
