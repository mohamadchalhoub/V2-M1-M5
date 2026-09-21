/**
 * The four entry setups of `xauusd-m1-rsi-retest-extremes-v1`, as a pure,
 * deterministic state machine.
 *
 * Pure on purpose: no clock, no database, no price feed, no scheduling. It
 * is handed one RSI observation at a time, in order, and returns whatever
 * setups fired. Everything about WHETHER a fired signal may become an order
 * — schedule, occupancy, risk, DEMO identity — belongs to the execution
 * layer and is deliberately not visible here, so the rules can be tested
 * exhaustively without a broker, a database or a fake clock.
 *
 * Signals that the execution layer then refuses are still **consumed** here
 * under the normal rearming rules (spec §9.5): a blocked signal is never
 * replayed later. That is why `observe()` advances state identically
 * regardless of what downstream does with its output.
 */
import { SPEC } from './spec';

export type SetupKind = 'SELL_PEAK_RETEST' | 'BUY_TROUGH_RETEST' | 'EXTREME_SELL' | 'EXTREME_BUY';
export type Direction = 'BUY' | 'SELL';

/**
 * The two independent execution slots (spec `ruleFamilies`).
 *
 * The four setups group into two families, and each family holds at most one
 * active, pending or uncertain entry of its own — so a retest position and an
 * extreme position may be open simultaneously, and the strategy's maximum
 * concurrency is two.
 *
 * Note what this is NOT: it is not one slot per directional setup. SELL and
 * BUY retests share the RETEST slot, and both extremes share the EXTREME slot.
 */
export type RuleFamily = 'RETEST' | 'EXTREME';

export const RULE_FAMILIES: readonly RuleFamily[] = ['RETEST', 'EXTREME'];

export function ruleFamilyFor(kind: SetupKind): RuleFamily {
  return kind === 'SELL_PEAK_RETEST' || kind === 'BUY_TROUGH_RETEST' ? 'RETEST' : 'EXTREME';
}

export interface TriggeredSetup {
  kind: SetupKind;
  direction: Direction;
  /** Human-readable justification, carried into the decision record for audit. */
  reason: string;
  /** The RSI level the setup keyed on — the frozen peak/trough, or the extreme crossing level. */
  keyLevel: number;
}

/**
 * `AWAITING_ARM_RESET` is the start-up and post-gap state (spec §8.6, §7's
 * "avoid entering merely because the first reading is already extreme").
 * The engine refuses to claim a peak it never watched form: it must first
 * see RSI back inside the ordinary range before a fresh pattern may arm.
 */
export type RetestPhase = 'AWAITING_ARM_RESET' | 'IDLE' | 'TRACKING_EXTREME' | 'EXTREME_FROZEN' | 'AWAITING_REARM';

export interface RetestState {
  phase: RetestPhase;
  /** Running max (SELL) or min (BUY) while `TRACKING_EXTREME`. */
  runningExtreme: number | null;
  /** The frozen peak (SELL) or trough (BUY) being watched for a retest. */
  frozenExtreme: number | null;
}

export type ExtremePhase = 'AWAITING_RESET' | 'ARMED' | 'DISARMED';

export interface ExtremeState {
  phase: ExtremePhase;
}

export interface PatternState {
  specHash: string;
  sellRetest: RetestState;
  buyRetest: RetestState;
  extremeSell: ExtremeState;
  extremeBuy: ExtremeState;
  /** Previous accepted RSI observation — the `previous` half of every crossing test. */
  previousRsi: number | null;
  /** Timestamp (UTC ms) of that previous observation, for continuity checks. */
  previousAtT: number | null;
  /** Count of observations folded in since the last reset — diagnostics only. */
  observationCount: number;
}

export function createPatternState(specHash: string): PatternState {
  return {
    specHash,
    sellRetest: { phase: 'AWAITING_ARM_RESET', runningExtreme: null, frozenExtreme: null },
    buyRetest: { phase: 'AWAITING_ARM_RESET', runningExtreme: null, frozenExtreme: null },
    extremeSell: { phase: 'AWAITING_RESET' },
    extremeBuy: { phase: 'AWAITING_RESET' },
    previousRsi: null,
    previousAtT: null,
    observationCount: 0,
  };
}

/**
 * Discards everything the engine cannot still vouch for after a gap, a
 * restart or a market closure. Pattern progress is NOT carried across an
 * unobserved interval (spec §8.6) — a peak whose pullback happened while
 * nobody was watching is not a peak this engine may trade.
 */
export function resetPatternState(state: PatternState, specHash: string = state.specHash): PatternState {
  return createPatternState(specHash);
}

export interface ObserveResult {
  state: PatternState;
  triggered: TriggeredSetup[];
  /** Diagnostics for the dashboard and decision audit — never control flow. */
  notes: string[];
}

