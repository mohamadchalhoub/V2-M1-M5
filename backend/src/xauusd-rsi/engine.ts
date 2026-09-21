/**
 * The live observation engine: ordered market observations in, consumed
 * signals out. Still pure — no database, no HTTP, no clock of its own —
 * so every ordering, duplicate, gap, warm-up and rollover case is testable
 * directly.
 *
 * ## Why closed bars and ticks enter through different doors
 *
 * The RSI's recursive Wilder state is advanced ONLY by completed M1 bars
 * (`applyClosedBar`), which come from the broker's own candle data. Ticks
 * (`applyTick`) never advance it; they only set the forming bar's current
 * price, from which `projectRsi` derives the intrabar value. This is spec
 * §8.1's requirement that a tick must not be treated as its own RSI period,
 * and it has a useful property: replaying the same tick twice, or receiving
 * ten ticks in a second instead of one, cannot change the indicator.
 *
 * ## Price basis
 *
 * RSI is computed on **bid**, because that is what an MT5 gold chart plots
 * by default and therefore what the screenshots' RSI(5) was computed from.
 * Execution pricing is a separate concern and correctly uses ask for buys
 * and bid for sells — see the coordinator. Mixing the two would shift every
 * threshold by the spread.
 *
 * ## Observation mode
 *
 * `TICK` means genuine ordered broker ticks. `SAMPLED_INTRABAR` means the
 * engine is being fed periodic quote samples rather than every tick, which
 * spec §7 requires be labelled as such and disclosed, because a crossing
 * that occurs and reverses entirely between two samples is invisible. The
 * engine never treats "no crossing observed" as proof no crossing happened.
 */
import { SPEC, SPEC_HASH } from './spec';
import { RSI_FUTURE_OBSERVATION_TOLERANCE_MS } from './safety-constants';
import { commitClosedBar, createRsiState, currentRsi, isWarmedUp, projectRsi, WilderRsiState } from './rsi';
import { createPatternState, Direction, observe, observeClosedBar, PatternState, RuleFamily, SetupKind, splitByRuleFamily, TriggeredSetup } from './pattern';

export const M1_MS = 60_000;

export type ObservationMode = 'TICK' | 'SAMPLED_INTRABAR' | 'CLOSED_BAR_ONLY';

export interface EngineState {
  specHash: string;
  rsi: WilderRsiState;
  pattern: PatternState;
  /** Start-of-minute timestamp of the most recently committed closed bar. */
  lastClosedBarT: number | null;
  /** Start-of-minute timestamp of the bar currently forming. */
  formingMinuteT: number | null;
  /** Latest bid observed within the forming bar. */
  formingPrice: number | null;
  /** Timestamp of the last accepted observation of any kind. */
  lastObservationT: number | null;
  /**
   * Identity of the last accepted tick, so the same tick can never be
   * processed twice across a restart or an overlapping fetch window.
   */
  lastAcceptedTickKey: string | null;
  observationMode: ObservationMode;
  /**
   * True only when the indicator was genuinely discarded and must be rebuilt
   * from broker history before signals may resume.
   *
   * Deliberately NOT set by an ordinary data gap: the indicator carries
   * across session breaks exactly as MetaTrader's does (see `applyClosedBar`).
   * A gap resets pattern state only.
   */
  needsRsiReseed: boolean;
  /** Diagnostics. */
  closedBarsApplied: number;
  ticksApplied: number;
  ticksRejectedDuplicate: number;
  ticksRejectedOutOfOrder: number;
  gapResets: number;
}

export function createEngineState(mode: ObservationMode = 'TICK'): EngineState {
  return {
    specHash: SPEC_HASH,
    rsi: createRsiState(),
    pattern: createPatternState(SPEC_HASH),
    lastClosedBarT: null,
    formingMinuteT: null,
    formingPrice: null,
    lastObservationT: null,
    lastAcceptedTickKey: null,
    observationMode: mode,
    needsRsiReseed: false,
    closedBarsApplied: 0,
    ticksApplied: 0,
    ticksRejectedDuplicate: 0,
    ticksRejectedOutOfOrder: 0,
    gapResets: 0,
  };
}

export function minuteBucket(t: number): number {
  return Math.floor(t / M1_MS) * M1_MS;
}

