/**
 * Operator controls for `xauusd-m1-m5-rsi-threshold-v2`: execution mode, kill
 * switch, and the stop-new-entries pause.
 *
 * Every check reads fresh from disk or the environment on every call and is
 * never cached at import time. A safety control an operator flips must take
 * effect on the very next check, not on the next restart — that is the whole
 * reason a file-based control exists alongside the environment variable.
 *
 * ## Deliberately NOT sharing the previous strategy's controls
 *
 * The strategy this one sits alongside honours the older `GOLD_KILL_SWITCH`
 * and `GOLD_STOP_NEW_ENTRIES` files as well as its own, because it replaced
 * gold and inherited its operational habits.
 *
 * This strategy does not do that, and the difference is deliberate. Those
 * files live in a working directory, and an operator who engages a control
 * expects it to stop the thing they were thinking about — not two unrelated
 * systems at once, and not to leave them unsure which. This strategy has its
 * own controls, named after itself, and they govern only it.
 *
 * ## What a control does and does not stop
 *
 * Both controls block NEW ENTRIES only. Neither disables reconciliation,
 * protective management, or the Friday liquidation of this strategy's own
 * positions (§7, §9.3). An open position must still be protected and still be
 * closed before the weekend regardless of whether new entries are permitted —
 * a kill switch that abandoned an open position would be a worse outcome than
 * the one it was engaged to prevent.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * There is no REAL mode and no automatic real-account path — the type cannot
 * hold such a value, so no configuration mistake can produce one.
 *
 * - `OFF`    — no evaluation, no orders. Protective monitoring, reconciliation
 *              and Friday liquidation of owned positions still run.
 * - `SHADOW` — the full pipeline runs and every decision is recorded exactly
 *              as if trading, but nothing is ever queued for the broker.
 * - `DEMO`   — an approved decision is queued as a real order against the
 *              positively-verified DEMO account.
 */
export type M1M5ExecutionMode = 'OFF' | 'SHADOW' | 'DEMO';

export function getM1M5ExecutionMode(): M1M5ExecutionMode {
  const raw = (process.env.XAUUSD_M1M5_EXECUTION_MODE ?? '').trim().toUpperCase();
  if (raw === 'SHADOW') return 'SHADOW';
  if (raw === 'DEMO') return 'DEMO';
  // Fails closed to OFF for anything else — unset, a typo, "true" — so an
  // active mode is never reached by accident.
  return 'OFF';
}

export function getM1M5KillSwitchPath(): string {
  return process.env.XAUUSD_M1M5_KILL_SWITCH_PATH?.trim() || join(process.cwd(), 'XAUUSD_M1M5_KILL_SWITCH');
}

export function getM1M5StopNewEntriesPath(): string {
  return (
    process.env.XAUUSD_M1M5_STOP_NEW_ENTRIES_PATH?.trim() || join(process.cwd(), 'XAUUSD_M1M5_STOP_NEW_ENTRIES')
  );
}

export interface ControlState {
  readonly active: boolean;
  /** Which control is responsible, for an operator who needs to know what to undo. */
  readonly source: string | null;
}

export function killSwitchState(): ControlState {
  const path = getM1M5KillSwitchPath();
  if (existsSync(path)) return { active: true, source: `kill-switch file ${path}` };
  if ((process.env.XAUUSD_M1M5_KILL_SWITCH ?? '').trim().toLowerCase() === 'true') {
    return { active: true, source: 'environment variable XAUUSD_M1M5_KILL_SWITCH=true' };
  }
  return { active: false, source: null };
}

export function stopNewEntriesState(): ControlState {
  if ((process.env.XAUUSD_M1M5_STOP_NEW_ENTRIES ?? '').trim().toLowerCase() === 'true') {
    return { active: true, source: 'environment variable XAUUSD_M1M5_STOP_NEW_ENTRIES=true' };
  }
  const path = getM1M5StopNewEntriesPath();
  if (existsSync(path)) return { active: true, source: `stop-new-entries file ${path}` };
  return { active: false, source: null };
}

/**
 * Operator controls only: the kill switch and the stop-new-entries pause.
 * Deliberately EXCLUDES the execution mode.
 *
 * This is the function the pre-send gate uses, and the exclusion is the whole
 * reason it exists separately. SHADOW is specified to run the full pipeline
 * and record every decision exactly as if trading, stopping only at the
 * broker hand-off. If the mode were checked here, a SHADOW run would refuse
 * at the FIRST gate and never exercise signal age, quote freshness, entry
 * drift or bracket verification — so SHADOW would stop testing the very
 * things it exists to rehearse, and would quietly become a worse signal than
 * no rehearsal at all.
 *
 * The mode is enforced instead at the submission step, by
 * `isSubmissionEnabled()`, which is the last thing before the broker call.
 */
export function entriesBlockedByControls(): string | null {
  const kill = killSwitchState();
  if (kill.active) return `Kill switch is active (${kill.source}).`;
  const stop = stopNewEntriesState();
  if (stop.active) return `STOP NEW ENTRIES is active (${stop.source}).`;
  return null;
}

/**
 * The combined "may a new entry reach the broker?" answer, mode included.
 *
 * For the dashboard and for logging, where an operator asking "why is nothing
 * trading?" needs the mode in the answer. NOT for the pre-send gate — see
 * above.
 */
export function submissionBlockedReason(): string | null {
  const controls = entriesBlockedByControls();
  if (controls !== null) return controls;
  const mode = getM1M5ExecutionMode();
  if (mode === 'OFF') return 'Execution mode is OFF.';
  if (mode === 'SHADOW') return 'Execution mode is SHADOW - decisions are recorded but never queued.';
  return null;
}

/** True when the mode permits an order to actually reach the broker. */
export function isSubmissionEnabled(): boolean {
  return getM1M5ExecutionMode() === 'DEMO';
}