/**
 * Folds one RSI observation into the state.
 *
 * `canEmit` is the warm-up / freshness gate. When false the state still
 * advances exactly as it otherwise would (so continuity and rearming stay
 * correct) but no setup is allowed to fire. This is what makes warm-up and
 * stale data safe: they suppress signals without corrupting pattern state.
 */
/**
 * Advances the retest patterns on a CLOSED M1 bar. Never emits a signal.
 *
 * This is the half of the pattern the user reads off the chart: the trough
 * or peak, the confirming candle, and the invalidation. Ticks cannot move
 * any of it — that is what stops intrabar noise from manufacturing a
 * rebound, which is exactly how an entry was wrongly opened on 2026-09-21
 * from 0.045 of RSI movement across three ticks.
 *
 * The extremes (98.5 / 1.5) are deliberately untouched here: those are
 * crossings, detected intrabar, and the user has not asked for them to
 * change.
 */
export function observeClosedBar(params: { state: PatternState; closeRsi: number }): { state: PatternState; notes: string[] } {
  const { state, closeRsi } = params;
  const notes: string[] = [];

  if (!Number.isFinite(closeRsi)) {
    return { state, notes: [`ignored non-finite closed-bar RSI ${closeRsi}`] };
  }

  return {
    state: {
      ...state,
      sellRetest: advanceSellRetestOnClose(state.sellRetest, closeRsi, notes),
      buyRetest: advanceBuyRetestOnClose(state.buyRetest, closeRsi, notes),
    },
    notes,
  };
}

export function observe(params: {
  state: PatternState;
  rsi: number;
  atT: number;
  canEmit: boolean;
}): ObserveResult {
  const { state, rsi, atT, canEmit } = params;
  const notes: string[] = [];
  const triggered: TriggeredSetup[] = [];

  if (!Number.isFinite(rsi)) {
    return { state, triggered: [], notes: [`ignored non-finite RSI ${rsi}`] };
  }

  const prev = state.previousRsi;

  // Retest PROGRESSION happens on bar closes (see observeClosedBar); a tick
  // can only fire the entry against an already-frozen level.
  const sellRetest = checkSellRetestTrigger(state.sellRetest, prev, rsi, triggered, notes, canEmit);
  const buyRetest = checkBuyRetestTrigger(state.buyRetest, prev, rsi, triggered, notes, canEmit);
  const extremeSell = stepExtremeSell(state.extremeSell, prev, rsi, triggered, notes, canEmit);
  const extremeBuy = stepExtremeBuy(state.extremeBuy, prev, rsi, triggered, notes, canEmit);

  return {
    state: {
      ...state,
      sellRetest,
      buyRetest,
      extremeSell,
      extremeBuy,
      previousRsi: rsi,
      previousAtT: atT,
      observationCount: state.observationCount + 1,
    },
    triggered,
    notes,
  };
}

/**
 * SELL peak tracking, advanced ONLY on a closed M1 bar.
 *
 * USER RULE (revision 5): the peak, the pullback and the invalidation are all
 * read off the closed-bar RSI line — the line drawn on the chart — not off
 * individual ticks. Two consequences the user stated directly:
 *
 *   - "at least one candle should be rising" confirms the reversal. The size
 *     of that candle does not matter; a close of 92.21 after a peak of 92.25
 *     counts exactly as much as a close of 88 does.
 *   - An intrabar spike through Sell 1 does NOT invalidate. Only a bar that
 *     CLOSES beyond Sell 1 kills the peak.
 *
 * Nothing here ever emits a signal; the entry is triggered intrabar by
 * `checkSellRetestTrigger`.
 */
function advanceSellRetestOnClose(s: RetestState, closeRsi: number, notes: string[]): RetestState {
  const t = SPEC.thresholds;

  switch (s.phase) {
    case 'AWAITING_ARM_RESET':
      return closeRsi <= t.sell2 ? { phase: 'IDLE', runningExtreme: null, frozenExtreme: null } : s;

    case 'IDLE':
      if (closeRsi > t.sell2) {
        notes.push(`SELL retest armed: bar closed at RSI ${fmt(closeRsi)}, above Sell 2 (${t.sell2})`);
        return { phase: 'TRACKING_EXTREME', runningExtreme: closeRsi, frozenExtreme: null };
      }
      return s;

    case 'TRACKING_EXTREME': {
      if (closeRsi < t.sell1) {
        notes.push(`SELL retest invalidated: bar closed at ${fmt(closeRsi)}, below Sell 1 (${t.sell1})`);
        return { phase: 'IDLE', runningExtreme: null, frozenExtreme: null };
      }
      const runningMax = s.runningExtreme ?? closeRsi;
      if (closeRsi > runningMax) return { ...s, runningExtreme: closeRsi };
      if (closeRsi === runningMax) return s;
      notes.push(`SELL peak frozen at ${fmt(runningMax)} — a falling candle closed at ${fmt(closeRsi)}`);
      return { phase: 'EXTREME_FROZEN', runningExtreme: null, frozenExtreme: runningMax };
    }

    case 'EXTREME_FROZEN':
      if (closeRsi < t.sell1) {
        notes.push(`SELL retest invalidated: bar closed at ${fmt(closeRsi)}, below Sell 1 (${t.sell1}) before the peak was retested`);
        return { phase: 'IDLE', runningExtreme: null, frozenExtreme: null };
      }
      return s;

    case 'AWAITING_REARM':
      if (closeRsi < t.sell1) {
        notes.push(`SELL retest rearmed: bar closed at ${fmt(closeRsi)}, below Sell 1 (${t.sell1})`);
        return { phase: 'IDLE', runningExtreme: null, frozenExtreme: null };
      }
      return s;
  }
}

