/**
 * Durable state for the observation loop (§10).
 *
 * The watch loop runs as a separate process from the API, so this file is how
 * the two communicate: the loop writes, the dashboard reads. That split is
 * deliberate (§14, manual-only startup), and it has a consequence the
 * dashboard must respect — a state file is a SNAPSHOT of a process that may
 * no longer be running, so its heartbeat is reported as stale rather than
 * presented as current. See `dashboard.controller.ts`.
 *
 * ## Writes are atomic
 *
 * Written to a temporary file and renamed over the target. A partially
 * written state file is worse than an absent one: absent is obviously
 * unusable, whereas truncated JSON either fails to parse or — far worse —
 * parses into a state with a plausible-looking but wrong RSI or lock. Rename
 * is atomic on both NTFS and POSIX, so a reader sees either the old file or
 * the new one, never half of either.
 *
 * ## Refused, never migrated
 *
 * State carrying a different spec hash is refused (§10). Arming and continuity
 * decisions recorded under different thresholds cannot be reinterpreted under
 * these ones, and silently adopting them would produce entries no audit could
 * explain.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CrossingState } from './crossing';
import type { EngineState } from './engine';
import { SPEC_HASH, XAUUSD_M1M5_STRATEGY_VERSION, type Timeframe } from './spec';

export interface WatchState {
  readonly strategyVersion: string;
  readonly specHash: string;
  /** Account this state belongs to; state is per strategy+account+timeframe. */
  readonly accountId: string | null;
  /** UTC ms of the last completed observation cycle — the heartbeat. */
  readonly lastCycleAtMs: number;
  /** Measured cycle interval, for the cadence report. */
  readonly lastCycleIntervalMs: number | null;
  /** Measured time from observation to submission, reported separately (§10). */
  readonly lastSubmissionLatencyMs: number | null;
  readonly engines: Record<Timeframe, EngineState>;
  readonly crossings: Record<Timeframe, CrossingState>;
  /** Anything degrading observation, disclosed rather than hidden (§10, §12). */
  readonly observationLimitations: readonly string[];
  /** Set when recovery has completed after a start or reconnect. */
  readonly recoveryCompleteAtMs: number | null;
}

export function defaultStateDir(): string {
  return process.env.XAUUSD_M1M5_STATE_DIR?.trim() || join(process.cwd(), 'xauusd-m1m5-runtime');
}

function statePath(dir: string): string {
  return join(dir, 'watch-state.json');
}

export function readWatchState(dir: string = defaultStateDir()): WatchState | null {
  const path = statePath(dir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as WatchState;
    // Refused, not migrated. A hash mismatch means the rules changed under it.
    if (parsed.specHash !== SPEC_HASH) return null;
    if (parsed.strategyVersion !== XAUUSD_M1M5_STRATEGY_VERSION) return null;
    return parsed;
  } catch {
    // A corrupt file is treated as absent. The loop rebuilds from history,
    // which is slower and correct; parsing around the damage would be faster
    // and might silently resurrect a wrong RSI.
    return null;
  }
}

export function writeWatchState(state: WatchState, dir: string = defaultStateDir()): void {
  mkdirSync(dir, { recursive: true });
  const target = statePath(dir);
  const temp = `${target}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(temp, target);
}

/**
 * Whether a state file's heartbeat is recent enough to describe a live
 * process.
 *
 * Deliberately generous relative to the one-second cycle: a desktop machine
 * pauses, and reporting a healthy loop as dead on a two-second hiccup would
 * train an operator to ignore the signal. Ten missed cycles is not a hiccup.
 */
export const HEARTBEAT_STALE_AFTER_MS = 10_000;

export function heartbeatIsFresh(state: WatchState | null, nowMs: number): boolean {
  if (state === null) return false;
  return nowMs - state.lastCycleAtMs <= HEARTBEAT_STALE_AFTER_MS;
}
