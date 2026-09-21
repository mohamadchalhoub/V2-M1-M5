/**
 * research/confirmed-retest-v2/types — plain data shapes for
 * `xauusd-h4-confirmed-retest-v2` (a GPT-authorized research revision of
 * v1's formation rule; v1 itself is untouched — see its own directory).
 * Everything here is JSON-serializable
 * (numbers, strings, arrays, plain objects) so replay state can be persisted
 * and resumed byte-for-byte. Prices are integer broker units (XAUUSD 1 = $0.01);
 * times are epoch milliseconds, true UTC unless the field name says `server`.
 */

export type Units = number;
export type Role = 'SUPPORT' | 'RESISTANCE';
export type Direction = 'BUY' | 'SELL';
export type Timeframe = 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1';

export interface Bar {
  /** True UTC open, epoch ms. */
  t: number;
  /** Nominal duration, ms. */
  dur: number;
  o: Units;
  h: Units;
  l: Units;
  c: Units;
}

export type GapKind = 'CONFIRMED_CLOSURE' | 'UNCONFIRMED_BRIDGED' | 'UNCONFIRMED_UNBRIDGED';

export interface GapInfo {
  id: string;
  /** Missing interval [startT, endT), UTC ms. */
  startT: number;
  endT: number;
  kind: GapKind;
  /** Only for UNCONFIRMED_BRIDGED: union range of the covering M5 bars. */
  bridgeLow: Units | null;
  bridgeHigh: Units | null;
  evidence: string;
}

export type EvalResolution = 'M1' | 'M5_SUBSTITUTE' | 'H4_WARMUP';

/** One bar of the chronological evaluation stream (touch detection + outcome races). */
export interface EvalBar extends Bar {
  res: EvalResolution;
  /** The gap between the previous evaluation bar's close and this bar's open, if any. */
  gapBefore: GapInfo | null;
}

// ---------------------------------------------------------------------------
// Levels.
// ---------------------------------------------------------------------------

export interface PivotRecord {
  id: string;
  role: Role;
  /** L — the original pivot extreme. Frozen; never changes once recorded. */
  price: Units;
  /** Global H4 index of the pivot bar. */
  index: number;
  barT: number;
  confirmT: number;
  /** v2 §2: at least one of the two confirming bars closed ≥$10 away favorably. */
  qualified: boolean;
  usedByLevelId: string | null;
}

export type LevelStatus = 'ACTIVE' | 'CONSUMED' | 'BROKEN' | 'EXPIRED';

/** v2 §3: the retest candle R — need not equal L. */
export interface RetestRecord {
  id: string;
  index: number;
  barT: number;
  confirmT: number;
}

export interface Level {
  id: string;
  key: string;
  role: Role;
  /** L, frozen at pivot detection — never mutated by the retest. */
  price: Units;
  generation: number;
  pivotId: string;
  pivotIndex: number;
  pivotT: number;
  retestId: string;
  retestIndex: number;
  retestT: number;
  /** H4 index of the close that satisfied v2 §5's $10 rejection (R, R+1 or R+2). */
  confirmationH4Index: number;
  confirmationT: number;
  activationH4Index: number;
  activatedT: number;
  d1Agreement: boolean;
  d1AgreementPivotT: number | null;
  status: LevelStatus;
  statusT: number | null;
  /** H4 bars completed since activation (expiry at 120). */
  barsSinceActivation: number;
  firstReturnEventId: string | null;
  /** First H4 close strictly beyond the level after it left ACTIVE (informational; enables a new generation). */
  laterBreakT: number | null;
}

export type KeyPhase = 'ACTIVE' | 'RETIRED_UNTIL_BREAK' | 'BROKEN';

export interface KeyState {
  key: string;
  role: Role;
  price: Units;
  phase: KeyPhase;
  generation: number;
  levelId: string;
  /** H4 index of the break that re-opened this key (phase BROKEN), else null. */
  breakH4Index: number | null;
  breakT: number | null;
}

