import { describe, expect, it } from 'vitest';
import { isActionableLiveEvent, toGoldSignal } from '../../src/gold-execution/gold-signal-source';
import type { FirstReturnEvent } from '../../src/research/confirmed-retest-v2/types';

function baseEvent(overrides: Partial<FirstReturnEvent> = {}): FirstReturnEvent {
  return {
    id: 'evt-1',
    levelId: 'level-1',
    role: 'SUPPORT',
    levelPrice: 265032, // $2650.32, integer cents per v2's own convention
    generation: 1,
    kind: 'ORDINARY',
    period: 'STUDY',
    touchStartT: 1000,
    touchEndT: 2000,
    touchResolution: 'M1',
    beirut: { localIso: '2026-09-15T08:00:00', inWindow: true } as any,
    inWindow: true,
    direction: 'BUY',
    eligible: true,
    ineligibleReason: null,
    gapId: null,
    selection: null,
    d1Agreement: false,
    levelActivatedT: 500,
    outcome: null,
    observedAtT: 123456,
    ...overrides,
  };
}

describe('isActionableLiveEvent', () => {
  it('is actionable when observed live, eligible, in window, has a direction, and not already acted on', () => {
    expect(isActionableLiveEvent(baseEvent(), new Set())).toBe(true);
  });

  it('is NOT actionable when observedAtT is null (historical/backfilled, never a live touch)', () => {
    expect(isActionableLiveEvent(baseEvent({ observedAtT: null }), new Set())).toBe(false);
  });

  it('is NOT actionable when ineligible', () => {
    expect(isActionableLiveEvent(baseEvent({ eligible: false, ineligibleReason: 'GAP_CROSS' }), new Set())).toBe(false);
  });

  it('is NOT actionable when outside the entry window', () => {
    expect(isActionableLiveEvent(baseEvent({ inWindow: false }), new Set())).toBe(false);
  });

  it('is NOT actionable when already acted on in a prior cycle', () => {
    expect(isActionableLiveEvent(baseEvent(), new Set(['evt-1']))).toBe(false);
  });
});

describe('toGoldSignal', () => {
  it('maps a SUPPORT/BUY event to an OPEN_BUY signal with the level price converted from cents to dollars', () => {
    const signal = toGoldSignal(baseEvent(), 2650.5);
    expect(signal.action).toBe('OPEN_BUY');
    expect(signal.signalEntryPrice).toBeCloseTo(2650.32, 6);
    expect(signal.currentExecutablePrice).toBe(2650.5);
    expect(signal.levelId).toBe('level-1');
  });

  it('maps a RESISTANCE/SELL event to an OPEN_SELL signal', () => {
    const signal = toGoldSignal(baseEvent({ role: 'RESISTANCE', direction: 'SELL' }), 2649.9);
    expect(signal.action).toBe('OPEN_SELL');
  });

  it('refuses (never breakout-entries) a mismatched role/direction pair — defense in depth', () => {
    expect(() => toGoldSignal(baseEvent({ role: 'RESISTANCE', direction: 'BUY' }), 2650)).toThrow(/should never happen/);
  });

  it('throws rather than silently defaulting when direction is null', () => {
    expect(() => toGoldSignal(baseEvent({ direction: null as any }), 2650)).toThrow(/no direction/);
  });
});
