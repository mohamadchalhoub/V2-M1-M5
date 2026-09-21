import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_EXECUTION_MODE } from '../xauusd-m1m5/legacy-entries-disabled';

/**
 * OFF / SHADOW / DEMO control for the trend-breakout strategy, read fresh
 * from the environment on every check — same "never cache a
 * safety-relevant read" posture as `../gold-execution/gold-execution-mode.ts`
 * and `../autonomous/kill-switch.ts` — never `.env`-cached at import time,
 * so an operator can flip it without restarting anything that reads it
 * lazily. Deliberately separate from gold's own `GOLD_EXECUTION_MODE` and
 * EURUSD legacy autonomous's own switch — every strategy's activation
 * switch must never be coupled to another's.
 *
 * Covers BOTH trend-breakout instruments (EURUSD and XAUUSD) with a single
 * switch, not one per instrument — a shared "stop everything" lever is
 * safer to operate under incident pressure than remembering which
 * per-instrument file to touch, and both instruments are meant to go live
 * together.
 *
 * - OFF: no new entries, no order queued at all for either instrument.
 *   Protective monitoring of any already-open position (there should never
 *   be one while OFF, but if one exists from a prior mode, monitoring still
 *   applies) continues.
 * - SHADOW: full pipeline runs (signal -> risk gates) and every decision is
 *   logged exactly as if trading, but no order is ever queued for the
 *   collector to execute, and no instrument slot lock is claimed.
 * - DEMO: an approved decision is queued as a real PENDING order for the
 *   collector to pick up and place on the (positively verified) demo
 *   account. There is no fourth mode and no automatic real-account path —
 *   REAL is not a value this type can even hold.
 */
export type TrendBreakoutExecutionMode = 'OFF' | 'SHADOW' | 'DEMO';

export function getTrendBreakoutExecutionMode(): TrendBreakoutExecutionMode {
  // DISABLED IN THIS COPY (§2). This project runs
  // `xauusd-m1-m5-rsi-threshold-v2` as its only enabled strategy, so
  // trend-breakout's entry wiring — for BOTH instruments — is switched off
  // here regardless of the environment. `TREND_BREAKOUT_EXECUTION_MODE=DEMO`
  // has no effect.
  //
  // See `../xauusd-m1m5/legacy-entries-disabled.ts` for why this is a
  // code-level gate rather than a default, and for what remains enabled
  // (protection, reconciliation, liquidation, history).
  return LEGACY_EXECUTION_MODE;
}

/**
 * STOP NEW ENTRIES — a separate, coarser switch than the mode itself, so an
 * operator can freeze new entries for both instruments without changing the
 * mode (and losing the SHADOW/DEMO distinction for logging). Re-checked
 * immediately before every send, per the same posture as gold-execution —
 * callers must call this again right before queuing, not rely on a value
 * read earlier in the same cycle.
 *
 * Checks a file-based toggle in addition to the env var — the env var is
 * fixed at process start and cannot be flipped live without a restart, but
 * the dashboard's "stop/resume new entries" control needs a lever that
 * takes effect on the very next check. Either one being active is enough to
 * stop new entries.
 */
export function isStopNewEntriesActive(): boolean {
  if ((process.env.TREND_BREAKOUT_STOP_NEW_ENTRIES ?? '').trim().toLowerCase() === 'true') return true;
  return existsSync(getStopNewEntriesFilePath());
}

export function getStopNewEntriesFilePath(): string {
  return process.env.TREND_BREAKOUT_STOP_NEW_ENTRIES_PATH?.trim() || join(process.cwd(), 'TREND_BREAKOUT_STOP_NEW_ENTRIES');
}
