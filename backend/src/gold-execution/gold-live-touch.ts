/**
 * Live-quote first-touch detection — the friend's rule is entry at the
 * FIRST TOUCH of an already-established H4 level, observed as it happens,
 * not delayed until an M1 candle closes. `confirmed-retest-v2`'s own
 * replay engine only ever looks at CLOSED M1 candles (see
 * `replay.ts:advance()` — a bar is only processed once `bar.t + bar.dur <=
 * endT`), which is correct and frozen for historical study/backtesting, but
 * for LIVE execution it means a touch is only ever noticed up to a whole M1
 * candle-close-and-sync cycle late (worst case, several minutes). This
 * module adds a second, live-quote-driven detection layer on top of the
 * SAME level-lifecycle state `confirmed-retest-v2/levels.ts` owns
 * (`LevelEngineState`), using its own public `consumeLevel()` — the exact
 * function v2's own M1 path calls — so a level is retired identically
 * regardless of which layer detects its first return first. H4/D1 level
 * FORMATION (`onH4Close`/`onD1Close`, called from `replay.ts` before this
 * module ever runs) is completely untouched; this module only ever reads
 * `activeLevelIds`/`levels[id]` and calls the same public retirement
 * function, never anything about how or when a level becomes active.
 *
 * Sampling reality, stated plainly (never overclaimed): `LiveTick` stores
 * only the SINGLE latest bid/ask per symbol — there is no tick history to
 * scan. This module therefore compares the current tick against the last
 * tick THIS module itself observed (persisted across cycles), which means
 * detection resolution is bounded by how often this function is called
 * (in practice, the scheduler's own cycle interval), not true tick-by-tick
 * granularity. Two direct consequences, both handled explicitly rather than
 * glossed over:
 *  - A touch-and-full-reversal that completes entirely between two
 *    observations (price crosses the level and comes back before the next
 *    poll) is INVISIBLE to this module — both observations show price on
 *    the original side. This is a real, disclosed blind spot of latest-tick
 *    sampling, not a bug: `confirmed-retest-v2`'s own M1 wick-based
 *    detection (`classifyTouch`, using the bar's real high/low) still
 *    catches it later, at its normal (slower) cadence, because a level this
 *    module has not yet retired stays fully visible to the M1 path.
 *  - A gap between two observations that is unusually large (a stall,
 *    restart, or missed cycle) is NOT used to infer a crossing — per the
 *    explicit "skip rather than guess" requirement, `detectLiveTouches`
 *    treats an over-large gap as unresolved and simply re-baselines,
 *    leaving it to the M1 layer (which has its own full historical record)
 *    to determine what actually happened during the gap.
 */
import type { LevelEngineState } from '../research/confirmed-retest-v2/levels';
import { consumeLevel } from '../research/confirmed-retest-v2/levels';
import { SPEC } from '../research/confirmed-retest-v2/spec';
import { beirutSecondsOfDay } from '../research/confirmed-retest-v2/time';
import type { Role } from '../research/confirmed-retest-v2/types';

export interface LiveQuoteObservation {
  /** Bid — the same side `confirmed-retest-v2`'s own M1 OHLC is built from (MT5's default candle price basis), so a live-detected touch uses the identical price basis as the historical/formation data the level itself came from. */
  bid: number;
  atT: number;
}

export interface LiveTouchTrackerState {
  lastObserved: Record<string, LiveQuoteObservation>;
}

export function createLiveTouchTrackerState(): LiveTouchTrackerState {
  return { lastObserved: {} };
}

export interface LiveTouchEvent {
  id: string;
  levelId: string;
  role: Role;
  /** Integer cents, same convention as `Level.price` — caller converts to dollars. */
  levelPrice: number;
  generation: number;
  direction: 'BUY' | 'SELL';
  /** When this module itself observed the crossing — the earliest instant this module can honestly claim to know about, never the true (possibly slightly earlier) crossing instant. */
  touchAtT: number;
  inWindow: boolean;
  /** How long since the previous observation of this same level — an honest upper bound on how much earlier the true crossing might have happened. */
  observationGapMs: number;
  levelActivatedT: number;
}

export interface DetectLiveTouchesResult {
  events: LiveTouchEvent[];
  tracker: LiveTouchTrackerState;
  notes: string[];
}

