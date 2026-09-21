/**
 * research/confirmed-retest-v2/levels — H4 pivot detection, RETEST
 * formation and the level lifecycle (v2 spec §formation). Pure and
 * incremental: `onH4Close` / `onD1Close` mutate a JSON-serializable state
 * object and are only ever handed COMPLETED bars in chronological order, so
 * a level can never be established from a bar that closes after its
 * activation, and formation NEVER looks at future bars — each watch entry
 * only ever reacts to the bar it is currently being handed.
 *
 * v2's change from v1 (v1's own `levels.ts` is untouched, in its own
 * directory): instead of pairing two same-price pivots, a single pivot L is
 * watched for a RETEST — the earliest H4 bar R, 5..120 indices later, whose
 * OHLC touches back to L without a body violation since the pivot — and
 * then confirmed by a $10 favorable close at R or one of the next two H4
 * candles. L itself never moves; only R needs to reach it.
 */
import { SPEC } from './spec';
import type { Bar, KeyState, Level, PivotRecord, RetestRecord, Role } from './types';

const H4_WINDOW_KEEP = SPEC.pivots.leftBars + SPEC.pivots.rightBars + 8;
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
  /** Body filter violated before any retest was found for this pivot (retired, never counted in retestFound). */
  bodyViolationBeforeRetest: Record<Role, number>;
  /** Body filter violated after a retest was found, during its R+1/R+2 confirmation window (already counted in retestFound). */
  bodyViolationDuringConfirmation: Record<Role, number>;
  /** 120-bar retest window elapsed with no bar satisfying the retest OHLC condition. */
  noRetestWithinWindow: Record<Role, number>;
  /** A qualifying retest bar R was found (may or may not go on to confirm). */
  retestFound: Record<Role, number>;
  /** R found, but neither R nor its next two completed H4 candles closed $10 favorably — retired, no further search. */
  confirmationFailedAfterRetest: Record<Role, number>;
  levelsActivated: Record<Role, number>;
  activationsBlocked: Record<string, number>;
  d1AgreementTagged: number;
}

/** One pivot being watched for its retest/confirmation. Not exported — internal engine bookkeeping only, but plain/JSON-serializable so persisted state round-trips. */
export interface WatchEntry {
  pivot: PivotRecord;
  retestIndex: number | null;
  retestT: number | null;
  retestId: string | null;
  /** retestIndex + 2 once a retest is found — the last H4 index still eligible to confirm. */
  confirmDeadlineIndex: number | null;
  done: boolean;
}

