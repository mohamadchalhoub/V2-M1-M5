import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Gold-execution-only analog of `../autonomous/kill-switch.ts` — same
 * file-based, dependency-free semantics (no reliance on the backend,
 * Telegram, or the database being healthy), but pointed at its OWN path
 * (`GOLD_KILL_SWITCH_PATH`, default `GOLD_KILL_SWITCH` in the process's own
 * working directory) so that dropping the legacy `KILL_SWITCH` file does
 * NOT stop gold, and vice versa — the two strategies must stay fully
 * isolated. Read fresh on every call, not cached at import time, matching
 * the legacy implementation's own reasoning.
 */
export function getGoldKillSwitchPath(): string {
  return process.env.GOLD_KILL_SWITCH_PATH?.trim() || join(process.cwd(), 'GOLD_KILL_SWITCH');
}

export function isGoldKillSwitchActive(): boolean {
  return existsSync(getGoldKillSwitchPath());
}