export interface DetectLiveTouchesParams {
  /** The SAME `ReplayState.levels` object the M1 path just advanced this cycle — mutated in place via `consumeLevel` on detection, exactly like the M1 path does, so both layers retire a level identically. */
  levels: LevelEngineState;
  tracker: LiveTouchTrackerState;
  currentTick: LiveQuoteObservation | null;
  nowT: number;
  /** A tick older than this (vs. `nowT`) is treated as unavailable — never used to declare a touch, since it is not actually "now" information. */
  maxTickStalenessMs: number;
  /** A gap between two observations of the SAME level larger than this is treated as unresolved (deferred to the M1 layer) rather than compared directly — see module header. */
  maxObservationGapMs: number;
}

function isInWindow(atT: number): boolean {
  const secs = beirutSecondsOfDay(atT);
  return secs >= SPEC.session.entryWindowStartSecondsBeirut && secs < SPEC.session.entryWindowEndSecondsBeirutExclusive;
}

export function detectLiveTouches(params: DetectLiveTouchesParams): DetectLiveTouchesResult {
  const { levels, tracker, currentTick, nowT, maxTickStalenessMs, maxObservationGapMs } = params;
  const notes: string[] = [];
  const nextObserved: Record<string, LiveQuoteObservation> = { ...tracker.lastObserved };

  // Drop any tracked baseline for a level that is no longer active (retired by either layer, or expired) — never compare against a level the engine no longer considers open.
  for (const id of Object.keys(nextObserved)) {
    if (!levels.activeLevelIds.includes(id)) delete nextObserved[id];
  }

  if (!currentTick) {
    notes.push('no live XAUUSD tick available this cycle — live-quote detection skipped, M1 replay remains the only detection path this cycle');
    return { events: [], tracker: { lastObserved: nextObserved }, notes };
  }
  if (nowT - currentTick.atT > maxTickStalenessMs) {
    notes.push(`live tick is ${((nowT - currentTick.atT) / 1000).toFixed(0)}s old (max ${(maxTickStalenessMs / 1000).toFixed(0)}s) — treated as unavailable, never used to declare a touch`);
    return { events: [], tracker: { lastObserved: nextObserved }, notes };
  }

  const events: LiveTouchEvent[] = [];
  for (const id of levels.activeLevelIds) {
    const level = levels.levels[id];
    if (currentTick.atT <= level.activatedT) continue; // not yet active as of this tick

    const prev = nextObserved[id];
    if (!prev) {
      // First live observation of this (still-active) level — establishes the baseline only. We have no earlier live reference point, so we cannot know whether price already crossed before we started watching; the M1 layer is authoritative for anything before this baseline.
      nextObserved[id] = currentTick;
      continue;
    }

    const gapMs = currentTick.atT - prev.atT;
    if (gapMs > maxObservationGapMs) {
      notes.push(`level ${id}: observation gap ${(gapMs / 1000).toFixed(0)}s exceeds ${(maxObservationGapMs / 1000).toFixed(0)}s — cannot establish what happened live during the gap; re-baselining, deferring to M1 replay rather than guessing`);
      nextObserved[id] = currentTick;
      continue;
    }

    const levelPriceDollars = level.price / 100;
    const touched = level.role === 'SUPPORT' ? currentTick.bid <= levelPriceDollars : currentTick.bid >= levelPriceDollars;
    if (!touched) {
      nextObserved[id] = currentTick;
      continue;
    }

    const touchAtT = currentTick.atT;
    const eventId = `live-evt:${id}:${touchAtT}`;
    consumeLevel(levels, id, touchAtT, eventId); // retires regardless of window — spec's own outsideWindowFirstReturnConsumesLevel rule, unchanged
    delete nextObserved[id];

    events.push({
      id: eventId,
      levelId: id,
      role: level.role,
      levelPrice: level.price,
      generation: level.generation,
      direction: level.role === 'SUPPORT' ? 'BUY' : 'SELL',
      touchAtT,
      inWindow: isInWindow(touchAtT),
      observationGapMs: gapMs,
      levelActivatedT: level.activatedT,
    });
  }

  return { events, tracker: { lastObserved: nextObserved }, notes };
}