/** The entry itself: intrabar, the moment RSI returns to the frozen peak. */
function checkSellRetestTrigger(
  s: RetestState,
  prev: number | null,
  rsi: number,
  triggered: TriggeredSetup[],
  notes: string[],
  canEmit: boolean,
): RetestState {
  if (s.phase !== 'EXTREME_FROZEN') return s;
  const peak = s.frozenExtreme as number;
  if (prev === null || !(prev < peak) || !(rsi >= peak)) return s;

  if (canEmit) {
    triggered.push({
      kind: 'SELL_PEAK_RETEST',
      direction: 'SELL',
      keyLevel: peak,
      reason: `RSI returned to its frozen peak ${fmt(peak)} (previous ${fmt(prev)}, current ${fmt(rsi)}) after a confirmed pullback, without any bar closing below Sell 1 (${SPEC.thresholds.sell1})`,
    });
  } else {
    notes.push(`SELL retest condition met at peak ${fmt(peak)} but emission is suppressed (warm-up or stale data); consumed, not queued`);
  }
  return { phase: 'AWAITING_REARM', runningExtreme: null, frozenExtreme: null };
}

/** BUY trough tracking, advanced ONLY on a closed M1 bar. Mirror of the above. */
function advanceBuyRetestOnClose(s: RetestState, closeRsi: number, notes: string[]): RetestState {
  const t = SPEC.thresholds;

  switch (s.phase) {
    case 'AWAITING_ARM_RESET':
      return closeRsi >= t.buy2 ? { phase: 'IDLE', runningExtreme: null, frozenExtreme: null } : s;

    case 'IDLE':
      if (closeRsi < t.buy2) {
        notes.push(`BUY retest armed: bar closed at RSI ${fmt(closeRsi)}, below Buy 2 (${t.buy2})`);
        return { phase: 'TRACKING_EXTREME', runningExtreme: closeRsi, frozenExtreme: null };
      }
      return s;

    case 'TRACKING_EXTREME': {
      if (closeRsi > t.buy1) {
        notes.push(`BUY retest invalidated: bar closed at ${fmt(closeRsi)}, above Buy 1 (${t.buy1})`);
        return { phase: 'IDLE', runningExtreme: null, frozenExtreme: null };
      }
      const runningMin = s.runningExtreme ?? closeRsi;
      if (closeRsi < runningMin) return { ...s, runningExtreme: closeRsi };
      if (closeRsi === runningMin) return s;
      notes.push(`BUY trough frozen at ${fmt(runningMin)} — a rising candle closed at ${fmt(closeRsi)}`);
      return { phase: 'EXTREME_FROZEN', runningExtreme: null, frozenExtreme: runningMin };
    }

    case 'EXTREME_FROZEN':
      if (closeRsi > t.buy1) {
        notes.push(`BUY retest invalidated: bar closed at ${fmt(closeRsi)}, above Buy 1 (${t.buy1}) before the trough was retested`);
        return { phase: 'IDLE', runningExtreme: null, frozenExtreme: null };
      }
      return s;

    case 'AWAITING_REARM':
      if (closeRsi > t.buy1) {
        notes.push(`BUY retest rearmed: bar closed at ${fmt(closeRsi)}, above Buy 1 (${t.buy1})`);
        return { phase: 'IDLE', runningExtreme: null, frozenExtreme: null };
      }
      return s;
  }
}

