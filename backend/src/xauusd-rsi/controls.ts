/**
 * Operator controls for `xauusd-m1-rsi-retest-extremes-v1`: execution mode,
 * kill switch, and the stop-new-entries pause.
 *
 * Every check reads fresh from disk or the environment on every call and is
 * never cached at import time — a safety control an operator flips must take
 * effect on the very next check, not on the next restart.
 *
 * Spec §10 says to PRESERVE the existing gold pause and kill-switch controls,
 * so this module honours the established `GOLD_KILL_SWITCH` /
 * `GOLD_STOP_NEW_ENTRIES` files as well as its own strategy-scoped ones.
 * Either source being active is enough to block. That means the operator's
 * existing habits and the existing `stop-gold-demo.ps1` script keep working
 * against the new strategy, and it fails in the safe direction: adding a
 * control can only ever stop more, never less.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_EXECUTION_MODE } from '../xauusd-m1m5/legacy-entries-disabled';

/**
 * There is no REAL mode and no automatic real-account path — the type cannot
 * hold such a value, so no configuration mistake can produce one.
 *
 * - `OFF`   — no evaluation, no orders. Protective monitoring, reconciliation
 *             and Friday liquidation of owned positions still run.
 * - `SHADOW`— the full pipeline runs and every decision is recorded exactly
 *             as if trading, but nothing is ever queued for the broker.
 * - `DEMO`  — an approved decision is queued as a real order against the
 *             positively-verified demo account.
 */
export type RsiExecutionMode = 'OFF' | 'SHADOW' | 'DEMO';

export function getRsiExecutionMode(): RsiExecutionMode {
  // DISABLED IN THIS COPY (§2). This project runs
  // `xauusd-m1-m5-rsi-threshold-v2` as its only enabled strategy, so this
  // strategy's entry wiring is switched off here regardless of the
  // environment. `XAUUSD_RSI_EXECUTION_MODE=DEMO` has no effect.
  //
  // The environment variable is deliberately not read at all: leaving the
  // read in place and discarding the result would suggest the value still
  // matters somewhere. See `../xauusd-m1m5/legacy-entries-disabled.ts` for
  // why this is a code-level gate rather than a default, and for what
  // remains enabled (protection, reconciliation, liquidation, history).
  //
  // This does not affect the separate deployment of this same strategy that
  // runs from its own checkout on its own account.
  return LEGACY_EXECUTION_MODE;
}

export function getRsiKillSwitchPath(): string {
  return process.env.XAUUSD_RSI_KILL_SWITCH_PATH?.trim() || join(process.cwd(), 'XAUUSD_RSI_KILL_SWITCH');
}

/** The preserved, pre-existing gold kill switch. */
export function getLegacyGoldKillSwitchPath(): string {
  return process.env.GOLD_KILL_SWITCH_PATH?.trim() || join(process.cwd(), 'GOLD_KILL_SWITCH');
}

export interface ControlState {
  active: boolean;
  /** Which control is responsible, for an operator who needs to know what to undo. */
  source: string | null;
}

export function killSwitchState(): ControlState {
  const own = getRsiKillSwitchPath();
  if (existsSync(own)) return { active: true, source: `kill-switch file ${own}` };
  const legacy = getLegacyGoldKillSwitchPath();
  if (existsSync(legacy)) return { active: true, source: `preserved gold kill-switch file ${legacy}` };
  return { active: false, source: null };
}

export function isRsiKillSwitchActive(): boolean {
  return killSwitchState().active;
}

export function getRsiStopNewEntriesPath(): string {
  return process.env.XAUUSD_RSI_STOP_NEW_ENTRIES_PATH?.trim() || join(process.cwd(), 'XAUUSD_RSI_STOP_NEW_ENTRIES');
}

export function getLegacyGoldStopNewEntriesPath(): string {
  return process.env.GOLD_STOP_NEW_ENTRIES_PATH?.trim() || join(process.cwd(), 'GOLD_STOP_NEW_ENTRIES');
}

/**
 * A coarser switch than the mode itself, so entries can be frozen without
 * losing the SHADOW/DEMO distinction in the record. Re-checked immediately
 * before every send, never trusted from a value read earlier in the cycle.
 *
 * This NEVER disables protective closures, reconciliation, or Friday
 * liquidation for owned positions (spec §10) — it governs new entries only,
 * and the liquidation worker does not consult it.
 */
export function stopNewEntriesState(): ControlState {
  if ((process.env.XAUUSD_RSI_STOP_NEW_ENTRIES ?? '').trim().toLowerCase() === 'true') {
    return { active: true, source: 'environment variable XAUUSD_RSI_STOP_NEW_ENTRIES=true' };
  }
  if ((process.env.GOLD_STOP_NEW_ENTRIES ?? '').trim().toLowerCase() === 'true') {
    return { active: true, source: 'preserved environment variable GOLD_STOP_NEW_ENTRIES=true' };
  }
  const own = getRsiStopNewEntriesPath();
  if (existsSync(own)) return { active: true, source: `stop-new-entries file ${own}` };
  const legacy = getLegacyGoldStopNewEntriesPath();
  if (existsSync(legacy)) return { active: true, source: `preserved gold stop-new-entries file ${legacy}` };
  return { active: false, source: null };
}

export function isRsiStopNewEntriesActive(): boolean {
  return stopNewEntriesState().active;
}

/**
 * The combined "may a new entry be submitted?" control answer, as a reason
 * string suitable for the risk gate's `entriesBlockedReason`. Null means no
 * control is blocking; schedule, data and occupancy are checked separately.
 */
export function entriesBlockedByControls(): string | null {
  const kill = killSwitchState();
  if (kill.active) return `Kill switch is active (${kill.source}).`;
  const stop = stopNewEntriesState();
  if (stop.active) return `STOP NEW ENTRIES is active (${stop.source}).`;
  const mode = getRsiExecutionMode();
  if (mode === 'OFF') return 'Execution mode is OFF.';
  return null;
}
