import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * trend-breakout-only analog of `../gold-execution/gold-kill-switch.ts` and
 * `../autonomous/kill-switch.ts` — same file-based, dependency-free
 * semantics, but pointed at its OWN path (`TREND_BREAKOUT_KILL_SWITCH_PATH`,
 * default `TREND_BREAKOUT_KILL_SWITCH` in the process's own working
 * directory) so that dropping the gold or legacy kill-switch files does NOT
 * stop trend-breakout, and vice versa — the three strategies must stay
 * fully isolated. Read fresh on every call, never cached at import time.
 */
export function getTrendBreakoutKillSwitchPath(): string {
  return process.env.TREND_BREAKOUT_KILL_SWITCH_PATH?.trim() || join(process.cwd(), 'TREND_BREAKOUT_KILL_SWITCH');
}

export function isTrendBreakoutKillSwitchActive(): boolean {
  return existsSync(getTrendBreakoutKillSwitchPath());
}
