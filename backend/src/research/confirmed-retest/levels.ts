/**
 * research/confirmed-retest/levels — H4 pivot detection, exact-price pair
 * formation and the level lifecycle (spec §4–§5). Pure and incremental:
 * `onH4Close` / `onD1Close` mutate a JSON-serializable state object and are
 * only ever handed COMPLETED bars in chronological order, so a level can
 * never be established from a bar that closes after its activation.
 */
import { SPEC } from './spec';
import type { Bar, KeyState, Level, PivotRecord, Role } from './types';

const H4_WINDOW_KEEP = SPEC.formation.maxPivotIndexDistance + SPEC.pivots.rightBars + 8;
const D1_WINDOW_KEEP = SPEC.d1Agreement.lookbackCompletedD1Bars + SPEC.d1Agreement.rightBars + 8;

export interface IndexedBar extends Bar {
  index: number;
}

export interface D1Pivot {
  role: Role;
  price: number;
  index: number;
  barT: number;
  confirmT: number;
}

export interface FormationDiagnostics {
  h4BarsProcessed: number;
  d1BarsProcessed: number;
  pivotCandidates: Record<Role, number>;
  qualifiedPivots: Record<Role, number>;
  rejectedNoRejectionClose: Record<Role, number>;
  /** Pairs of pivot candidates (qualified or not) with identical role and exact price, at any distance. */
  exactPriceRepeatPairsAnyDistance: Record<Role, number>;
  /** Same, restricted to index distance 5..120. */
  exactPriceRepeatPairsInDistanceWindow: Record<Role, number>;
  /** Pair-level rejection reasons (each same-price earlier candidate within 120 bars counts once per later candidate). */
  pairOutcomes: Record<string, number>;
  levelsActivated: Record<Role, number>;
  activationsBlocked: Record<string, number>;
  d1AgreementTagged: number;
}

export interface LevelEngineState {
  nextH4Index: number;
  lastH4T: number | null;
  h4Window: IndexedBar[];
  nextD1Index: number;
  lastD1T: number | null;
  d1Window: IndexedBar[];
  d1Pivots: D1Pivot[];
  /** role|price -> number of pivot candidates seen so far (for any-distance repeat counts). */
  candidateCountByKey: Record<string, number>;
  /** Candidates whose index is within the last maxPivotIndexDistance+rightBars bars. */
  recentCandidates: PivotRecord[];
  /** Every pivot candidate ever confirmed (output only). */
  pivotLog: PivotRecord[];
  keys: Record<string, KeyState & { retiredT: number | null }>;
  levels: Record<string, Level>;
  activeLevelIds: string[];
  levelSeq: number;
  diagnostics: FormationDiagnostics;
}

const zeroRoles = (): Record<Role, number> => ({ SUPPORT: 0, RESISTANCE: 0 });

export function createLevelEngineState(): LevelEngineState {
  return {
    nextH4Index: 0,
    lastH4T: null,
    h4Window: [],
    nextD1Index: 0,
    lastD1T: null,
    d1Window: [],
    d1Pivots: [],
    candidateCountByKey: {},
    recentCandidates: [],
    pivotLog: [],
    keys: {},
    levels: {},
    activeLevelIds: [],
    levelSeq: 0,
    diagnostics: {
      h4BarsProcessed: 0,
      d1BarsProcessed: 0,
      pivotCandidates: zeroRoles(),
      qualifiedPivots: zeroRoles(),
      rejectedNoRejectionClose: zeroRoles(),
      exactPriceRepeatPairsAnyDistance: zeroRoles(),
      exactPriceRepeatPairsInDistanceWindow: zeroRoles(),
      pairOutcomes: {},
      levelsActivated: zeroRoles(),
      activationsBlocked: {},
      d1AgreementTagged: 0,
    },
  };
}

export const levelKey = (role: Role, price: number): string => `${role}|${price}`;

