import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * OFF / SHADOW / DEMO control for the gold strategy, read fresh from the
 * environment on every check (same "never cache a safety-relevant read"
 * posture as autonomous/kill-switch.ts) — never `.env`-cached at import
 * time, so an operator can flip it without restarting anything that reads
 * it lazily. Deliberately separate from EURUSD's own
 * AUTONOMOUS_EXECUTION_ENABLED boolean — the two strategies' activation
 * switches must never be coupled.
 *
 * - OFF: no new entries, no order queued at all. Protective monitoring of
 *   any already-open position (there should never be one while OFF, but
 *   if one exists from a prior mode, monitoring still applies) continues.
 * - SHADOW: full pipeline runs (signal -> risk gate) and every decision is
 *   logged exactly as if trading, but no order is ever queued for the
 *   collector to execute.
 * - DEMO: an approved decision is queued as a real PENDING order for the
 *   collector to pick up and place on the (positively verified) demo
 *   account. There is no fourth mode and no automatic real-account path —
 *   REAL is not a value this type can even hold.
 */
export type GoldExecutionMode = 'OFF' | 'SHADOW' | 'DEMO';

export function getGoldExecutionMode(): GoldExecutionMode {
  const raw = (process.env.GOLD_EXECUTION_MODE ?? 'OFF').trim().toUpperCase();
  if (raw === 'SHADOW') return 'SHADOW';
  if (raw === 'DEMO') return 'DEMO';
  // Fails closed to OFF for anything else (unset, typo, "true", etc.) —
  // never silently defaults to an active mode.
  return 'OFF';
}

/**
 * STOP NEW ENTRIES — a separate, coarser switch than the mode itself, so an
 * operator can freeze new entries without changing the mode (and losing
 * the SHADOW/DEMO distinction for logging). Re-checked immediately before
 * every send, per task requirement — callers must call this again right
 * before queuing, not rely on a value read earlier in the same cycle.
 */
/**
 * Extended (task item F) to ALSO check a file-based toggle, in addition to
 * the original env var — `GOLD_STOP_NEW_ENTRIES` is a raw env var read from
 * `process.env`, which is fixed at process start and cannot be flipped live
 * without a restart. The dashboard's "stop/resume new entries" control
 * needs a lever that takes effect on the very next check, same posture as
 * the kill switch (`gold-kill-switch.ts`) — so a file's mere existence at
 * `GOLD_STOP_NEW_ENTRIES_PATH` (default `GOLD_STOP_NEW_ENTRIES` under the
 * backend working directory) is checked fresh on every call and ORed with
 * the env var. Either one being active is enough to stop new entries.
 */
export function isStopNewEntriesActive(): boolean {
  if ((process.env.GOLD_STOP_NEW_ENTRIES ?? '').trim().toLowerCase() === 'true') return true;
  return existsSync(getStopNewEntriesFilePath());
}

export function getStopNewEntriesFilePath(): string {
  return process.env.GOLD_STOP_NEW_ENTRIES_PATH?.trim() || join(process.cwd(), 'GOLD_STOP_NEW_ENTRIES');
}
