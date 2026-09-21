import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getKillSwitchPath, isKillSwitchActive } from '../../src/autonomous/kill-switch';

describe('isKillSwitchActive', () => {
  let dir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kill-switch-test-'));
    originalEnv = process.env.AUTONOMOUS_KILL_SWITCH_PATH;
    process.env.AUTONOMOUS_KILL_SWITCH_PATH = join(dir, 'KILL_SWITCH');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.AUTONOMOUS_KILL_SWITCH_PATH;
    else process.env.AUTONOMOUS_KILL_SWITCH_PATH = originalEnv;
  });

  it('is false when the kill switch file does not exist', () => {
    expect(isKillSwitchActive()).toBe(false);
  });

  it('is true once the kill switch file is created — the whole point is that no code path needs to create it, an operator just drops the file', () => {
    expect(isKillSwitchActive()).toBe(false);
    writeFileSync(getKillSwitchPath(), '');
    expect(isKillSwitchActive()).toBe(true);
  });

  it('falls back to a default path in the working directory when the env var is unset', () => {
    delete process.env.AUTONOMOUS_KILL_SWITCH_PATH;
    expect(getKillSwitchPath().endsWith('KILL_SWITCH')).toBe(true);
  });
});