function bump(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

/** Strict 2-left/2-right pivot test on a window whose middle element is the candidate. */
export function strictPivotRoles(window: Bar[], leftBars: number, rightBars: number): Role[] {
  const mid = window[leftBars];
  const others = window.filter((_, i) => i !== leftBars);
  const roles: Role[] = [];
  if (others.every((b) => mid.h > b.h)) roles.push('RESISTANCE');
  if (others.every((b) => mid.l < b.l)) roles.push('SUPPORT');
  if (window.length !== leftBars + rightBars + 1) throw new Error('pivot window has wrong length');
  return roles;
}

/** Spec §4.4 body filter over bars (inclusive): resistance body tops ≤ level, support body bottoms ≥ level. */
export function bodiesRespectLevel(bars: Bar[], role: Role, price: number): boolean {
  return bars.every((b) => (role === 'RESISTANCE' ? Math.max(b.o, b.c) <= price : Math.min(b.o, b.c) >= price));
}

export interface H4CloseResult {
  activated: string[];
  broken: string[];
  expired: string[];
  retiredKeysBroken: string[];
}

/**
 * Processes one completed H4 bar (spec §4–§5). Order at this close:
 * (1) break of retired keys retired strictly before this close,
 * (2) break then expiry of ACTIVE levels activated before this bar,
 * (3) pivot confirmation for bar index n-2 and pair formation/activation.
 */
export function onH4Close(state: LevelEngineState, bar: Bar): H4CloseResult {
  if (state.lastH4T !== null && bar.t <= state.lastH4T) {
    throw new Error(`H4 bars must be strictly increasing (got ${new Date(bar.t).toISOString()} after ${new Date(state.lastH4T).toISOString()})`);
  }
  const n = state.nextH4Index++;
  const closeT = bar.t + bar.dur;
  const indexed: IndexedBar = { ...bar, index: n };
  state.h4Window.push(indexed);
  if (state.h4Window.length > H4_WINDOW_KEEP) state.h4Window.splice(0, state.h4Window.length - H4_WINDOW_KEEP);
  state.lastH4T = bar.t;
  state.diagnostics.h4BarsProcessed += 1;

  const result: H4CloseResult = { activated: [], broken: [], expired: [], retiredKeysBroken: [] };
  const beyond = (role: Role, price: number) => (role === 'RESISTANCE' ? bar.c > price : bar.c < price);

  // (1) Retired keys: a subsequent confirmed break re-opens the key for a new generation.
  for (const key of Object.keys(state.keys).sort()) {
    const ks = state.keys[key];
    if (ks.phase !== 'RETIRED_UNTIL_BREAK' || ks.retiredT === null || ks.retiredT >= closeT) continue;
    if (beyond(ks.role, ks.price)) {
      ks.phase = 'BROKEN';
      ks.breakH4Index = n;
      ks.breakT = closeT;
      const lvl = state.levels[ks.levelId];
      if (lvl && lvl.laterBreakT === null) lvl.laterBreakT = closeT;
      result.retiredKeysBroken.push(key);
    }
  }

  // (2) Active levels: break before expiry.
  for (const id of [...state.activeLevelIds]) {
    const lvl = state.levels[id];
    if (lvl.activationH4Index >= n) continue;
    lvl.barsSinceActivation += 1;
    const ks = state.keys[lvl.key];
    if (beyond(lvl.role, lvl.price)) {
      lvl.status = 'BROKEN';
      lvl.statusT = closeT;
      ks.phase = 'BROKEN';
      ks.breakH4Index = n;
      ks.breakT = closeT;
      ks.retiredT = closeT;
      result.broken.push(id);
    } else if (lvl.barsSinceActivation >= SPEC.lifecycle.expiryH4BarsAfterActivation) {
      lvl.status = 'EXPIRED';
      lvl.statusT = closeT;
      ks.phase = 'RETIRED_UNTIL_BREAK';
      ks.retiredT = closeT;
      result.expired.push(id);
    }
  }
  state.activeLevelIds = state.activeLevelIds.filter((id) => state.levels[id].status === 'ACTIVE');

  // (3) Pivot confirmation.
  const { leftBars, rightBars } = SPEC.pivots;
  const span = leftBars + rightBars + 1;
  const w = state.h4Window;
  if (w.length >= span && w[w.length - span].index === n - span + 1) {
    const window = w.slice(w.length - span);
    const pivotBar = window[leftBars];
    const after = window.slice(leftBars + 1);
    for (const role of strictPivotRoles(window, leftBars, rightBars)) {
      const price = role === 'RESISTANCE' ? pivotBar.h : pivotBar.l;
      const qualified = after.some((b) =>
        role === 'RESISTANCE'
          ? b.c <= price - SPEC.formation.rejectionMinCloseDistanceUnits
          : b.c >= price + SPEC.formation.rejectionMinCloseDistanceUnits,
      );
      const pivot: PivotRecord = {
        id: `pv:${role}:${pivotBar.index}`,
        role,
        price,
        index: pivotBar.index,
        barT: pivotBar.t,
        confirmT: closeT,
        qualified,
        usedByLevelId: null,
      };
      handleCandidate(state, pivot, n, closeT, result);
    }
  }

  const minRecentIndex = n - (SPEC.formation.maxPivotIndexDistance + rightBars);
  state.recentCandidates = state.recentCandidates.filter((p) => p.index >= minRecentIndex);
  return result;
}

function handleCandidate(state: LevelEngineState, pivot: PivotRecord, n: number, closeT: number, result: H4CloseResult): void {
  const d = state.diagnostics;
  const key = levelKey(pivot.role, pivot.price);
  d.pivotCandidates[pivot.role] += 1;
  if (pivot.qualified) d.qualifiedPivots[pivot.role] += 1;
  else d.rejectedNoRejectionClose[pivot.role] += 1;

  d.exactPriceRepeatPairsAnyDistance[pivot.role] += state.candidateCountByKey[key] ?? 0;
  bump(state.candidateCountByKey, key);

  const { minPivotIndexDistance, maxPivotIndexDistance } = SPEC.formation;
  const earlier = state.recentCandidates
    .filter((p) => p.role === pivot.role && p.price === pivot.price)
    .sort((a, b) => a.index - b.index);

  const valid: PivotRecord[] = [];
  for (const partner of earlier) {
    const dist = pivot.index - partner.index;
    if (dist < minPivotIndexDistance) {
      bump(d.pairOutcomes, 'DISTANCE_LT_5');
      continue;
    }
    if (dist > maxPivotIndexDistance) {
      bump(d.pairOutcomes, 'DISTANCE_GT_120');
      continue;
    }
    d.exactPriceRepeatPairsInDistanceWindow[pivot.role] += 1;
    if (!pivot.qualified || !partner.qualified) {
      bump(d.pairOutcomes, !partner.qualified && !pivot.qualified ? 'BOTH_NOT_QUALIFIED' : !partner.qualified ? 'FIRST_NOT_QUALIFIED' : 'SECOND_NOT_QUALIFIED');
      continue;
    }
    const span = state.h4Window.filter((b) => b.index >= partner.index && b.index <= n);
    if (span.length !== n - partner.index + 1) throw new Error(`H4 window too short for body filter (${partner.index}..${n})`);
    if (!bodiesRespectLevel(span, pivot.role, pivot.price)) {
      bump(d.pairOutcomes, 'BODY_FILTER');
      continue;
    }
    bump(d.pairOutcomes, 'VALID_PAIR');
    valid.push(partner);
  }

  // Separate copies: persisted state must not depend on in-memory object identity (JSON round-trips break it).
  state.pivotLog.push({ ...pivot });
  state.recentCandidates.push(pivot);
  if (valid.length === 0) return;

  const ks = state.keys[key];
  let eligiblePartners = valid;
  if (ks?.phase === 'ACTIVE') {
    bump(d.activationsBlocked, 'REDUNDANT_WHILE_ACTIVE');
    return;
  }
  if (ks?.phase === 'RETIRED_UNTIL_BREAK') {
    bump(d.activationsBlocked, 'RETIRED_UNTIL_BREAK');
    return;
  }
  if (ks?.phase === 'BROKEN') {
    const breakIndex = ks.breakH4Index as number;
    eligiblePartners = valid.filter((p) => p.index > breakIndex && p.usedByLevelId === null);
    if (pivot.index <= breakIndex || pivot.usedByLevelId !== null || eligiblePartners.length === 0) {
      bump(d.activationsBlocked, 'PIVOTS_NOT_NEW_AFTER_BREAK');
      return;
    }
  }

  const first = eligiblePartners[0];
  const generation = (ks?.generation ?? 0) + 1;
  const id = `lvl:${pivot.role === 'RESISTANCE' ? 'R' : 'S'}:${pivot.price}:g${generation}:${++state.levelSeq}`;
  const agreement = findD1Agreement(state, pivot.role, pivot.price, closeT);
  const level: Level = {
    id,
    key,
    role: pivot.role,
    price: pivot.price,
    generation,
    firstPivotId: first.id,
    secondPivotId: pivot.id,
    alternativeFirstPivotIds: eligiblePartners.slice(1).map((p) => p.id),
    firstPivotIndex: first.index,
    secondPivotIndex: pivot.index,
    activationH4Index: n,
    activatedT: closeT,
    d1Agreement: agreement !== null,
    d1AgreementPivotT: agreement?.barT ?? null,
    status: 'ACTIVE',
    statusT: null,
    barsSinceActivation: 0,
    firstReturnEventId: null,
    laterBreakT: null,
  };
  for (const used of [first, pivot]) {
    used.usedByLevelId = id;
    for (let i = state.pivotLog.length - 1; i >= 0; i--) {
      if (state.pivotLog[i].id === used.id) {
        state.pivotLog[i].usedByLevelId = id;
        break;
      }
    }
  }
  state.levels[id] = level;
  state.activeLevelIds.push(id);
  state.keys[key] = {
    key,
    role: pivot.role,
    price: pivot.price,
    phase: 'ACTIVE',
    generation,
    levelId: id,
    breakH4Index: null,
    breakT: null,
    retiredT: null,
  };
  d.levelsActivated[pivot.role] += 1;
  if (level.d1Agreement) d.d1AgreementTagged += 1;
  result.activated.push(id);
}

/** Processes one completed D1 bar: strict 2/2 D1 pivots for the descriptive agreement tag only. */
export function onD1Close(state: LevelEngineState, bar: Bar): void {
  if (state.lastD1T !== null && bar.t <= state.lastD1T) throw new Error('D1 bars must be strictly increasing');
  const n = state.nextD1Index++;
  state.d1Window.push({ ...bar, index: n });
  if (state.d1Window.length > D1_WINDOW_KEEP) state.d1Window.splice(0, state.d1Window.length - D1_WINDOW_KEEP);
  state.lastD1T = bar.t;
  state.diagnostics.d1BarsProcessed += 1;

  const { leftBars, rightBars } = SPEC.d1Agreement;
  const span = leftBars + rightBars + 1;
  const w = state.d1Window;
  if (w.length >= span && w[w.length - span].index === n - span + 1) {
    const window = w.slice(w.length - span);
    const pivotBar = window[leftBars];
    for (const role of strictPivotRoles(window, leftBars, rightBars)) {
      state.d1Pivots.push({
        role,
        price: role === 'RESISTANCE' ? pivotBar.h : pivotBar.l,
        index: pivotBar.index,
        barT: pivotBar.t,
        confirmT: bar.t + bar.dur,
      });
    }
  }
  const minIndex = n - SPEC.d1Agreement.lookbackCompletedD1Bars;
  state.d1Pivots = state.d1Pivots.filter((p) => p.index > minIndex);
}

function findD1Agreement(state: LevelEngineState, role: Role, price: number, activationT: number): D1Pivot | null {
  const latestCompleted = state.nextD1Index - 1;
  const minIndex = latestCompleted - SPEC.d1Agreement.lookbackCompletedD1Bars + 1;
  return (
    state.d1Pivots.find((p) => p.role === role && p.price === price && p.index >= minIndex && p.confirmT <= activationT) ?? null
  );
}

/** Spec §5: a first return (of any kind) consumes the level and retires its key until a later break. */
export function consumeLevel(state: LevelEngineState, levelId: string, atT: number, eventId: string): void {
  const lvl = state.levels[levelId];
  if (lvl.status !== 'ACTIVE') throw new Error(`cannot consume non-active level ${levelId}`);
  lvl.status = 'CONSUMED';
  lvl.statusT = atT;
  lvl.firstReturnEventId = eventId;
  const ks = state.keys[lvl.key];
  ks.phase = 'RETIRED_UNTIL_BREAK';
  ks.retiredT = atT;
  state.activeLevelIds = state.activeLevelIds.filter((id) => id !== levelId);
}
