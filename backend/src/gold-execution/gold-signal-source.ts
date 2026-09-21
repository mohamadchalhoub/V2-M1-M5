/**
 * Bridges confirmed-retest-v2's pure research engine (formation, first-
 * return consumption, entry-window, D1-descriptive-only) to the gold
 * execution coordinator — WITHOUT modifying v2 itself or its own directory
 * (`src/research/confirmed-retest-v2/`), so v2's own boundary test
 * (`test/research/confirmed-retest-v2/boundary.spec.ts`, which forbids
 * anything under that directory from importing execution code) is
 * completely unaffected: this file lives in `gold-execution/`, not there,
 * and only ever READS v2's exported types/pipeline/replay — it never
 * modifies them, and v2 never imports anything from here.
 *
 * `toGoldSignal`/`toGoldSignalFromLiveTouch` are pure mappings (heavily
 * unit-tested); `runGoldWatchCycle` is the thin, DB-touching orchestration.
 * It advances v2's M1 replay every cycle (frozen — level FORMATION and
 * anything the live-quote layer's sampling can't see), but that path is
 * audit-only: an M1-discovered touch is, by construction, already in the
 * past, so it is only ever logged (`orderStatus: NONE`) and consumed, NEVER
 * submitted as an order. The live-quote layer (`gold-live-touch.ts`) run
 * afterward, against the exact state the M1 pass just advanced, is the ONLY
 * path that can produce a real submission — see its own header for why.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { executeRun, loadAll } from '../research/confirmed-retest-v2/pipeline';
import type { ReplayState } from '../research/confirmed-retest-v2/replay';
import { SPEC_HASH } from '../research/confirmed-retest-v2/spec';
import type { FirstReturnEvent } from '../research/confirmed-retest-v2/types';
import { GoldCoordinatorContext, GoldExecutionCoordinatorService, GoldSignal } from './gold-execution-coordinator.service';
import {
  createLiveTouchTrackerState,
  detectLiveTouches,
  LiveQuoteObservation,
  LiveTouchEvent,
  LiveTouchTrackerState,
} from './gold-live-touch';
import { GOLD_LIVE_OBSERVATION_MAX_GAP_SECONDS, GOLD_LIVE_TICK_MAX_STALENESS_SECONDS, GOLD_POINT_SIZE, GOLD_SYMBOL } from './gold-safety-constants';

/**
 * Identifies an M1-replay-discovered event worth recording for audit —
 * NOT "worth submitting as an order." A closed M1 candle is, by definition,
 * already in the past by the time it is processed, so this path (see
 * `runGoldWatchCycle` below) only ever LOGS these (audit-only, `orderStatus:
 * NONE`) and marks them acted-on; it never calls the coordinator and never
 * queues a real order. The live-quote layer (`gold-live-touch.ts`) is the
 * ONLY path that can produce a real submission — this function's name
 * predates that split and is kept for the events it still identifies
 * (M1-visible, eligible, in-window, not yet acted on), not for what used to
 * happen to them.
 */
export function isActionableLiveEvent(event: FirstReturnEvent, actedEventIds: ReadonlySet<string>): boolean {
  return (
    event.observedAtT !== null &&
    event.eligible === true &&
    event.inWindow === true &&
    event.direction !== null &&
    !actedEventIds.has(event.id)
  );
}

