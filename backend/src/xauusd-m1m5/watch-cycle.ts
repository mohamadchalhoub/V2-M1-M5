/**
 * One observation cycle (§10).
 *
 * This is the whole per-tick flow: resolve one coherent quote, fold it into
 * each timeframe's engine, run the decision gate, and report what each
 * timeframe decided. It is deliberately a PURE function over injected state
 * rather than a service that reaches for a database, for two reasons:
 *
 * 1. The interesting failures here are ordering failures — a lock released on
 *    the same observation that formed a crossing, a gap that must not fabricate
 *    either — and those are only testable if the cycle can be driven tick by
 *    tick with no infrastructure.
 * 2. The persistence decisions (claim a slot, record a decision, activate a
 *    lock) are transactional and belong to `occupancy.service.ts`, which owns
 *    their ordering. Mixing them in here would spread one invariant across two
 *    files.
 *
 * So this function decides; the caller persists. The caller is the scheduler.
 */
import { decide, type DecisionOutput, type OccupancyView, type SkipReason } from './decision';
import { isUnlockEligible, observe, type EngineState, type TickRejection } from './engine';
import type { LockSet } from './locks';
import { resolveQuote, type QuoteCandidate, type ResolvedQuote } from './quote';
import { evaluateEntryEligibility, type RuntimeGates } from './schedule';
import { TIMEFRAMES, type Timeframe } from './spec';

export interface TimeframeOutcome {
  readonly timeframe: Timeframe;
  /** Null when the tick was refused before an observation could be formed. */
  readonly decision: DecisionOutput | null;
  readonly tickRejection: TickRejection | null;
  readonly engine: EngineState;
  /** True when this observation may release a post-loss lock. */
  readonly unlockEligible: boolean;
}

export interface CycleResult {
  readonly quote: ResolvedQuote | null;
  /** Null when no usable quote existed; the cycle still ran and reported why. */
  readonly quoteRejection: string | null;
  readonly outcomes: readonly TimeframeOutcome[];
  readonly lockSet: LockSet;
  /** Anything degrading observation this cycle, for the dashboard (§12). */
  readonly limitations: readonly string[];
  /** Candidates ready to submit, subject to risk and the pre-send gate. */
  readonly candidates: readonly { timeframe: Timeframe; decision: DecisionOutput }[];
}

export interface CycleInput {
  readonly candidates: readonly QuoteCandidate[];
  readonly evaluatedAtMs: number;
  readonly engines: Readonly<Record<Timeframe, EngineState>>;
  readonly lockSet: LockSet;
  readonly occupancy: Readonly<Record<Timeframe, OccupancyView>>;
  readonly gates: RuntimeGates;
}

export function runCycle(input: CycleInput): CycleResult {
  const limitations: string[] = [];

  const resolution = resolveQuote(input.candidates, input.evaluatedAtMs);
  limitations.push(...resolution.discarded);
  if (resolution.detail) limitations.push(resolution.detail);

  // No usable quote: every timeframe reports why, state is untouched, and the
  // cycle still completes. A cycle that threw here would take the heartbeat
  // down with it and make a data problem look like a dead process.
  if (resolution.quote === null) {
    return {
      quote: null,
      quoteRejection: resolution.detail,
      outcomes: TIMEFRAMES.map((tf) => ({
        timeframe: tf,
        decision: null,
        tickRejection: null,
        engine: input.engines[tf],
        unlockEligible: false,
      })),
      lockSet: input.lockSet,
      limitations,
      candidates: [],
    };
  }

  const quote = resolution.quote;
  const eligibility = evaluateEntryEligibility(input.evaluatedAtMs, {
    ...input.gates,
    // Freshness is a property of the quote actually selected, not a separate
    // opinion about the feed.
    dataFresh: input.gates.dataFresh && quote.fresh,
  });

  const outcomes: TimeframeOutcome[] = [];
  const candidates: { timeframe: Timeframe; decision: DecisionOutput }[] = [];

  // Lock state threads through both timeframes in sequence, so an unlock
  // applied on M1 is visible when M5 is evaluated in the same cycle. The two
  // timeframes' LOCKS are independent by key, so this ordering cannot leak a
  // decision from one into the other — it only ensures one consistent set.
  let lockSet = input.lockSet;

  for (const tf of TIMEFRAMES) {
    const result = observe(input.engines[tf], {
      tickAtMs: quote.tickAtMs,
      // The RSI is projected from the mid of the SAME selected observation
      // the brackets and freshness came from.
      price: quote.mid,
      evaluatedAtMs: input.evaluatedAtMs,
    });

    if (result.observation === null) {
      outcomes.push({
        timeframe: tf,
        decision: null,
        tickRejection: result.rejection,
        engine: result.state,
        unlockEligible: false,
      });
      continue;
    }

    const unlockEligible = isUnlockEligible(result);
    if (result.continuityReset && result.state.observationCount > 1) {
      limitations.push(
        `${tf}: observation continuity was broken before this tick, so no crossing is formed across the gap ` +
          'and no post-loss lock may be released from it.',
      );
    }

    const decision = decide({
      timeframe: tf,
      crossingState: input.engines[tf].crossing,
      lockSet,
      observation: result.observation,
      occupancy: input.occupancy[tf],
      eligibility,
      unlockEligible,
    });

    lockSet = decision.lockSet;

    outcomes.push({
      timeframe: tf,
      decision,
      tickRejection: null,
      // The engine carries the crossing state forward, so the two stay in
      // step: the engine's own copy is replaced with the one the decision
      // gate consumed and advanced.
      engine: { ...result.state, crossing: decision.crossingState },
      unlockEligible,
    });

    if (decision.candidate !== null) candidates.push({ timeframe: tf, decision });
  }

  return {
    quote,
    quoteRejection: null,
    outcomes,
    lockSet,
    limitations,
    candidates,
  };
}

/** Compact per-cycle log line, for the captured logs the scheduler writes. */
export function describeCycle(result: CycleResult): string {
  if (result.quote === null) return `no usable quote — ${result.quoteRejection ?? 'unknown reason'}`;
  const parts = result.outcomes.map((o) => {
    if (o.tickRejection !== null) return `${o.timeframe}=${o.tickRejection}`;
    const rsi = o.decision?.crossing.state.previousRsi;
    const signal = o.decision?.signal;
    const skip: SkipReason | null = o.decision?.skipReason ?? null;
    const rsiText = rsi === null || rsi === undefined ? 'rsi=?' : `rsi=${rsi.toFixed(4)}`;
    if (signal === null || signal === undefined) return `${o.timeframe} ${rsiText}`;
    return `${o.timeframe} ${rsiText} SIGNAL ${signal.direction}${skip ? ` SKIPPED:${skip}` : ' -> candidate'}`;
  });
  return `${result.quote.source} bid=${result.quote.bid} age=${result.quote.ageSeconds.toFixed(1)}s | ${parts.join(' | ')}`;
}