/** The entry itself: intrabar, the moment RSI returns to the frozen trough. */
function checkBuyRetestTrigger(
  s: RetestState,
  prev: number | null,
  rsi: number,
  triggered: TriggeredSetup[],
  notes: string[],
  canEmit: boolean,
): RetestState {
  if (s.phase !== 'EXTREME_FROZEN') return s;
  const trough = s.frozenExtreme as number;
  if (prev === null || !(prev > trough) || !(rsi <= trough)) return s;

  if (canEmit) {
    triggered.push({
      kind: 'BUY_TROUGH_RETEST',
      direction: 'BUY',
      keyLevel: trough,
      reason: `RSI returned to its frozen trough ${fmt(trough)} (previous ${fmt(prev)}, current ${fmt(rsi)}) after a confirmed rebound, without any bar closing above Buy 1 (${SPEC.thresholds.buy1})`,
    });
  } else {
    notes.push(`BUY retest condition met at trough ${fmt(trough)} but emission is suppressed (warm-up or stale data); consumed, not queued`);
  }
  return { phase: 'AWAITING_REARM', runningExtreme: null, frozenExtreme: null };
}

function stepExtremeSell(
  s: ExtremeState,
  prev: number | null,
  rsi: number,
  triggered: TriggeredSetup[],
  notes: string[],
  canEmit: boolean,
): ExtremeState {
  const level = SPEC.thresholds.extremeSellCross;

  if (s.phase === 'AWAITING_RESET' || s.phase === 'DISARMED') {
    // Requires RSI to be outside the extreme region before it can fire again
    // — simply REMAINING extreme can never produce repeated orders (spec §6).
    if (rsi < level) return { phase: 'ARMED' };
    return s;
  }

  // ARMED
  if (prev !== null && prev < level && rsi >= level) {
    if (canEmit) {
      triggered.push({
        kind: 'EXTREME_SELL',
        direction: 'SELL',
        keyLevel: level,
        reason: `RSI crossed into the extreme-SELL region (previous ${fmt(prev)} < ${level}, current ${fmt(rsi)} >= ${level}); no peak retest required`,
      });
    } else {
      notes.push(`extreme SELL crossing at ${fmt(rsi)} suppressed (warm-up or stale data); consumed, not queued`);
    }
    return { phase: 'DISARMED' };
  }
  return s;
}

function stepExtremeBuy(
  s: ExtremeState,
  prev: number | null,
  rsi: number,
  triggered: TriggeredSetup[],
  notes: string[],
  canEmit: boolean,
): ExtremeState {
  const level = SPEC.thresholds.extremeBuyCross;

  if (s.phase === 'AWAITING_RESET' || s.phase === 'DISARMED') {
    if (rsi > level) return { phase: 'ARMED' };
    return s;
  }

  if (prev !== null && prev > level && rsi <= level) {
    if (canEmit) {
      triggered.push({
        kind: 'EXTREME_BUY',
        direction: 'BUY',
        keyLevel: level,
        reason: `RSI crossed into the extreme-BUY region (previous ${fmt(prev)} > ${level}, current ${fmt(rsi)} <= ${level}); no trough retest required`,
      });
    } else {
      notes.push(`extreme BUY crossing at ${fmt(rsi)} suppressed (warm-up or stale data); consumed, not queued`);
    }
    return { phase: 'DISARMED' };
  }
  return s;
}

/**
 * Splits one observation's triggers into AT MOST ONE decision per rule
 * family.
 *
 * This replaces the earlier behaviour, which merged every same-direction
 * trigger into a single order. Under the two-slot model a retest and an
 * extreme are separate trades against separate slots, so an observation that
 * satisfies both must produce two separately identified decisions — the
 * execution layer then reserves each family's slot independently and may
 * accept one, both, or neither depending on occupancy and risk capacity.
 *
 * Within a family the merge still applies: SELL and BUY cannot both fire in
 * one family on one observation (no RSI value is simultaneously above a >91
 * peak and below a <8.9 trough, nor >= 98.5 and <= 1.5), so encountering that
 * means the state machine is broken and it throws rather than guessing.
 */
export interface FamilyDecision {
  family: RuleFamily;
  direction: Direction;
  kinds: SetupKind[];
  reason: string;
}

export function splitByRuleFamily(triggered: readonly TriggeredSetup[]): FamilyDecision[] {
  const out: FamilyDecision[] = [];
  for (const family of RULE_FAMILIES) {
    const inFamily = triggered.filter((t) => ruleFamilyFor(t.kind) === family);
    if (inFamily.length === 0) continue;

    const directions = new Set(inFamily.map((t) => t.direction));
    if (directions.size > 1) {
      throw new Error(
        `xauusd-rsi: opposite-direction setups fired in the ${family} family on one observation ` +
          `(${inFamily.map((t) => `${t.kind}:${t.direction}`).join(', ')}) — this is arithmetically ` +
          'impossible under the spec and indicates a state-machine defect.',
      );
    }

    out.push({
      family,
      direction: inFamily[0].direction,
      kinds: inFamily.map((t) => t.kind),
      reason: inFamily.map((t) => `[${t.kind}] ${t.reason}`).join(' | '),
    });
  }
  return out;
}

function fmt(n: number): string {
  return n.toFixed(4);
}
