/**
 * Durable, restart-safe state for the XAUUSD RSI watch loop.
 *
 * Persists exactly what spec §7 requires: versioned pattern state, the
 * configuration hash it was produced under, the observation cursor, the
 * identity of the last consumed observation, and recovery metadata.
 *
 * File-based, matching this codebase's established watch-state posture, with
 * two properties that matter more than the storage medium:
 *
 * 1. **A spec-hash mismatch is refused, never migrated.** State produced under
 *    different thresholds cannot be reinterpreted under new ones; silently
 *    adopting it would produce decisions no audit could explain.
 * 2. **Writes are atomic.** A new file is written and then renamed over the
 *    old one, with the previous version kept, so a crash mid-write cannot
 *    leave truncated JSON that would look like a fresh cold start.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEngineState, EngineState, ObservationMode } from './engine';
import { SPEC_HASH } from './spec';
import { RSI_CURSOR_TIME_BASIS } from './tick-time';

export interface ObservationCursor {
  /** Timestamp (UTC ms) of the newest observation consumed. */
  lastTimestampMs: number | null;
  /** Identity of that observation, so an overlapping refetch cannot double-process it. */
  lastTickKey: string | null;
  /** Identities consumed at exactly `lastTimestampMs`, for same-millisecond ties. */
  lastTimestampKeys: string[];
  /**
   * Which timeline `lastTimestampMs` was recorded on.
   *
   * Cursors written before the broker wall-clock correction (tick-time.ts)
   * hold a value three hours ahead of the true UTC one the same tick now
   * produces. Such a cursor sits in the future and would silently filter
   * out every new observation, so it is discarded rather than trusted. A
   * missing tag means "written before the correction existed".
   */
  timeBasis?: string;
}

export interface RecoveryMetadata {
  /** When this process last completed a full cycle. */
  lastCycleAtUtc: string | null;
  /** When the engine last had its indicator rebuilt from history. */
  lastReseedAtUtc: string | null;
  /**
   * False until startup reconciliation has completed. Entries are blocked
   * while false (spec §9.4), so a restart cannot trade before it has
   * compared its persisted decisions against real broker exposure.
   */
  recoveryComplete: boolean;
  /** Human-readable account of the last recovery, for the dashboard. */
  lastRecoveryDetail: string | null;
  restartCount: number;
  /**
   * Recent measured gaps between completed cycles, in milliseconds.
   *
   * Persisted so the dashboard can report the ACTUAL observation cadence
   * rather than the configured one. The configured interval is an intention;
   * this is what happened. Bounded to the most recent samples so the state
   * file cannot grow without limit.
   */
  cadenceSamplesMs: number[];
}

export interface RsiWatchState {
  specHash: string;
  strategyVersion: string;
  engine: EngineState;
  cursor: ObservationCursor;
  recovery: RecoveryMetadata;
}

export function createWatchState(strategyVersion: string, mode: ObservationMode): RsiWatchState {
  return {
    specHash: SPEC_HASH,
    strategyVersion,
    engine: createEngineState(mode),
    cursor: { lastTimestampMs: null, lastTickKey: null, lastTimestampKeys: [], timeBasis: RSI_CURSOR_TIME_BASIS },
    recovery: {
      lastCycleAtUtc: null,
      lastReseedAtUtc: null,
      recoveryComplete: false,
      lastRecoveryDetail: null,
      restartCount: 0,
      cadenceSamplesMs: [],
    },
  };
}

export class SpecHashMismatchError extends Error {}

export class RsiWatchStore {
  readonly statePath: string;
  readonly lockPath: string;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.statePath = join(dir, 'xauusd-rsi-watch-state.json');
    this.lockPath = join(dir, 'xauusd-rsi-watch.lock');
  }

  load(strategyVersion: string, mode: ObservationMode): RsiWatchState {
    if (!existsSync(this.statePath)) return createWatchState(strategyVersion, mode);

    let parsed: RsiWatchState;
    try {
      parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as RsiWatchState;
    } catch (err) {
      throw new Error(
        `xauusd-rsi watch state at ${this.statePath} is unreadable (${err instanceof Error ? err.message : err}). ` +
          'Refusing to start from a cold state that would look identical to a genuine first run — inspect or archive the file first.',
      );
    }

    if (parsed.specHash !== SPEC_HASH) {
      throw new SpecHashMismatchError(
        `Persisted state belongs to spec ${parsed.specHash}; the current spec is ${SPEC_HASH}. ` +
          `Refusing to mix rule versions — archive ${this.dir} first, then start fresh so warm-up runs again under the new rules.`,
      );
    }

    // A restart always re-establishes continuity before it may trade: pattern
    // progress is not trusted across an unobserved interval, and recovery must
    // be re-confirmed against real broker state.
    parsed.recovery = {
      ...parsed.recovery,
      recoveryComplete: false,
      restartCount: (parsed.recovery?.restartCount ?? 0) + 1,
      // Cadence samples from BEFORE the restart describe a process that is no
      // longer running, so they are discarded rather than blended with the
      // new one's.
      cadenceSamplesMs: [],
    };
    return parsed;
  }

  save(state: RsiWatchState): void {
    const tmp = `${this.statePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state));
    if (existsSync(this.statePath)) renameSync(this.statePath, `${this.statePath}.previous`);
    renameSync(tmp, this.statePath);
  }

  /**
   * Single-instance enforcement. Two watch processes against one account
   * would both claim decisions and could both submit — the lock is what makes
   * "old and new schedulers cannot both submit" (spec §10) true in practice.
   */
  acquireLock(nowT: number, staleAfterMs = 15 * 60_000): void {
    if (existsSync(this.lockPath)) {
      const lock = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { pid: number; atT: number };
      if (nowT - lock.atT < staleAfterMs) {
        throw new Error(`another XAUUSD RSI watch process holds ${this.lockPath} (pid ${lock.pid}, heartbeat ${new Date(lock.atT).toISOString()})`);
      }
    }
    writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, atT: nowT }));
  }

  heartbeat(nowT: number): void {
    writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, atT: nowT }));
  }

  releaseLock(): void {
    if (existsSync(this.lockPath)) unlinkSync(this.lockPath);
  }
}

export function defaultStateDir(): string {
  return process.env.XAUUSD_RSI_STATE_DIR?.trim() || join(process.cwd(), 'xauusd-rsi-runtime');
}
