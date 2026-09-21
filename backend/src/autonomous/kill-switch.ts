import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Plan §6, path 3 of 3 (file-based) — deliberately the one that doesn't
 * depend on the backend, Telegram, or the database being healthy: a plain
 * filesystem check, nothing else. `AUTONOMOUS_KILL_SWITCH_PATH` lets the
 * deployed path be explicit (e.g. a fixed location on the VPS) without
 * hardcoding a path that only makes sense on one machine; defaults to
 * `KILL_SWITCH` in the process's own working directory for local/dev use.
 * Read fresh on every call, not cached at import time — simpler to reason
 * about (an operator dropping the file mid-process is picked up on the
 * very next check, and it happens to make this trivial to unit-test too).
 *
 * The other two paths (Telegram `/stop`, a dashboard button) don't exist
 * yet — this is the simplest and most foundational of the three, built
 * first on purpose, matching the plan's own framing of it as the one that
 * must keep working even when everything else is degraded.
 */
export function getKillSwitchPath(): string {
  return process.env.AUTONOMOUS_KILL_SWITCH_PATH?.trim() || join(process.cwd(), 'KILL_SWITCH');
}

export function isKillSwitchActive(): boolean {
  return existsSync(getKillSwitchPath());
}
