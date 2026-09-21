import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GoldAiSummaryService } from '../../src/gold-execution/gold-ai-summary.service';
import { getGoldKillSwitchPath } from '../../src/gold-execution/gold-kill-switch';

/**
 * Regression test for the 2026-09-15 contamination incident: test runs (and,
 * transitively, anything test/setup-env.ts governs) MUST NEVER write into
 * the real `backend/gold-execution-runtime/` directory. Before this fix,
 * GOLD_AI_SUMMARIES_PATH / GOLD_RUNTIME_SETTINGS_PATH / GOLD_KILL_SWITCH_PATH
 * were unset in `.env.test`, so their services fell back to
 * `join(process.cwd(), 'gold-execution-runtime', ...)` — from `backend/`
 * (this suite's cwd), that IS the real, operator-facing runtime directory a
 * live `/gold-demo` dashboard reads. Running `gold-execution-e2e.spec.ts` and
 * ad hoc manual verification of the protection-monitor pipeline both wrote
 * synthetic FILL_CONFIRMED (ticket=999) and MISSING_PROTECTION (positions
 * 771001-3 / 888001-3) entries straight into that real file.
 *
 * test/setup-env.ts now points all three paths at a per-worker temp
 * directory (mirroring the pre-existing AUTONOMOUS_KILL_SWITCH_PATH
 * isolation) before any test file's imports run. This spec asserts that
 * isolation is actually in effect for the current process, and would fail
 * immediately if it were ever removed or bypassed.
 */
describe('gold runtime file paths are isolated from the real repo during tests', () => {
  const realRuntimeDir = resolve(__dirname, '../../gold-execution-runtime');

  it('GOLD_AI_SUMMARIES_PATH (via the service default) does not resolve under the real gold-execution-runtime dir', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const path = (new GoldAiSummaryService({ enabled: false } as any) as any).getPath() as string;
    expect(path.startsWith(realRuntimeDir)).toBe(false);
  });

  it('GOLD_RUNTIME_SETTINGS_PATH env var is set and points outside the real gold-execution-runtime dir', () => {
    expect(process.env.GOLD_RUNTIME_SETTINGS_PATH).toBeTruthy();
    expect((process.env.GOLD_RUNTIME_SETTINGS_PATH as string).startsWith(realRuntimeDir)).toBe(false);
  });

  it('GOLD_KILL_SWITCH_PATH does not resolve to the real repo-root GOLD_KILL_SWITCH file', () => {
    const path = getGoldKillSwitchPath();
    const realKillSwitchPath = resolve(__dirname, '../../GOLD_KILL_SWITCH');
    expect(path).not.toBe(realKillSwitchPath);
  });
});
