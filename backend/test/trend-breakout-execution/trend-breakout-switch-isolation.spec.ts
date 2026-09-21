import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTrendBreakoutKillSwitchPath, isTrendBreakoutKillSwitchActive } from '../../src/trend-breakout/trend-breakout-kill-switch';
import { getStopNewEntriesFilePath, getTrendBreakoutExecutionMode, isStopNewEntriesActive } from '../../src/trend-breakout/trend-breakout-execution-mode';
import { getGoldKillSwitchPath, isGoldKillSwitchActive } from '../../src/gold-execution/gold-kill-switch';
import { isStopNewEntriesActive as isGoldStopNewEntriesActive } from '../../src/gold-execution/gold-execution-mode';
import { getKillSwitchPath, isKillSwitchActive } from '../../src/autonomous/kill-switch';

/**
 * Proves trend-breakout's switches (kill switch, stop-new-entries, mode)
 * never respond to gold's or the legacy EURUSD strategy's own files/env,
 * and vice versa — the whole point of giving trend-breakout its own
 * TREND_BREAKOUT_KILL_SWITCH_PATH / TREND_BREAKOUT_STOP_NEW_ENTRIES_PATH /
 * TREND_BREAKOUT_EXECUTION_MODE instead of reusing any existing one.
 */
describe('trend-breakout switch isolation from gold and the legacy EURUSD strategy', () => {
  let dir: string;
  const originalEnv: Record<string, string | undefined> = {};

  const ENV_KEYS = [
    'TREND_BREAKOUT_KILL_SWITCH_PATH', 'GOLD_KILL_SWITCH_PATH', 'AUTONOMOUS_KILL_SWITCH_PATH',
    'TREND_BREAKOUT_STOP_NEW_ENTRIES_PATH', 'GOLD_STOP_NEW_ENTRIES_PATH',
    'TREND_BREAKOUT_STOP_NEW_ENTRIES', 'GOLD_STOP_NEW_ENTRIES',
    'TREND_BREAKOUT_EXECUTION_MODE', 'GOLD_EXECUTION_MODE',
  ];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tb-switch-isolation-'));
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    process.env.TREND_BREAKOUT_KILL_SWITCH_PATH = join(dir, 'TREND_BREAKOUT_KILL_SWITCH');
    process.env.GOLD_KILL_SWITCH_PATH = join(dir, 'GOLD_KILL_SWITCH');
    process.env.AUTONOMOUS_KILL_SWITCH_PATH = join(dir, 'KILL_SWITCH');
    process.env.TREND_BREAKOUT_STOP_NEW_ENTRIES_PATH = join(dir, 'TREND_BREAKOUT_STOP_NEW_ENTRIES');
    process.env.GOLD_STOP_NEW_ENTRIES_PATH = join(dir, 'GOLD_STOP_NEW_ENTRIES');
    delete process.env.TREND_BREAKOUT_STOP_NEW_ENTRIES;
    delete process.env.GOLD_STOP_NEW_ENTRIES;
    delete process.env.TREND_BREAKOUT_EXECUTION_MODE;
    delete process.env.GOLD_EXECUTION_MODE;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('all three kill switches start inactive', () => {
    expect(isTrendBreakoutKillSwitchActive()).toBe(false);
    expect(isGoldKillSwitchActive()).toBe(false);
    expect(isKillSwitchActive()).toBe(false);
  });

  it('engaging the GOLD kill switch does not engage trend-breakout\'s', () => {
    writeFileSync(process.env.GOLD_KILL_SWITCH_PATH as string, 'gold engaged');
    expect(isGoldKillSwitchActive()).toBe(true);
    expect(isTrendBreakoutKillSwitchActive()).toBe(false);
  });

  it('engaging the LEGACY kill switch does not engage trend-breakout\'s', () => {
    writeFileSync(process.env.AUTONOMOUS_KILL_SWITCH_PATH as string, 'legacy engaged');
    expect(isKillSwitchActive()).toBe(true);
    expect(isTrendBreakoutKillSwitchActive()).toBe(false);
  });

  it('engaging trend-breakout\'s own kill switch does not engage gold\'s or the legacy one', () => {
    writeFileSync(process.env.TREND_BREAKOUT_KILL_SWITCH_PATH as string, 'tb engaged');
    expect(isTrendBreakoutKillSwitchActive()).toBe(true);
    expect(isGoldKillSwitchActive()).toBe(false);
    expect(isKillSwitchActive()).toBe(false);
  });

  it('trend-breakout stop-new-entries (env) does not activate gold\'s', () => {
    process.env.TREND_BREAKOUT_STOP_NEW_ENTRIES = 'true';
    expect(isStopNewEntriesActive()).toBe(true);
    expect(isGoldStopNewEntriesActive()).toBe(false);
  });

  it('trend-breakout stop-new-entries (file) does not activate gold\'s', () => {
    writeFileSync(getStopNewEntriesFilePath(), 'engaged');
    expect(isStopNewEntriesActive()).toBe(true);
    expect(isGoldStopNewEntriesActive()).toBe(false);
  });

  it('trend-breakout execution mode defaults to OFF and is independent of gold\'s own mode env var', () => {
    process.env.GOLD_EXECUTION_MODE = 'DEMO';
    expect(getTrendBreakoutExecutionMode()).toBe('OFF');
  });

  it('all default paths resolve to distinct basenames, never colliding even unset', () => {
    delete process.env.TREND_BREAKOUT_KILL_SWITCH_PATH;
    delete process.env.GOLD_KILL_SWITCH_PATH;
    delete process.env.AUTONOMOUS_KILL_SWITCH_PATH;
    const tb = getTrendBreakoutKillSwitchPath();
    const gold = getGoldKillSwitchPath();
    const legacy = getKillSwitchPath();
    expect(new Set([tb, gold, legacy]).size).toBe(3);
    expect(tb.endsWith('TREND_BREAKOUT_KILL_SWITCH')).toBe(true);
  });
});
