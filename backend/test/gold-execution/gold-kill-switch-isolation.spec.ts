import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGoldKillSwitchPath, isGoldKillSwitchActive } from '../../src/gold-execution/gold-kill-switch';
import { getKillSwitchPath, isKillSwitchActive } from '../../src/autonomous/kill-switch';

/**
 * Proves the two kill switches are genuinely independent: toggling one must
 * never affect the other's read — the whole point of giving gold its own
 * file/env var (GOLD_KILL_SWITCH_PATH) instead of reusing
 * AUTONOMOUS_KILL_SWITCH_PATH.
 */
describe('gold kill switch isolation from the legacy autonomous kill switch', () => {
  let dir: string;
  let originalGoldPath: string | undefined;
  let originalLegacyPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gold-ks-isolation-'));
    originalGoldPath = process.env.GOLD_KILL_SWITCH_PATH;
    originalLegacyPath = process.env.AUTONOMOUS_KILL_SWITCH_PATH;
    process.env.GOLD_KILL_SWITCH_PATH = join(dir, 'GOLD_KILL_SWITCH');
    process.env.AUTONOMOUS_KILL_SWITCH_PATH = join(dir, 'KILL_SWITCH');
  });

  afterEach(() => {
    process.env.GOLD_KILL_SWITCH_PATH = originalGoldPath;
    process.env.AUTONOMOUS_KILL_SWITCH_PATH = originalLegacyPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('both start inactive', () => {
    expect(isGoldKillSwitchActive()).toBe(false);
    expect(isKillSwitchActive()).toBe(false);
  });

  it('engaging the LEGACY switch does not engage the gold switch', () => {
    writeFileSync(process.env.AUTONOMOUS_KILL_SWITCH_PATH as string, 'legacy engaged');
    expect(isKillSwitchActive()).toBe(true);
    expect(isGoldKillSwitchActive()).toBe(false);
  });

  it('engaging the GOLD switch does not engage the legacy switch', () => {
    writeFileSync(process.env.GOLD_KILL_SWITCH_PATH as string, 'gold engaged');
    expect(isGoldKillSwitchActive()).toBe(true);
    expect(isKillSwitchActive()).toBe(false);
  });

  it('the two paths never resolve to the same file even with defaults (different basenames)', () => {
    delete process.env.GOLD_KILL_SWITCH_PATH;
    delete process.env.AUTONOMOUS_KILL_SWITCH_PATH;
    // Re-import-free check: both default to a filename under process.cwd() —
    // GOLD_KILL_SWITCH vs KILL_SWITCH, distinct basenames by construction.
    const path1 = getGoldKillSwitchPath();
    const path2 = getKillSwitchPath();
    expect(path1).not.toBe(path2);
    expect(path1.endsWith('GOLD_KILL_SWITCH')).toBe(true);
    expect(path2.endsWith('KILL_SWITCH') && !path2.endsWith('GOLD_KILL_SWITCH')).toBe(true);
  });
});
