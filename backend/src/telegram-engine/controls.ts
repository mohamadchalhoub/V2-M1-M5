/**
 * Operator controls for Engine B, and the shared emergency stop.
 *
 * Three switches, read fresh from disk or the environment on every call and
 * never cached at import time, so a control an operator flips takes effect on
 * the very next check rather than on the next restart:
 *
 * - `TELEGRAM_ENGINE_KILL_SWITCH` — stops Engine B alone.
 * - `V2_GLOBAL_KILL_SWITCH` — the shared emergency stop, which belongs to
 *   account-level safety rather than to either strategy.
 * - `TELEGRAM_ENGINE_EXECUTION_MODE` — OFF / SHADOW / DEMO, Engine B's own.
 *
 * ## Why Engine A's kill switch is not read here
 *
 * `XAUUSD_M1M5_KILL_SWITCH` is named after Engine A and documented as
 * governing only it. Reading it here would make an operator who stopped the
 * RSI engine silently stop the Telegram engine too — and, worse, the
 * converse is what would have to change for symmetry, which would mean
 * altering Engine A's behaviour. Engine A is frozen, so the shared stop is a
 * THIRD switch that either engine can honour without either engine's own
 * switch changing meaning.
 *
 * Adding `V2_GLOBAL_KILL_SWITCH` to Engine A is a separate, explicit decision
 * for whoever unfreezes it; until then it stops Engine B only, and this
 * comment is the record of that gap rather than a claim that it does more.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultStateDir } from '../xauusd-m1m5/state-store';

/**
 * No REAL mode and no automatic real-account path — the type cannot hold such
 * a value, so no configuration mistake can produce one.
 *
 * - `OFF`    — signals are received, parsed and recorded; nothing is ever
 *              claimed or sent.
 * - `SHADOW` — every gate runs and every outcome is recorded exactly as if
 *              trading, stopping only at the broker hand-off.
 * - `DEMO`   — legs are queued as real orders against the positively
 *              verified DEMO account.
 */
export type TelegramExecutionMode = 'OFF' | 'SHADOW' | 'DEMO';

export function getTelegramExecutionMode(): TelegramExecutionMode {
  const raw = (process.env.TELEGRAM_ENGINE_EXECUTION_MODE ?? '').trim().toUpperCase();
  if (raw === 'SHADOW') return 'SHADOW';
  if (raw === 'DEMO') return 'DEMO';
  // Fails closed to OFF for anything else — unset, a typo, "true" — so an
  // active mode is never reached by accident.
  return 'OFF';
}

/**
 * Control files live in the STATE DIRECTORY, the volume every container
 * mounts at the same path — not in `process.cwd()`, which is a different
 * private `/app` in each container. A switch engaged from the API that the
 * worker cannot see is a safety control that appears to work and does
 * nothing, which is the worst way one can fail.
 */
export function getTelegramKillSwitchPath(): string {
  return process.env.TELEGRAM_ENGINE_KILL_SWITCH_PATH?.trim() || join(defaultStateDir(), 'TELEGRAM_ENGINE_KILL_SWITCH');
}

export function getGlobalKillSwitchPath(): string {
  return process.env.V2_GLOBAL_KILL_SWITCH_PATH?.trim() || join(defaultStateDir(), 'V2_GLOBAL_KILL_SWITCH');
}

export interface ControlState {
  readonly active: boolean;
  /** Which control is responsible, for an operator who needs to know what to undo. */
  readonly source: string | null;
}

export function globalKillSwitchState(): ControlState {
  const path = getGlobalKillSwitchPath();
  if (existsSync(path)) return { active: true, source: `global kill-switch file ${path}` };
  if ((process.env.V2_GLOBAL_KILL_SWITCH ?? '').trim().toLowerCase() === 'true') {
    return { active: true, source: 'environment variable V2_GLOBAL_KILL_SWITCH=true' };
  }
  return { active: false, source: null };
}

export function telegramKillSwitchState(): ControlState {
  const path = getTelegramKillSwitchPath();
  if (existsSync(path)) return { active: true, source: `Telegram kill-switch file ${path}` };
  if ((process.env.TELEGRAM_ENGINE_KILL_SWITCH ?? '').trim().toLowerCase() === 'true') {
    return { active: true, source: 'environment variable TELEGRAM_ENGINE_KILL_SWITCH=true' };
  }
  return { active: false, source: null };
}

/**
 * Operator controls only, mode deliberately EXCLUDED.
 *
 * SHADOW exists to rehearse the full pipeline. If the mode were checked here,
 * a SHADOW run would refuse at the first gate and never exercise freshness,
 * duplicate detection, quote deviation or broker validation — so SHADOW would
 * stop testing the very things it exists to test. The mode is enforced
 * instead at the submission step, by `isTelegramSubmissionEnabled()`.
 */
export function telegramEntriesBlockedByControls(): string | null {
  const global = globalKillSwitchState();
  if (global.active) return `Global emergency kill switch is active (${global.source}).`;
  const own = telegramKillSwitchState();
  if (own.active) return `Telegram engine kill switch is active (${own.source}).`;
  return null;
}

/** True when the mode permits a leg to actually reach the broker. */
export function isTelegramSubmissionEnabled(): boolean {
  return getTelegramExecutionMode() === 'DEMO' && telegramEngineEnabled();
}

/**
 * `TELEGRAM_ENGINE_ENABLED` — the engine's own on/off switch, separate from
 * both the execution mode and the kill switches.
 *
 * Off blocks NEW Telegram entries and nothing else. Reconciliation of legs
 * already sent, discovery of positions opened before it was turned off, and
 * management of open Telegram positions all continue — a switch that
 * abandoned an open position would be worse than the situation it was flipped
 * to prevent.
 *
 * Defaults to FALSE. Engine B does not trade because it was deployed; it
 * trades because someone turned it on.
 */
export function telegramEngineEnabled(): boolean {
  return (process.env.TELEGRAM_ENGINE_ENABLED ?? '').trim().toLowerCase() === 'true';
}

/**
 * The adverse-entry bound, in USD of gold price.
 *
 * Adverse only: movement toward the first target is favourable and is never
 * bounded by this (see `tp1.ts`). Configurable because the right number
 * depends on the channel's habits and on spread, and it is the one execution
 * parameter an operator will genuinely want to tune from observed SHADOW
 * traffic rather than from a guess made here.
 *
 * An unset, unparseable or non-positive value falls back to the compiled
 * default rather than to "unbounded": a typo in an env file must not remove
 * a safety bound.
 */
export function configuredMaxAdverseEntryDeviationUsd(): number {
  const raw = Number((process.env.TELEGRAM_MAX_ADVERSE_ENTRY_DEVIATION_USD ?? '').trim());
  if (!Number.isFinite(raw) || raw <= 0) return TELEGRAM_DEFAULT_MAX_ADVERSE_ENTRY_DEVIATION_USD;
  return raw;
}

/**
 * The operator-set default for this bound: $50 of adverse movement.
 *
 * Raised from an earlier $1.50 default by explicit operator instruction.
 * Movement on the favourable side is refused outright regardless of this
 * bound — see `tp1.ts` — so this number governs only how far worse than
 * published the market may have moved before the copy is refused as too
 * stale a price to take.
 */
export const TELEGRAM_DEFAULT_MAX_ADVERSE_ENTRY_DEVIATION_USD = 50;