/** Pure mapping — no I/O, no live price (the caller supplies the freshest executable price separately). */
export function toGoldSignal(event: FirstReturnEvent, currentExecutablePrice: number): GoldSignal {
  if (event.direction !== 'BUY' && event.direction !== 'SELL') {
    throw new Error(`event ${event.id} has no direction — cannot build a signal from it`);
  }
  // Friend rule: BUY a qualifying support touch, SELL a qualifying resistance touch — direction
  // is already derived that way inside v2's formation engine (levels.ts); re-asserted here as a
  // defense-in-depth check rather than trusted blindly from an upstream module.
  const expectedDirection = event.role === 'SUPPORT' ? 'BUY' : 'SELL';
  if (event.direction !== expectedDirection) {
    throw new Error(`event ${event.id}: role=${event.role} but direction=${event.direction} — refusing, this should never happen (breakout entries are never valid).`);
  }
  return {
    action: event.direction === 'BUY' ? 'OPEN_BUY' : 'OPEN_SELL',
    signalEntryPrice: event.levelPrice / 100, // v2 stores integer cents internally; gold-execution works in dollar prices
    currentExecutablePrice,
    levelId: event.levelId,
    reasoning: `confirmed-retest-v2 first-return event ${event.id}, level ${event.levelId} (${event.role}), generation ${event.generation}, touch kind ${event.kind}, D1 agreement=${event.d1Agreement}`,
    touchEndT: event.touchEndT,
  };
}

/** Pure mapping for a live-quote-detected touch — the primary detection path (see gold-live-touch.ts); analogous to `toGoldSignal` but for a `LiveTouchEvent` rather than an M1-derived `FirstReturnEvent`. */
export function toGoldSignalFromLiveTouch(event: LiveTouchEvent, currentExecutablePrice: number): GoldSignal {
  const expectedDirection = event.role === 'SUPPORT' ? 'BUY' : 'SELL';
  if (event.direction !== expectedDirection) {
    throw new Error(`live touch ${event.id}: role=${event.role} but direction=${event.direction} — refusing, this should never happen.`);
  }
  return {
    action: event.direction === 'BUY' ? 'OPEN_BUY' : 'OPEN_SELL',
    signalEntryPrice: event.levelPrice / 100,
    currentExecutablePrice,
    levelId: event.levelId,
    reasoning: `live-quote first-touch of level ${event.levelId} (${event.role}), generation ${event.generation}, detected at ${new Date(event.touchAtT).toISOString()} (observation gap ${(event.observationGapMs / 1000).toFixed(1)}s)`,
    touchEndT: event.touchAtT,
  };
}

export interface GoldWatchState {
  specHash: string;
  replay: ReplayState | null;
  actedEventIds: string[];
  /** Live-quote detection's own persisted baseline per level — see gold-live-touch.ts. Optional/defaulted for backward compatibility with a state file written before this layer existed. */
  liveTouch: LiveTouchTrackerState;
  lastCycleAtUtc: string | null;
}

function newGoldWatchState(): GoldWatchState {
  return { specHash: SPEC_HASH, replay: null, actedEventIds: [], liveTouch: createLiveTouchTrackerState(), lastCycleAtUtc: null };
}

/**
 * File-based persisted state, same restart-safe posture as v1's own
 * `WatchStore` (task requirement: "restart-safe level retirement/trade
 * eligibility," "reconstruct current state WITHOUT executing stale
 * historical touches as new live orders" — the persisted `actedEventIds`
 * set is exactly what prevents the latter across a restart).
 */