// ---------------------------------------------------------------------------
// Events and outcomes.
// ---------------------------------------------------------------------------

export type TouchKind = 'ORDINARY' | 'GAP_CROSS' | 'UNOBSERVABLE';
export type EventPeriod = 'PRE_STUDY' | 'STUDY';
export type IneligibleReason = 'PRE_STUDY' | 'OUTSIDE_WINDOW' | 'GAP_CROSS' | 'UNOBSERVABLE';

export type FinalResult = 'WIN' | 'LOSS' | 'INDETERMINATE' | 'UNRESOLVED';
export type OutcomeStatus = 'WIN' | 'LOSS' | 'AMBIGUOUS' | 'INDETERMINATE' | 'UNRESOLVED';

/** One way the idealized trade can end, consistent with the data. */
export interface OutcomeAlternative {
  result: FinalResult;
  /** Open time of the bar in which the exit happens (null for INDETERMINATE/UNRESOLVED). */
  exitBarT: number | null;
  exitBarDur: number | null;
  exitType: 'INTRABAR' | 'GAP_OPEN' | null;
  /** Nominal TP/SL for INTRABAR; the observed open for GAP_OPEN. */
  exitPrice: Units | null;
  /** INDETERMINATE: the gap responsible (branch halts at its start). */
  gapId: string | null;
  haltT: number | null;
  path: string;
}

export interface RaceState {
  eventId: string;
  direction: Direction;
  entry: Units;
  tp: Units;
  sl: Units;
  /** Worst adverse excursion seen so far (units, ≥ 0). */
  mae: Units;
  lastBarT: number;
}

export interface Outcome {
  status: OutcomeStatus;
  entry: Units;
  tp: Units;
  sl: Units;
  entryCandleReachable: Array<'WIN' | 'LOSS' | 'NONE'>;
  alternatives: OutcomeAlternative[];
  /** Present while the NONE continuation is still racing. */
  pendingRace: RaceState | null;
  maeUnits: Units;
  note: string;
}

export interface SelectionInfo {
  knownPrice: Units | null;
  selectedResistanceId: string | null;
  selectedSupportId: string | null;
  isSelected: boolean;
  /** Both selected sides returned in this bar. */
  bothSelectedSidesTouched: boolean;
  /** When both touched: true if exactly one side was reached at the bar's open. */
  orderKnown: boolean | null;
  firstSideLevelId: string | null;
}

export interface BeirutStamp {
  date: string;
  year: number;
  half: string;
  hour: number;
  minute: number;
}

export interface FirstReturnEvent {
  id: string;
  levelId: string;
  role: Role;
  levelPrice: Units;
  generation: number;
  kind: TouchKind;
  period: EventPeriod;
  /** Interval containing the touch: the evaluation bar (or, for UNOBSERVABLE, gap start → bar close). */
  touchStartT: number;
  touchEndT: number;
  touchResolution: EvalResolution;
  beirut: BeirutStamp;
  inWindow: boolean | null;
  direction: Direction;
  eligible: boolean;
  ineligibleReason: IneligibleReason | null;
  gapId: string | null;
  selection: SelectionInfo | null;
  d1Agreement: boolean;
  levelActivatedT: number;
  outcome: Outcome | null;
  /** Wall-clock when first recorded by the watch-only runner (null for historical replay). */
  observedAtT: number | null;
}

export interface FormationCounters {
  h4BarsProcessed: number;
  pivotCandidates: { SUPPORT: number; RESISTANCE: number };
  qualifiedPivots: { SUPPORT: number; RESISTANCE: number };
  rejectedNoRejectionClose: { SUPPORT: number; RESISTANCE: number };
  exactPriceRepeatPairsAnyDistance: { SUPPORT: number; RESISTANCE: number };
  pairRejections: Record<string, number>;
  levelsActivated: { SUPPORT: number; RESISTANCE: number };
  d1AgreementTagged: number;
}
