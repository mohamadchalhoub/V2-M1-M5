/**
 * §15.3 ownership and §15.7 isolation.
 *
 * These are the tests that protect the OTHER application — the M1
 * revision-5 bot that is still running, on its own account, managing its own
 * positions. Everything here asserts a negative: that this code cannot
 * touch, adopt, relabel or claim something it does not own.
 */
import { describe, expect, it } from 'vitest';
import {
  assertMagicNumbersAreDisjoint,
  classifyForeign,
  describeOwnership,
  isOwnedByThisApplication,
  ownerForMagic,
  timeframeForPosition,
  V2_POSITION_OWNERS,
} from '../../src/xauusd-m1m5/ownership';
import {
  V2_DEFAULT_VOLUME_LOTS,
  V2_FOREIGN_MAGIC_NUMBERS,
  V2_MAGIC_M1,
  V2_MAGIC_M5,
  V2_MAGIC_NUMBERS,
  V2_SL_USD,
  V2_TP_USD,
  v2MagicForTimeframe,
  v2TimeframeForMagic,
} from '../../src/xauusd-m1m5/safety-constants';
import { SPEC, XAUUSD_M1M5_STRATEGY_VERSION } from '../../src/xauusd-m1m5/spec';

/** The magic numbers belonging to the still-running bot and the legacy deployments. */
const RUNNING_M1_BOT_MAGICS = [262610190, 262610191];
const LEGACY_MAGICS = [262610180, 262610181];

describe('§1 magic-number separation from the running bot', () => {
  it('claims exactly two magic numbers, one per timeframe', () => {
    expect(V2_MAGIC_NUMBERS).toEqual([V2_MAGIC_M1, V2_MAGIC_M5]);
    expect(new Set(V2_MAGIC_NUMBERS).size).toBe(2);
    expect(v2MagicForTimeframe('M1')).toBe(V2_MAGIC_M1);
    expect(v2MagicForTimeframe('M5')).toBe(V2_MAGIC_M5);
    expect(v2TimeframeForMagic(V2_MAGIC_M1)).toBe('M1');
    expect(v2TimeframeForMagic(V2_MAGIC_M5)).toBe('M5');
  });

  it('shares no magic number with the running M1 revision-5 bot', () => {
    for (const magic of RUNNING_M1_BOT_MAGICS) {
      expect(V2_MAGIC_NUMBERS).not.toContain(magic);
      expect(isOwnedByThisApplication(magic)).toBe(false);
    }
  });

  it('shares no magic number with the legacy deployments', () => {
    for (const magic of LEGACY_MAGICS) {
      expect(V2_MAGIC_NUMBERS).not.toContain(magic);
      expect(isOwnedByThisApplication(magic)).toBe(false);
    }
  });

  it('asserts disjointness at startup rather than trusting the constants', () => {
    expect(() => assertMagicNumbersAreDisjoint()).not.toThrow();
  });

  it('lists every known foreign magic so a future collision is caught', () => {
    for (const magic of [...RUNNING_M1_BOT_MAGICS, ...LEGACY_MAGICS]) {
      expect(V2_FOREIGN_MAGIC_NUMBERS).toContain(magic);
    }
  });
});

