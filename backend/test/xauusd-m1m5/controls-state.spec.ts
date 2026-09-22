/**
 * §7/§10/§14 — operator controls and the durable observation state.
 *
 * Two behaviours matter most here and are both negatives:
 *
 * - a control blocks NEW ENTRIES and nothing else, so reconciliation,
 *   protective management and Friday liquidation keep running;
 * - this strategy's controls govern only this strategy, and do not read the
 *   older strategy's control files.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  entriesBlockedByControls,
  getM1M5ExecutionMode,
  getM1M5KillSwitchPath,
  getM1M5StopNewEntriesPath,
  isSubmissionEnabled,
  killSwitchState,
  stopNewEntriesState,
  submissionBlockedReason,
} from '../../src/xauusd-m1m5/controls';
import {
  heartbeatIsFresh,
  readWatchState,
  writeWatchState,
  HEARTBEAT_STALE_AFTER_MS,
  type WatchState,
} from '../../src/xauusd-m1m5/state-store';
import { createCrossingState } from '../../src/xauusd-m1m5/crossing';
import { createEngineState } from '../../src/xauusd-m1m5/engine';
import { SPEC_HASH, XAUUSD_M1M5_STRATEGY_VERSION } from '../../src/xauusd-m1m5/spec';

const ENV_KEYS = [
  'XAUUSD_M1M5_EXECUTION_MODE',
  'XAUUSD_M1M5_KILL_SWITCH',
  'XAUUSD_M1M5_KILL_SWITCH_PATH',
  'XAUUSD_M1M5_STOP_NEW_ENTRIES',
  'XAUUSD_M1M5_STOP_NEW_ENTRIES_PATH',
  'XAUUSD_M1M5_STATE_DIR',
  // The OLDER strategy's controls, set deliberately in one test to prove
  // they are NOT consulted here.
  'GOLD_KILL_SWITCH',
  'GOLD_STOP_NEW_ENTRIES',
  'XAUUSD_RSI_STOP_NEW_ENTRIES',
] as const;

let saved: Record<string, string | undefined>;
let tempDir: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  tempDir = mkdtempSync(join(tmpdir(), 'm1m5-state-'));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('§14 execution mode fails closed', () => {
  it('defaults to OFF when unset', () => {
    expect(getM1M5ExecutionMode()).toBe('OFF');
    expect(isSubmissionEnabled()).toBe(false);
  });

  it.each(['DEMO', 'demo', ' DEMO '])('accepts %s as DEMO', (value) => {
    process.env.XAUUSD_M1M5_EXECUTION_MODE = value;
    expect(getM1M5ExecutionMode()).toBe('DEMO');
    expect(isSubmissionEnabled()).toBe(true);
  });

  it('accepts SHADOW, which records but never submits', () => {
    process.env.XAUUSD_M1M5_EXECUTION_MODE = 'SHADOW';
    expect(getM1M5ExecutionMode()).toBe('SHADOW');
    expect(isSubmissionEnabled()).toBe(false);
    // The MODE is reported by submissionBlockedReason, not by
    // entriesBlockedByControls. That split is deliberate: the pre-send gate
    // uses the latter, and if the mode blocked there, a SHADOW run would
    // refuse at the first gate and never rehearse signal age, quote
    // freshness, entry drift or bracket verification -- the very checks
    // SHADOW exists to exercise.
    expect(submissionBlockedReason()).toMatch(/recorded but never queued/i);
    expect(entriesBlockedByControls()).toBeNull();
  });

  it.each(['REAL', 'LIVE', 'true', 'yes', 'dem0', ''])('falls closed to OFF for %s', (value) => {
    process.env.XAUUSD_M1M5_EXECUTION_MODE = value;
    expect(getM1M5ExecutionMode()).toBe('OFF');
    expect(isSubmissionEnabled()).toBe(false);
  });
});

describe('§7 controls block new entries and name themselves', () => {
  it('reports a kill switch engaged by file, with the path', () => {
    const path = join(tempDir, 'KILL');
    writeFileSync(path, '');
    process.env.XAUUSD_M1M5_KILL_SWITCH_PATH = path;

    const state = killSwitchState();
    expect(state.active).toBe(true);
    expect(state.source).toContain(path);
    expect(entriesBlockedByControls()).toMatch(/Kill switch is active/);
  });

  it('reports a kill switch engaged by environment variable', () => {
    process.env.XAUUSD_M1M5_KILL_SWITCH = 'true';
    expect(killSwitchState().active).toBe(true);
  });

  it('reports stop-new-entries engaged by file or environment', () => {
    process.env.XAUUSD_M1M5_STOP_NEW_ENTRIES = 'true';
    expect(stopNewEntriesState().active).toBe(true);
    expect(entriesBlockedByControls()).toMatch(/STOP NEW ENTRIES is active/);
  });

  it('reports the kill switch ahead of the softer pause', () => {
    process.env.XAUUSD_M1M5_KILL_SWITCH = 'true';
    process.env.XAUUSD_M1M5_STOP_NEW_ENTRIES = 'true';
    expect(entriesBlockedByControls()).toMatch(/Kill switch/);
  });

  it('is clear when nothing is engaged and the mode permits submission', () => {
    process.env.XAUUSD_M1M5_EXECUTION_MODE = 'DEMO';
    expect(killSwitchState().active).toBe(false);
    expect(stopNewEntriesState().active).toBe(false);
    expect(entriesBlockedByControls()).toBeNull();
    expect(submissionBlockedReason()).toBeNull();
  });

  it('reports OFF as a submission block but not as a control block', () => {
    process.env.XAUUSD_M1M5_EXECUTION_MODE = 'OFF';
    expect(submissionBlockedReason()).toBe('Execution mode is OFF.');
    expect(entriesBlockedByControls()).toBeNull();
  });
});

describe('§1 this strategy’s controls govern only this strategy', () => {
  it('does not read the older strategy’s control variables', () => {
    process.env.XAUUSD_M1M5_EXECUTION_MODE = 'DEMO';
    process.env.GOLD_KILL_SWITCH = 'true';
    process.env.GOLD_STOP_NEW_ENTRIES = 'true';
    process.env.XAUUSD_RSI_STOP_NEW_ENTRIES = 'true';

    // Engaging the other strategy's controls must not silently stop this one:
    // an operator stopping that strategy is not asking to stop this one, and
    // a control whose scope is ambiguous is worse than no control.
    expect(killSwitchState().active).toBe(false);
    expect(stopNewEntriesState().active).toBe(false);
    expect(entriesBlockedByControls()).toBeNull();
  });
});

describe('§10 durable observation state', () => {
  function sampleState(over: Partial<WatchState> = {}): WatchState {
    return {
      strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
      specHash: SPEC_HASH,
      accountId: 'acct-1',
      lastCycleAtMs: Date.now(),
      lastCycleIntervalMs: 1000,
      lastSubmissionLatencyMs: 240,
      engines: { M1: createEngineState('M1'), M5: createEngineState('M5') },
      crossings: { M1: createCrossingState('M1', SPEC_HASH), M5: createCrossingState('M5', SPEC_HASH) },
      observationLimitations: [],
      recoveryCompleteAtMs: Date.now(),
      ...over,
    };
  }

  it('round-trips state through disk', () => {
    const state = sampleState();
    writeWatchState(state, tempDir);
    const read = readWatchState(tempDir);
    expect(read?.accountId).toBe('acct-1');
    expect(read?.engines.M1.timeframe).toBe('M1');
    expect(read?.engines.M5.timeframe).toBe('M5');
  });

  it('returns null when no state exists', () => {
    expect(readWatchState(tempDir)).toBeNull();
  });

  it('refuses state written under different rules rather than migrating it', () => {
    writeWatchState(sampleState({ specHash: 'deadbeefdeadbeef' }), tempDir);
    expect(readWatchState(tempDir)).toBeNull();
  });

  it('refuses state written by a different strategy version', () => {
    writeWatchState(sampleState({ strategyVersion: 'some-other-strategy' }), tempDir);
    expect(readWatchState(tempDir)).toBeNull();
  });

  it('treats a corrupt file as absent rather than parsing around the damage', () => {
    writeWatchState(sampleState(), tempDir);
    writeFileSync(join(tempDir, 'watch-state.json'), '{ "specHash": "trunc');
    expect(readWatchState(tempDir)).toBeNull();
  });

  it('reports a stale heartbeat as stale', () => {
    const now = Date.now();
    expect(heartbeatIsFresh(sampleState({ lastCycleAtMs: now }), now)).toBe(true);
    expect(heartbeatIsFresh(sampleState({ lastCycleAtMs: now - HEARTBEAT_STALE_AFTER_MS }), now)).toBe(true);
    expect(heartbeatIsFresh(sampleState({ lastCycleAtMs: now - HEARTBEAT_STALE_AFTER_MS - 1 }), now)).toBe(false);
    expect(heartbeatIsFresh(null, now)).toBe(false);
  });

  it('keeps observation and submission latency as separate figures', () => {
    // A one-second observation loop does not imply a one-second order-polling
    // loop, so the two are never conflated into one number.
    const state = sampleState({ lastCycleIntervalMs: 1000, lastSubmissionLatencyMs: 4200 });
    writeWatchState(state, tempDir);
    const read = readWatchState(tempDir)!;
    expect(read.lastCycleIntervalMs).toBe(1000);
    expect(read.lastSubmissionLatencyMs).toBe(4200);
  });
});

describe('the control files are shared between containers', () => {
  // The API and the scheduler run in separate containers that share ONLY the
  // state-directory volume. A control file anywhere else is private to the
  // container that wrote it -- so a kill switch engaged from the API would be
  // invisible to the scheduler, which would keep trading while the API
  // reported the switch as on.
  it('puts the kill switch inside the state directory by default', () => {
    process.env.XAUUSD_M1M5_STATE_DIR = tempDir;
    expect(getM1M5KillSwitchPath()).toBe(join(tempDir, 'XAUUSD_M1M5_KILL_SWITCH'));
  });

  it('puts stop-new-entries inside the state directory by default', () => {
    process.env.XAUUSD_M1M5_STATE_DIR = tempDir;
    expect(getM1M5StopNewEntriesPath()).toBe(join(tempDir, 'XAUUSD_M1M5_STOP_NEW_ENTRIES'));
  });

  it('is honoured when a file appears in the shared directory', () => {
    // What the scheduler does after an operator touches the file via the API.
    process.env.XAUUSD_M1M5_STATE_DIR = tempDir;
    expect(killSwitchState().active).toBe(false);
    writeFileSync(join(tempDir, 'XAUUSD_M1M5_KILL_SWITCH'), '');
    expect(killSwitchState().active).toBe(true);
    expect(entriesBlockedByControls()).not.toBeNull();
  });
});