export class GoldWatchStore {
  readonly statePath: string;
  readonly lockPath: string;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.statePath = join(dir, 'gold-watch-state.json');
    this.lockPath = join(dir, 'gold-watch.lock');
  }

  load(): GoldWatchState {
    if (!existsSync(this.statePath)) return newGoldWatchState();
    const state = JSON.parse(readFileSync(this.statePath, 'utf8')) as GoldWatchState;
    if (state.specHash !== SPEC_HASH) {
      throw new Error(`gold watch state belongs to spec ${state.specHash}; current v2 spec is ${SPEC_HASH}. Refusing to mix rule versions — archive ${this.dir} first.`);
    }
    // Backward-compatible with a state file written before the live-quote layer existed.
    if (!state.liveTouch) state.liveTouch = createLiveTouchTrackerState();
    return state;
  }

  save(state: GoldWatchState): void {
    const tmp = `${this.statePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state));
    if (existsSync(this.statePath)) renameSync(this.statePath, `${this.statePath}.previous`);
    renameSync(tmp, this.statePath);
  }

  acquireLock(nowT: number, staleAfterMs = 15 * 60_000): void {
    if (existsSync(this.lockPath)) {
      const lock = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { pid: number; atT: number };
      if (nowT - lock.atT < staleAfterMs) throw new Error(`another gold watch cycle holds ${this.lockPath} (pid ${lock.pid})`);
    }
    writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, atT: nowT }));
  }

  releaseLock(): void {
    if (existsSync(this.lockPath)) unlinkSync(this.lockPath);
  }
}

export interface GoldWatchCycleResult {
  /**
   * M1-replay-discovered events this cycle — NEVER submitted as an order.
   * Each is recorded as an audit-only `AutonomousDecision` row
   * (`orderStatus: NONE`) via `auditOnlyDecisionIds` below and marked
   * acted-on, purely so the opportunity is consumed (never later mistaken
   * for a fresh live touch) and there is a durable record of it — the
   * live-quote layer (`gold-live-touch.ts`) is the only path that can ever
   * produce a real submission. A closed M1 candle is, by definition,
   * already in the past by the time it's processed; queuing an order from
   * it would always be a delayed order, which the friend's actual rule
   * (first touch AS IT HAPPENS) does not allow.
   */
  actionableEvents: FirstReturnEvent[];
  /** One audit-only `AutonomousDecision` id per event in `actionableEvents`, in the same order. */
  auditOnlyDecisionIds: string[];
  /** Live-quote-detected touches acted on this cycle (primary path). */
  liveTouchEvents: LiveTouchEvent[];
  liveTouchResults: Array<{ event: LiveTouchEvent; signal: GoldSignal; coordinatorResult: Awaited<ReturnType<GoldExecutionCoordinatorService['evaluate']>> }>;
  /** Live touches outside the entry window — the level is still consumed (spec's outsideWindowFirstReturnConsumesLevel rule), but never submitted. */
  liveTouchOutsideWindow: LiveTouchEvent[];
  liveTouchSkippedNoExecutablePrice: LiveTouchEvent[];
  liveDetectionNotes: string[];
}

/**
 * One watch cycle. Two detection layers run in a fixed order every cycle:
 *  1. The M1-replay layer (`confirmed-retest-v2`, unchanged/frozen) —
 *     authoritative for level FORMATION (H4/D1-driven) and for anything the
 *     live-quote layer's latest-tick-only sampling cannot see (see
 *     gold-live-touch.ts's header for the disclosed blind spot). Runs
 *     first specifically so it gets first claim on any level whose touch
 *     is already visible in closed M1 data — the live layer below only
 *     ever sees levels the M1 layer left active.
 *  2. The live-quote layer (`gold-live-touch.ts`) — the PRIMARY path per
 *     the friend's actual rule (first touch as it happens, not "wait for
 *     an M1 candle to close"), operating on the SAME `ReplayState.levels`
 *     the M1 layer just advanced, so a level is retired identically
 *     regardless of which layer detects it.
 * Never invoked on a timer by this file itself — same deliberate "built and
 * tested ahead of its own scheduler" posture as every other coordinator in
 * this codebase.
 */
export async function runGoldWatchCycle(params: {
  prisma: PrismaClient;
  coordinator: GoldExecutionCoordinatorService;
  store: GoldWatchStore;
  nowT: number;
  accountId: string;
  buildContext: () => Promise<Omit<GoldCoordinatorContext, 'accountId' | 'nowT'>>;
  getExecutablePrice: (direction: 'BUY' | 'SELL') => Promise<number | null>;
  /** The current XAUUSD bid + its own timestamp — the touch-detection basis (see gold-live-touch.ts). Never the ask; execution pricing still comes from `getExecutablePrice`. */
  getLiveQuote: () => Promise<LiveQuoteObservation | null>;
}): Promise<GoldWatchCycleResult> {
  const { prisma, coordinator, store, nowT, accountId, buildContext, getExecutablePrice, getLiveQuote } = params;

  store.acquireLock(nowT);
  try {
    const state = store.load();
    const loaded = await loadAll(prisma, nowT);
    const run = executeRun(loaded, { state: state.replay ?? undefined, observedAtT: nowT });

    const actedIds = new Set(state.actedEventIds);
    const actionableEvents = run.events.filter((e) => isActionableLiveEvent(e, actedIds));

    // Audit-only: NEVER calls the coordinator, NEVER fetches a live price, NEVER queues an
    // order. A closed M1 candle is already in the past by construction — see this interface's
    // own doc comment on `actionableEvents` for why a real submission from here would always be
    // a delayed order, which the friend's rule does not allow.
    const auditOnlyDecisionIds: string[] = [];
    for (const event of actionableEvents) {
      const row = await prisma.autonomousDecision.create({
        data: {
          accountId,
          symbol: GOLD_SYMBOL,
          action: event.direction === 'BUY' ? 'OPEN_BUY' : 'OPEN_SELL',
          source: 'RULES_ONLY',
          entryPrice: event.levelPrice / 100,
          stopLoss: null,
          takeProfit: null,
          reasoning: `M1 replay discovered first-return event ${event.id}, level ${event.levelId} (${event.role}), generation ${event.generation}, touch kind ${event.kind} — a closed M1 candle is already in the past; the live-quote layer (gold-live-touch.ts) is the only path that submits a real order. Recorded for audit and consumed, never queued as a delayed live order.`,
          inputSnapshot: { event } as any,
          riskManagerApproved: false,
          riskManagerRejectionReason: 'M1-discovered touch — audit-only by design, never submitted regardless of age or price.',
          orderStatus: 'NONE',
        },
      });
      auditOnlyDecisionIds.push(row.id);
      actedIds.add(event.id); // marked acted-on regardless — an event is a one-shot opportunity, per the friend's "first return consumes it" rule
    }

    // Live-quote layer — runs against run.state.levels AFTER the M1 layer above has already
    // consumed anything its own closed-candle data could see, so the two layers never race for
    // the same level.
    const currentTick = await getLiveQuote();
    const liveDetection = detectLiveTouches({
      levels: run.state.levels,
      tracker: state.liveTouch,
      currentTick,
      nowT,
      maxTickStalenessMs: GOLD_LIVE_TICK_MAX_STALENESS_SECONDS * 1000,
      maxObservationGapMs: GOLD_LIVE_OBSERVATION_MAX_GAP_SECONDS * 1000,
    });

    const liveTouchResults: GoldWatchCycleResult['liveTouchResults'] = [];
    const liveTouchOutsideWindow: LiveTouchEvent[] = [];
    const liveTouchSkippedNoExecutablePrice: LiveTouchEvent[] = [];

    for (const event of liveDetection.events) {
      if (!event.inWindow) {
        // Already consumed (level retired) inside detectLiveTouches — never submitted, matching the M1 path's OUTSIDE_WINDOW handling.
        liveTouchOutsideWindow.push(event);
        continue;
      }
      const price = await getExecutablePrice(event.direction);
      if (price === null) {
        liveTouchSkippedNoExecutablePrice.push(event);
        continue;
      }
      const signal = toGoldSignalFromLiveTouch(event, price);
      const context = await buildContext();
      const coordinatorResult = await coordinator.evaluate(signal, { ...context, accountId, nowT });
      liveTouchResults.push({ event, signal, coordinatorResult });
    }

    store.save({
      specHash: SPEC_HASH,
      replay: run.state,
      actedEventIds: [...actedIds],
      liveTouch: liveDetection.tracker,
      lastCycleAtUtc: new Date(nowT).toISOString(),
    });
    return {
      actionableEvents,
      auditOnlyDecisionIds,
      liveTouchEvents: liveDetection.events,
      liveTouchResults,
      liveTouchOutsideWindow,
      liveTouchSkippedNoExecutablePrice,
      liveDetectionNotes: liveDetection.notes,
    };
  } finally {
    store.releaseLock();
  }
}

// GOLD_POINT_SIZE re-exported for callers building GoldCoordinatorContext without re-importing gold-safety-constants directly.
export { GOLD_POINT_SIZE };