describe('§4/§9.3 nothing foreign is ever owned', () => {
  it('registers exactly two owners and no retired strategy', () => {
    expect(V2_POSITION_OWNERS).toHaveLength(2);
    expect(V2_POSITION_OWNERS.map((o) => o.timeframe).sort()).toEqual(['M1', 'M5']);
    expect(V2_POSITION_OWNERS.every((o) => o.strategyVersion === XAUUSD_M1M5_STRATEGY_VERSION)).toBe(true);
  });

  it('treats the running bot’s positions as foreign and untouchable', () => {
    for (const magic of RUNNING_M1_BOT_MAGICS) {
      expect(ownerForMagic(magic)).toBeNull();
      expect(timeframeForPosition(magic)).toBeNull();
      const foreign = classifyForeign(magic);
      expect(foreign?.kind).toBe('OTHER_BOT');
      expect(foreign?.detail).toMatch(/never closes, modifies, adopts or relabels/i);
    }
  });

  it('treats a manual position with no magic number as foreign', () => {
    for (const magic of [null, undefined]) {
      expect(isOwnedByThisApplication(magic)).toBe(false);
      expect(classifyForeign(magic)?.kind).toBe('MANUAL_OR_UNKNOWN');
      expect(describeOwnership(magic)).toMatch(/never closed or modified/i);
    }
  });

  it('treats an unrecognised magic number as foreign rather than guessing', () => {
    expect(isOwnedByThisApplication(999999)).toBe(false);
    expect(classifyForeign(999999)?.kind).toBe('MANUAL_OR_UNKNOWN');
  });

  it('never maps a foreign magic number onto a timeframe slot', () => {
    // This is what stops a foreign position from being counted as, or
    // mistaken for, this strategy's own M1 or M5 exposure.
    for (const magic of [...RUNNING_M1_BOT_MAGICS, ...LEGACY_MAGICS, 999999, null, undefined]) {
      expect(timeframeForPosition(magic)).toBeNull();
    }
  });

  it('describes its own positions with the timeframe visible', () => {
    expect(describeOwnership(V2_MAGIC_M1)).toMatch(/M1 path/);
    expect(describeOwnership(V2_MAGIC_M5)).toMatch(/M5 path/);
  });

  it('closing or remediating M1 can never resolve to M5', () => {
    expect(timeframeForPosition(V2_MAGIC_M1)).toBe('M1');
    expect(timeframeForPosition(V2_MAGIC_M5)).toBe('M5');
    expect(V2_MAGIC_M1).not.toBe(V2_MAGIC_M5);
  });
});

describe('§7 order parameters of a clean V2 installation', () => {
  it('defaults to 0.5 lot', () => {
    expect(V2_DEFAULT_VOLUME_LOTS).toBe(0.5);
  });

  it('uses $5.00 gold-price distances for both TP and SL', () => {
    expect(V2_TP_USD).toBe(5);
    expect(V2_SL_USD).toBe(5);
    expect(SPEC.brackets.takeProfitUsd).toBe(5);
    expect(SPEC.brackets.stopLossUsd).toBe(5);
  });

  it('applies the same brackets to both timeframes and both directions', () => {
    for (const owner of V2_POSITION_OWNERS) {
      expect(owner.takeProfitUsd).toBe(5);
      expect(owner.stopLossUsd).toBe(5);
    }
  });
});

describe('§2 the frozen spec describes exactly one enabled strategy', () => {
  it('identifies itself as the v2 threshold strategy', () => {
    expect(SPEC.strategyVersion).toBe('xauusd-m1-m5-rsi-threshold-v2');
    expect(SPEC.symbol).toBe('XAUUSD');
  });

  it('runs exactly two timeframe paths', () => {
    expect(SPEC.timeframes).toEqual(['M1', 'M5']);
  });

  it('caps exposure at one per timeframe and two in total', () => {
    expect(SPEC.occupancy.maxConcurrentEntriesPerTimeframe).toBe(1);
    expect(SPEC.occupancy.maxConcurrentEntriesTotal).toBe(2);
  });

  it('uses RSI(5) PRICE_CLOSE with Wilder smoothing', () => {
    expect(SPEC.rsi.period).toBe(5);
    expect(SPEC.rsi.appliedPrice).toBe('CLOSE');
    expect(SPEC.rsi.smoothing).toBe('WILDER');
  });

  it('defines only the two entry thresholds', () => {
    expect(SPEC.thresholds.sellCross).toBe(91);
    expect(SPEC.thresholds.buyCross).toBe(8.9);
    expect(Object.keys(SPEC.thresholds)).toEqual(['sellCross', 'buyCross']);
  });

  it('defines the four post-loss unlock values and binds them to unlocking only', () => {
    expect(SPEC.postLossUnlock.sell).toEqual({ rsiAtOrBelow: 25, rsiAtOrAbove: 98.5 });
    expect(SPEC.postLossUnlock.buy).toEqual({ rsiAtOrAbove: 75, rsiAtOrBelow: 1.5 });
  });

  it('targets a one-second observation cadence', () => {
    expect(SPEC.observation.targetIntervalMs).toBe(1000);
  });
});
