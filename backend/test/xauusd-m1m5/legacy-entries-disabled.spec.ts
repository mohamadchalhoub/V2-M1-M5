/**
 * §2 and §15.6 — every removed strategy is incapable of submitting in this
 * copy, and no environment variable can re-enable one.
 *
 * The environment is set to the most permissive value each gate accepts
 * before the assertion, so these tests fail if a gate ever starts reading
 * its variable again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGoldExecutionMode } from '../../src/gold-execution/gold-execution-mode';
import { getTrendBreakoutExecutionMode } from '../../src/trend-breakout/trend-breakout-execution-mode';
import { entriesBlockedByControls, getRsiExecutionMode } from '../../src/xauusd-rsi/controls';
import {
  DISABLED_LEGACY_ENTRY_PATHS,
  LEGACY_ENTRIES_DISABLED_REASON,
  LEGACY_EXECUTION_MODE,
} from '../../src/xauusd-m1m5/legacy-entries-disabled';
import { XAUUSD_M1M5_STRATEGY_VERSION } from '../../src/xauusd-m1m5/spec';

const LEGACY_MODE_VARS = [
  'XAUUSD_RSI_EXECUTION_MODE',
  'GOLD_EXECUTION_MODE',
  'TREND_BREAKOUT_EXECUTION_MODE',
] as const;

describe('§2 legacy entry wiring is disabled in this copy', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of LEGACY_MODE_VARS) {
      saved.set(key, process.env[key]);
      // The most permissive value each gate ever accepted.
      process.env[key] = 'DEMO';
    }
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  it('the previous M1 RSI retest/extremes strategy cannot reach an active mode', () => {
    expect(process.env.XAUUSD_RSI_EXECUTION_MODE).toBe('DEMO');
    expect(getRsiExecutionMode()).toBe('OFF');
  });

  it('the H4 confirmed-retest gold strategy cannot reach an active mode', () => {
    expect(process.env.GOLD_EXECUTION_MODE).toBe('DEMO');
    expect(getGoldExecutionMode()).toBe('OFF');
  });

  it('trend-breakout cannot reach an active mode, for either instrument', () => {
    expect(process.env.TREND_BREAKOUT_EXECUTION_MODE).toBe('DEMO');
    expect(getTrendBreakoutExecutionMode()).toBe('OFF');
  });

  it.each(['DEMO', 'SHADOW', 'demo', 'shadow', 'true', ''])(
    'stays OFF whatever the environment says (%s)',
    (value) => {
      for (const key of LEGACY_MODE_VARS) process.env[key] = value;
      expect(getRsiExecutionMode()).toBe('OFF');
      expect(getGoldExecutionMode()).toBe('OFF');
      expect(getTrendBreakoutExecutionMode()).toBe('OFF');
    },
  );

  it('the previous strategy’s own control gate reports the mode as blocking', () => {
    // Its combined "may an entry be submitted?" answer must be a refusal,
    // which is what its risk gate consults before queuing anything.
    expect(entriesBlockedByControls()).toBe('Execution mode is OFF.');
  });

  it('exposes a single shared constant so the gates cannot drift apart', () => {
    expect(LEGACY_EXECUTION_MODE).toBe('OFF');
  });
});

describe('§14 the disabled-paths record is complete and attributed', () => {
  it('names every entry route §2 requires to be disabled', () => {
    const joined = DISABLED_LEGACY_ENTRY_PATHS.join(' | ');
    for (const fragment of [
      'H4 support/resistance',
      'confirmed-retest',
      'retest',
      'Extreme',
      'trend',
      'AI-assisted',
    ]) {
      expect(joined, `missing: ${fragment}`).toMatch(new RegExp(fragment, 'i'));
    }
  });

  it('attributes the disablement to this strategy, and says history is retained', () => {
    expect(LEGACY_ENTRIES_DISABLED_REASON).toContain(XAUUSD_M1M5_STRATEGY_VERSION);
    expect(LEGACY_ENTRIES_DISABLED_REASON).toMatch(/retained and readable/i);
    expect(LEGACY_ENTRIES_DISABLED_REASON).toMatch(/M1 and M5 execution paths/i);
  });
});
