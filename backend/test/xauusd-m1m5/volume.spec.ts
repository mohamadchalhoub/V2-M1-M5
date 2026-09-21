/**
 * §15.6 — volume resolution and broker validation.
 *
 * The property that matters most is a negative one: nothing here ever
 * silently changes the size that will be traded. A bad configured value
 * falls back to the documented default and says so; a size the broker cannot
 * accept is refused with a reason rather than rounded into acceptability.
 */
import { describe, expect, it } from 'vitest';
import { resolveVolume, validateVolume, type BrokerVolumeLimits } from '../../src/xauusd-m1m5/volume';
import { V2_DEFAULT_VOLUME_LOTS } from '../../src/xauusd-m1m5/safety-constants';
import { XAUUSD_M1M5_STRATEGY_VERSION } from '../../src/xauusd-m1m5/spec';

const GOLD_LIMITS: BrokerVolumeLimits = { min: 0.01, max: 100, step: 0.01 };

describe('§7 the clean-installation default', () => {
  it('is 0.5 lot', () => {
    expect(V2_DEFAULT_VOLUME_LOTS).toBe(0.5);
  });

  it.each([null, undefined, '', '   '])('applies when nothing is configured (%s)', (value) => {
    const r = resolveVolume(value as string | null | undefined);
    expect(r.lots).toBe(0.5);
    expect(r.source).toBe('V2_DEFAULT');
    expect(r.rejectedValue).toBeNull();
  });

  it('records provenance naming this strategy, not an inherited setting', () => {
    const r = resolveVolume(null);
    expect(r.provenance).toContain(XAUUSD_M1M5_STRATEGY_VERSION);
    expect(r.provenance).toMatch(/clean-installation default/i);
  });
});

describe('§7 an explicit setting is accepted and attributed', () => {
  it.each([
    ['0.01', 0.01],
    ['0.5', 0.5],
    ['1', 1],
    [2.5, 2.5],
  ])('accepts %s', (input, expected) => {
    const r = resolveVolume(input as string | number);
    expect(r.lots).toBe(expected);
    expect(r.source).toBe('V2_EXPLICIT_SETTING');
    expect(r.provenance).toContain(XAUUSD_M1M5_STRATEGY_VERSION);
  });

  it('states that the value is still broker-validated per order', () => {
    expect(resolveVolume('0.5').provenance).toMatch(/validated against live broker min\/max\/step/i);
  });
});

describe('§7 a bad setting falls back loudly, never quietly', () => {
  it.each([
    ['not-a-number', 'not a number'],
    ['0', 'not positive'],
    ['-1', 'not positive'],
    ['abc', 'not a number'],
  ])('refuses %s and records why', (input, reason) => {
    const r = resolveVolume(input);
    expect(r.lots).toBe(V2_DEFAULT_VOLUME_LOTS);
    expect(r.source).toBe('V2_DEFAULT_AFTER_REJECTION');
    expect(r.rejectedValue).toBe(input);
    expect(r.rejectionReason).toBe(reason);
  });

  it('states explicitly that the configured value was not adjusted', () => {
    expect(resolveVolume('-3').provenance).toMatch(/NOT adjusted/i);
  });
});

describe('§7 broker validation refuses rather than rounds', () => {
  it('accepts the default against realistic gold limits', () => {
    expect(validateVolume(0.5, GOLD_LIMITS)).toEqual({ acceptable: true, reason: null });
  });

  it('accepts a volume at each boundary', () => {
    expect(validateVolume(GOLD_LIMITS.min, GOLD_LIMITS).acceptable).toBe(true);
    expect(validateVolume(GOLD_LIMITS.max, GOLD_LIMITS).acceptable).toBe(true);
  });

  it('refuses a volume below the broker minimum', () => {
    const v = validateVolume(0.005, GOLD_LIMITS);
    expect(v.acceptable).toBe(false);
    expect(v.reason).toMatch(/below the broker minimum/i);
  });

  it('refuses a volume above the broker maximum', () => {
    const v = validateVolume(101, GOLD_LIMITS);
    expect(v.acceptable).toBe(false);
    expect(v.reason).toMatch(/above the broker maximum/i);
  });

  it('refuses a volume off the broker step, and says it will not round', () => {
    const v = validateVolume(0.505, GOLD_LIMITS);
    expect(v.acceptable).toBe(false);
    expect(v.reason).toMatch(/not a multiple of the broker volume step/i);
    expect(v.reason).toMatch(/silently resizing/i);
  });

  it('does not reject valid volumes to floating-point error', () => {
    // 0.5 / 0.01 is 49.999999999999993 in IEEE 754, so a naive modulo test
    // rejects the strategy's own default. Every one of these is valid.
    for (const lots of [0.01, 0.02, 0.03, 0.07, 0.1, 0.29, 0.5, 1.11, 3.33, 99.99]) {
      expect(validateVolume(lots, GOLD_LIMITS), `lots=${lots}`).toEqual({ acceptable: true, reason: null });
    }
  });

  it('handles a broker with a coarser step', () => {
    const coarse: BrokerVolumeLimits = { min: 0.1, max: 50, step: 0.1 };
    expect(validateVolume(0.5, coarse).acceptable).toBe(true);
    expect(validateVolume(0.55, coarse).acceptable).toBe(false);
  });

  it('refuses a non-positive or non-finite volume', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateVolume(bad, GOLD_LIMITS).acceptable, `lots=${bad}`).toBe(false);
    }
  });

  it('never returns a corrected number — only a verdict', () => {
    const v = validateVolume(0.505, GOLD_LIMITS) as unknown as Record<string, unknown>;
    expect(Object.keys(v).sort()).toEqual(['acceptable', 'reason']);
  });
});