export interface LevelEngineState {
  nextH4Index: number;
  lastH4T: number | null;
  h4Window: IndexedBar[];
  nextD1Index: number;
  lastD1T: number | null;
  d1Window: IndexedBar[];
  d1Pivots: D1Pivot[];
  watchList: WatchEntry[];
  /** Every pivot candidate ever confirmed (output only). */
  pivotLog: PivotRecord[];
  /** Every retest bar ever accepted (output only). */
  retestLog: RetestRecord[];
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
    watchList: [],
    pivotLog: [],
    retestLog: [],
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
      bodyViolationBeforeRetest: zeroRoles(),
      bodyViolationDuringConfirmation: zeroRoles(),
      noRetestWithinWindow: zeroRoles(),
      retestFound: zeroRoles(),
      confirmationFailedAfterRetest: zeroRoles(),
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

/** Strict 2-left/2-right pivot test on a window whose middle element is the candidate. Identical to v1's. */
export function strictPivotRoles(window: Bar[], leftBars: number, rightBars: number): Role[] {
  const mid = window[leftBars];
  const others = window.filter((_, i) => i !== leftBars);
  const roles: Role[] = [];
  if (others.every((b) => mid.h > b.h)) roles.push('RESISTANCE');
  if (others.every((b) => mid.l < b.l)) roles.push('SUPPORT');
  if (window.length !== leftBars + rightBars + 1) throw new Error('pivot window has wrong length');
  return roles;
}

export interface H4CloseResult {
  activated: string[];
  broken: string[];
  expired: string[];
  retiredKeysBroken: string[];
}

/**
 * Processes one completed H4 bar (v2 §formation, §lifecycle). Order at this
 * close: (1) break of retired keys retired strictly before this close,
 * (2) break then expiry of ACTIVE levels activated before this bar,
 * (3) advance every in-progress watch entry against THIS bar (retest search
 * / confirmation window — never looks ahead), (4) pivot confirmation for
 * bar index n-2 and, if qualified, start watching it.
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

  // (3) Advance every in-progress watch entry against this bar — earliest-pivot-first, so a
  // same-price/same-role dedup tie always resolves to the chronologically earliest candidate.
  const ordered = [...state.watchList].sort((a, b) => a.pivot.index - b.pivot.index || a.pivot.id.localeCompare(b.pivot.id));
  for (const entry of ordered) {
    if (entry.done || entry.pivot.index >= n) continue;
    processWatchEntry(state, entry, n, indexed, closeT, result);
  }
  state.watchList = state.watchList.filter((e) => !e.done);

  // (4) Pivot confirmation.
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
      const d = state.diagnostics;
      d.pivotCandidates[role] += 1;
      if (qualified) d.qualifiedPivots[role] += 1;
      else d.rejectedNoRejectionClose[role] += 1;
      state.pivotLog.push({ ...pivot });
      if (qualified) {
        state.watchList.push({ pivot, retestIndex: null, retestT: null, retestId: null, confirmDeadlineIndex: null, done: false });
      }
    }
  }

  return result;
}

/** Advances one watch entry against the current H4 bar. Never inspects any bar after `n`. */
function processWatchEntry(state: LevelEngineState, entry: WatchEntry, n: number, bar: IndexedBar, closeT: number, result: H4CloseResult): void {
  const d = state.diagnostics;
  const pivot = entry.pivot;
  const role = pivot.role;
  const L = pivot.price;

  const bodyOk = role === 'RESISTANCE' ? Math.max(bar.o, bar.c) <= L : Math.min(bar.o, bar.c) >= L;
  if (!bodyOk) {
    entry.done = true;
    // Two mutually exclusive sub-cases, so the funnel in the report sums correctly: a violation
    // strictly before any retest was found vs. one during the R+1/R+2 confirmation window (where
    // the entry had already been counted once under retestFound).
    bump(entry.retestIndex === null ? d.bodyViolationBeforeRetest : d.bodyViolationDuringConfirmation, role);
    return;
  }

  if (entry.retestIndex === null) {
    const dist = n - pivot.index;
    if (dist > SPEC.formation.maxRetestIndexDistance) {
      entry.done = true;
      bump(d.noRetestWithinWindow, role);
      return;
    }
    if (dist < SPEC.formation.minRetestIndexDistance) return; // too early — keep watching, no violation yet
    const retestOk = role === 'RESISTANCE' ? bar.h >= L && bar.o <= L && bar.c <= L : bar.l <= L && bar.o >= L && bar.c >= L;
    if (!retestOk) return; // not this bar — keep watching within the window
    entry.retestIndex = n;
    entry.retestT = closeT;
    entry.retestId = `rt:${role}:${pivot.index}:${n}`;
    entry.confirmDeadlineIndex = n + 2;
    state.retestLog.push({ id: entry.retestId, index: n, barT: bar.t, confirmT: closeT });
    bump(d.retestFound, role);
    // Fall through: R itself is also eligible to be the confirming close.
  }

  const qualifiesNow = role === 'RESISTANCE' ? bar.c <= L - SPEC.formation.rejectionMinCloseDistanceUnits : bar.c >= L + SPEC.formation.rejectionMinCloseDistanceUnits;
  if (qualifiesNow) {
    activateLevel(state, entry, n, closeT, result);
    entry.done = true;
    return;
  }
  if (n === entry.confirmDeadlineIndex) {
    entry.done = true;
    bump(d.confirmationFailedAfterRetest, role);
  }
}

function activateLevel(state: LevelEngineState, entry: WatchEntry, n: number, closeT: number, result: H4CloseResult): void {
  const pivot = entry.pivot;
  const role = pivot.role;
  const L = pivot.price;
  const key = levelKey(role, L);
  const d = state.diagnostics;

  const ks = state.keys[key];
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
    if (pivot.index <= breakIndex) {
      bump(d.activationsBlocked, 'PIVOT_NOT_NEW_AFTER_BREAK');
      return;
    }
  }

  const generation = (ks?.generation ?? 0) + 1;
  const id = `lvl:${role === 'RESISTANCE' ? 'R' : 'S'}:${L}:g${generation}:${++state.levelSeq}`;
  const agreement = findD1Agreement(state, role, L, closeT);
  const level: Level = {
    id,
    key,
    role,
    price: L,
    generation,
    pivotId: pivot.id,
    pivotIndex: pivot.index,
    pivotT: pivot.barT,
    retestId: entry.retestId as string,
    retestIndex: entry.retestIndex as number,
    retestT: entry.retestT as number,
    confirmationH4Index: n,
    confirmationT: closeT,
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
  pivot.usedByLevelId = id;
  for (let i = state.pivotLog.length - 1; i >= 0; i--) {
    if (state.pivotLog[i].id === pivot.id) {
      state.pivotLog[i].usedByLevelId = id;
      break;
    }
  }
  state.levels[id] = level;
  state.activeLevelIds.push(id);
  state.keys[key] = { key, role, price: L, phase: 'ACTIVE', generation, levelId: id, breakH4Index: null, breakT: null, retiredT: null };
  d.levelsActivated[role] += 1;
  if (level.d1Agreement) d.d1AgreementTagged += 1;
  result.activated.push(id);
}

/** Processes one completed D1 bar: strict 2/2 D1 pivots for the descriptive agreement tag only. Identical to v1's. */
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
  return state.d1Pivots.find((p) => p.role === role && p.price === price && p.index >= minIndex && p.confirmT <= activationT) ?? null;
}

/** Spec §lifecycle: a first return (of any kind) consumes the level and retires its key until a later break. Identical to v1's. */
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