export interface EmittedSignal {
  /**
   * Which execution slot this signal competes for. One observation can emit
   * one signal per family, and each is reserved and risk-checked separately.
   */
  family: RuleFamily;
  direction: Direction;
  kinds: SetupKind[];
  reason: string;
  /** The RSI value at the observation that produced the signal. */
  rsi: number;
  /** Observation timestamp (UTC ms) — the signal's own age is measured from here. */
  atT: number;
  /** The detection-basis bid at that observation. */
  basisPrice: number;
  /** Everything needed to reconstruct the decision later without guesswork. */
  evidence: SignalEvidence;
}

export interface SignalEvidence {
  specHash: string;
  strategyVersion: string;
  observationMode: ObservationMode;
  previousRsi: number | null;
  currentRsi: number;
  formingMinuteT: number | null;
  lastClosedBarT: number | null;
  closedBarsApplied: number;
  triggered: TriggeredSetup[];
  thresholds: typeof SPEC.thresholds;
}

export interface StepResult {
  state: EngineState;
  signals: EmittedSignal[];
  notes: string[];
  /** True when this step discarded pattern state because continuity was lost. */
  didReset: boolean;
}

/**
 * Folds one COMPLETED M1 bar into the RSI state.
 *
 * `barStartT` must be a minute boundary. Bars must arrive in ascending
 * order and contiguously: a missing minute means the engine did not observe
 * that interval, so pattern state is reset rather than carried across it
 * (spec §8.6). The RSI state itself survives a short gap only if the caller
 * supplies the missing bars; otherwise `needsRsiReseed` is raised and the
 * caller must rebuild from history before signals resume.
 */
export function applyClosedBar(
  state: EngineState,
  barStartT: number,
  close: number,
  /**
   * Whether this bar may advance the retest patterns.
   *
   * FALSE while seeding the indicator from history. Warm-up exists to make
   * RSI computable and nothing else: a trough frozen from historical bars
   * could be retested by the first live tick and open an order from history,
   * which spec §7 forbids. Live bars pass true.
   */
  advancePattern = true,
): StepResult {
  const notes: string[] = [];
  const bucket = minuteBucket(barStartT);

  if (state.lastClosedBarT !== null && bucket <= state.lastClosedBarT) {
    return {
      state: { ...state, ticksRejectedOutOfOrder: state.ticksRejectedOutOfOrder },
      signals: [],
      notes: [`closed bar ${new Date(bucket).toISOString()} is not newer than the last applied bar — ignored (duplicate or out of order)`],
      didReset: false,
    };
  }

  let next = state;
  let didReset = false;

  if (state.lastClosedBarT !== null && bucket > state.lastClosedBarT + M1_MS) {
    const missing = (bucket - state.lastClosedBarT) / M1_MS - 1;
    notes.push(
      `gap of ${missing} missing M1 bar(s) before ${new Date(bucket).toISOString()} — pattern state reset; a pattern is never inferred through an unobserved interval`,
    );
    // PATTERN state is discarded; the INDICATOR is not.
    //
    // This distinction is what makes the engine MT5-faithful across session
    // breaks. MetaTrader does not restart RSI after a weekend: the M1 series
    // simply has no bars while the market is shut, and the first bar of the
    // new week is smoothed against the last bars of the previous one. An
    // engine that reset the recursive average here would disagree with the
    // terminal on every Monday morning, and would additionally blind itself
    // for a further 256 bars of warm-up after every weekend.
    //
    // Pattern state is different, and must go: a peak whose pullback happened
    // while nobody was watching is not a peak this engine may trade.
    next = {
      ...next,
      pattern: createPatternState(next.specHash),
      gapResets: next.gapResets + 1,
    };
    didReset = true;
  }

  const rsi = commitClosedBar(next.rsi, close);
  next = {
    ...next,
    rsi,
    lastClosedBarT: bucket,
    closedBarsApplied: next.closedBarsApplied + 1,
    // The LAST instant belonging to this bar, not the first instant of the
    // next one. Using the next minute's start would reject a legitimate
    // observation timed at the very end of this bar as out-of-order, which
    // silently discarded every observation in the historical replay path.
    lastObservationT: Math.max(next.lastObservationT ?? bucket, bucket + M1_MS - 1),
    // The forming bar is whatever comes after this one.
    formingMinuteT: null,
    formingPrice: null,
    needsRsiReseed: next.needsRsiReseed,
  };

  // The retest patterns progress here, on the closed bar, never on a tick.
  if (advancePattern) {
    const committedRsi = currentRsi(next.rsi);
    if (committedRsi !== null) {
      const stepped = observeClosedBar({ state: next.pattern, closeRsi: committedRsi });
      next = { ...next, pattern: stepped.state };
      if (stepped.notes.length > 0) notes.push(...stepped.notes.slice(0, 3));
    }
  }

  // Still no signals: a closed bar can confirm a level but never open a trade.
  return { state: next, signals: [], notes, didReset };
}

