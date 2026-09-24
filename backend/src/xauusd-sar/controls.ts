/**
 * Operator controls for `xauusd-sar-v1`: execution mode and kill switch.
 *
 * Own control names, own files — not shared with the frozen RSI strategy's
 * `XAUUSD_M1M5_*` controls or Engine B's `TELEGRAM_ENGINE_*` controls. Same
 * reasoning as both of those: an operator who engages a control expects it to
 * stop the one thing they were thinking about.
 *
 * Read fresh on every call, never cached — a control must take effect on the
 * next check, not the next restart.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultStateDir } from '../xauusd-m1m5/state-store';

/**
 * No REAL mode exists — the type cannot hold one, so no configuration
 * mistake can produce a live order against a real account.
 *
 * - `OFF`    — no evaluation, no orders. Reconciliation of owned positions
 *              still runs.
 * - `SHADOW` — the full decision pipeline runs and every decision is
 *              recorded exactly as if trading; nothing reaches the broker.
 * - `DEMO`   — an approved decision is queued as a real order against the
 *              positively-verified DEMO account.
 */
export type SarExecutionMode = 'OFF' | 'SHADOW' | 'DEMO';

export function getSarExecutionMode(): SarExecutionMode {
  const raw = (process.env.XAUUSD_SAR_EXECUTION_MODE ?? '').trim().toUpperCase();
  if (raw === 'SHADOW') return 'SHADOW';
  if (raw === 'DEMO') return 'DEMO';
  return 'OFF';
}

/** True only when XAUUSD_SAR_ENABLED=true — deliberately off by default, like Engine B's switch. */
export function sarEngineEnabled(): boolean {
  return (process.env.XAUUSD_SAR_ENABLED ?? '').trim().toLowerCase() === 'true';
}

export function getSarKillSwitchPath(): string {
  return process.env.XAUUSD_SAR_KILL_SWITCH_PATH?.trim() || join(defaultStateDir(), 'XAUUSD_SAR_KILL_SWITCH');
}

export interface ControlState {
  readonly active: boolean;
  readonly source: string | null;
}

export function sarKillSwitchState(): ControlState {
  const path = getSarKillSwitchPath();
  if (existsSync(path)) return { active: true, source: `kill-switch file ${path}` };
  if ((process.env.XAUUSD_SAR_KILL_SWITCH ?? '').trim().toLowerCase() === 'true') {
    return { active: true, source: 'environment variable XAUUSD_SAR_KILL_SWITCH=true' };
  }
  if ((process.env.V2_GLOBAL_KILL_SWITCH ?? '').trim().toLowerCase() === 'true') {
    // The one shared, cross-strategy emergency stop already used by Engine A
    // (legacy) and Engine B. Honoured here too, deliberately: a single
    // "stop everything on this account" switch must actually stop everything.
    return { active: true, source: 'environment variable V2_GLOBAL_KILL_SWITCH=true' };
  }
  return { active: false, source: null };
}

/** New-entry gate: kill switch only. Does not include the mode — see xauusd-m1m5/controls.ts for why SHADOW must reach this point. */
export function sarEntriesBlockedByControls(): string | null {
  if (!sarEngineEnabled()) return 'XAUUSD_SAR_ENABLED is not true.';
  const kill = sarKillSwitchState();
  if (kill.active) return `Kill switch is active (${kill.source}).`;
  return null;
}

export function sarSubmissionBlockedReason(): string | null {
  const controls = sarEntriesBlockedByControls();
  if (controls !== null) return controls;
  const mode = getSarExecutionMode();
  if (mode === 'OFF') return 'Execution mode is OFF.';
  if (mode === 'SHADOW') return 'Execution mode is SHADOW - decisions are recorded but never queued.';
  return null;
}

export function isSarSubmissionEnabled(): boolean {
  return getSarExecutionMode() === 'DEMO';
}