export interface TickInput {
  /** Observation timestamp, UTC ms. */
  atT: number;
  /** Detection-basis price — the bid. */
  bid: number;
  /** Stable identity of this observation, for duplicate rejection. */
  tickKey: string;
  /** Wall-clock now, for the freshness test. Separate from `atT` on purpose. */
  nowT: number;
}

/**
 * Folds one intrabar observation into the engine.
 *
 * Rejects duplicates and out-of-order observations outright. Resets pattern
 * state when continuity is lost. Suppresses (but still consumes) signals
 * during warm-up, while an RSI reseed is outstanding, or when the
 * observation is not fresh — exactly the behaviour spec §9.5 requires of a
 * blocked signal: logged and consumed, never queued for later.
 */
export function applyTick(state: EngineState, input: TickInput): StepResult {
  const { atT, bid, tickKey, nowT } = input;
  const notes: string[] = [];

  if (!Number.isFinite(bid) || bid <= 0) {
    return { state, signals: [], notes: [`rejected tick with non-positive/non-finite bid ${bid}`], didReset: false };
  }
  if (state.lastAcceptedTickKey !== null && tickKey === state.lastAcceptedTickKey) {
    return {
      state: { ...state, ticksRejectedDuplicate: state.ticksRejectedDuplicate + 1 },
      signals: [],
      notes: [`duplicate observation ${tickKey} — already processed, ignored`],
      didReset: false,
    };
  }
  if (state.lastObservationT !== null && atT < state.lastObservationT) {
    return {
      state: { ...state, ticksRejectedOutOfOrder: state.ticksRejectedOutOfOrder + 1 },
      signals: [],
      notes: [`out-of-order observation at ${new Date(atT).toISOString()} precedes ${new Date(state.lastObservationT).toISOString()} — ignored`],
      didReset: false,
    };
  }

  let next = state;
  let didReset = false;

  // Continuity: a long silence means the engine cannot vouch for what RSI
  // did in between, so the pattern is abandoned rather than bridged.
  if (state.lastObservationT !== null && atT - state.lastObservationT > SPEC.observation.maxContinuityGapMs) {
    const gapSec = ((atT - state.lastObservationT) / 1000).toFixed(1);
    notes.push(`observation gap of ${gapSec}s exceeds the ${SPEC.observation.maxContinuityGapMs / 1000}s continuity limit — pattern state reset`);
    next = { ...next, pattern: createPatternState(next.specHash), gapResets: next.gapResets + 1 };
    didReset = true;
  }

  const bucket = minuteBucket(atT);

  // Minute rollover: the previous forming bar is now complete. Its last
  // observed bid is its close. This is the ONE place tick data is allowed
  // to advance the recursive state, and only because the minute genuinely
  // ended; broker candle data, when it arrives, supersedes it via
  // `applyClosedBar`.
  const completedMinuteT = next.formingMinuteT;
  const completedClose = next.formingPrice;
  if (completedMinuteT !== null && completedClose !== null && bucket > completedMinuteT) {
    const alreadyApplied = next.lastClosedBarT !== null && completedMinuteT <= next.lastClosedBarT;
    if (!alreadyApplied) {
      if (next.lastClosedBarT !== null && completedMinuteT > next.lastClosedBarT + M1_MS) {
        const skipped = (completedMinuteT - next.lastClosedBarT) / M1_MS - 1;
        // Same rule as `applyClosedBar`: the pattern goes, the indicator stays.
        notes.push(`minute rollover skipped ${skipped} bar(s) — pattern state reset (the indicator continues, as MT5 does across a session break)`);
        next = { ...next, pattern: createPatternState(next.specHash), gapResets: next.gapResets + 1 };
        didReset = true;
      }
      next = {
        ...next,
        rsi: commitClosedBar(next.rsi, completedClose),
        lastClosedBarT: completedMinuteT,
        closedBarsApplied: next.closedBarsApplied + 1,
      };
    }
  }

  next = { ...next, formingMinuteT: bucket, formingPrice: bid };

  const rsiValue = projectRsi(next.rsi, bid);
  next = {
    ...next,
    lastObservationT: atT,
    lastAcceptedTickKey: tickKey,
    ticksApplied: next.ticksApplied + 1,
  };

  if (rsiValue === null) {
    return { state: next, signals: [], notes: [...notes, 'RSI not yet available (seeding)'], didReset };
  }

  // Freshness is bounded on BOTH sides.
  //
  // `age <= limit` alone accepts every negative age, so an observation dated
  // in the future passes unconditionally however wrong it is. That was not
  // hypothetical: while stored tick timestamps carried the broker's
  // wall clock, every observation was three hours ahead and this test could
  // never reject anything. The correction removed the cause; this bound
  // removes the blind spot, so a future-dated observation is reported and
  // suppressed rather than silently trusted.
  //
  // The tolerance absorbs ordinary clock skew between this machine and the
  // broker. Beyond it, a negative age means a conversion is wrong, not that
  // the quote is unusually fresh.
  const ageMs = nowT - atT;
  const stale = ageMs > SPEC.observation.maxStalenessMs;
  const futureDated = ageMs < -RSI_FUTURE_OBSERVATION_TOLERANCE_MS;
  const fresh = !stale && !futureDated;
  const warm = isWarmedUp(next.rsi);
  const canEmit = fresh && warm && !next.needsRsiReseed && !didReset;

  if (stale) notes.push(`observation is ${(ageMs / 1000).toFixed(1)}s old (limit ${SPEC.observation.maxStalenessMs / 1000}s) — signals suppressed`);
  if (futureDated)
    notes.push(
      `observation is dated ${(-ageMs / 1000).toFixed(1)}s in the FUTURE (tolerance ${RSI_FUTURE_OBSERVATION_TOLERANCE_MS / 1000}s) — ` +
        'the timestamp conversion or a clock is wrong; signals suppressed rather than treated as very fresh',
    );
  if (!warm) notes.push(`warm-up incomplete (${next.rsi.closedBarCount} closed bars applied, need ${next.rsi.period + 1 + SPEC.rsi.warmupBars}) — signals suppressed`);
  if (next.needsRsiReseed) notes.push('RSI reseed outstanding after a data gap — signals suppressed until the indicator is rebuilt from history');

  // Captured BEFORE `observe` advances the pattern, so the evidence records
  // the genuine `previous` half of the crossing test that just fired.
  const previousRsiForEvidence = next.pattern.previousRsi;

  const observed = observe({ state: next.pattern, rsi: rsiValue, atT, canEmit });
  next = { ...next, pattern: observed.state };
  notes.push(...observed.notes);

  // One signal PER FAMILY, not one merged signal. A retest and an extreme
  // firing on the same observation are two separate trades against two
  // separate slots, so they must stay separately identified all the way
  // through the execution layer.
  const signals: EmittedSignal[] = splitByRuleFamily(observed.triggered).map((decision) => ({
    family: decision.family,
    direction: decision.direction,
    kinds: decision.kinds,
    reason: decision.reason,
    rsi: rsiValue,
    atT,
    basisPrice: bid,
    evidence: {
      specHash: next.specHash,
      strategyVersion: SPEC.strategyVersion,
      observationMode: next.observationMode,
      previousRsi: previousRsiForEvidence,
      currentRsi: rsiValue,
      formingMinuteT: next.formingMinuteT,
      lastClosedBarT: next.lastClosedBarT,
      closedBarsApplied: next.closedBarsApplied,
      // Only this family's own triggers, so a decision's evidence never
      // contains the reasons belonging to the other family's trade.
      triggered: observed.triggered.filter((t) => decision.kinds.includes(t.kind)),
      thresholds: SPEC.thresholds,
    },
  }));

  return { state: next, signals, notes, didReset };
}

/** Current intrabar RSI, for the dashboard. Null while seeding. */
export function engineRsiNow(state: EngineState): number | null {
  if (state.formingPrice === null) return currentRsi(state.rsi);
  return projectRsi(state.rsi, state.formingPrice);
}

export function engineWarmedUp(state: EngineState): boolean {
  return isWarmedUp(state.rsi) && !state.needsRsiReseed;
}
