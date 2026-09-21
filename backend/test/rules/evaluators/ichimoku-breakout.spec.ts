import { describe, expect, it } from 'vitest';
import { evaluateIchimokuBreakout } from '../../../src/rules/evaluators/ichimoku-breakout.evaluator';
import { IchimokuBreakoutSignal } from '../../../src/rules/types/rule-engine.types';

const NOW = new Date('2026-09-05T12:00:00Z');

function breakout(overrides: Partial<IchimokuBreakoutSignal> = {}): IchimokuBreakoutSignal {
  return {
    timeframe: 'H1',
    direction: 'BULLISH',
    previousState: 'BELOW_CLOUD',
    newState: 'ABOVE_CLOUD',
    breakoutPrice: 1.105,
    timestamp: NOW.toISOString(),
    ...overrides,
  };
}

describe('evaluateIchimokuBreakout', () => {
  it('INSUFFICIENT_DATA when extras were never computed', () => {
    const result = evaluateIchimokuBreakout({}, { now: NOW });
    expect(result.status).toBe('INSUFFICIENT_DATA');
  });

  it('NOT_TRIGGERED when no breakout was detected on any watched timeframe', () => {
    const result = evaluateIchimokuBreakout({}, { ichimokuBreakouts: [], now: NOW });
    expect(result.status).toBe('NOT_TRIGGERED');
    expect(result.reasonCode).toBe('NO_FRESH_ICHIMOKU_BREAKOUT');
  });

  it('TRIGGERED for a breakout within the 15-minute freshness window', () => {
    const fresh = breakout({ timestamp: new Date(NOW.getTime() - 5 * 60_000).toISOString() });
    const result = evaluateIchimokuBreakout({}, { ichimokuBreakouts: [fresh], now: NOW });
    expect(result.status).toBe('TRIGGERED');
    expect(result.reasonCode).toBe('ICHIMOKU_BREAKOUT_DETECTED');
    expect(result.triggerValues).toMatchObject({ symbol: 'EURUSD', breakouts: [fresh] });
  });

  it('NOT_TRIGGERED for a breakout older than the 15-minute freshness window — prevents re-notifying on a stale event', () => {
    const stale = breakout({ timestamp: new Date(NOW.getTime() - 20 * 60_000).toISOString() });
    const result = evaluateIchimokuBreakout({}, { ichimokuBreakouts: [stale], now: NOW });
    expect(result.status).toBe('NOT_TRIGGERED');
  });

  it('a breakout exactly at the freshness boundary is still fresh (inclusive)', () => {
    const boundary = breakout({ timestamp: new Date(NOW.getTime() - 15 * 60_000).toISOString() });
    const result = evaluateIchimokuBreakout({}, { ichimokuBreakouts: [boundary], now: NOW });
    expect(result.status).toBe('TRIGGERED');
  });

  it('reports multiple simultaneous fresh breakouts across timeframes together', () => {
    const h1 = breakout({ timeframe: 'H1' });
    const h4 = breakout({ timeframe: 'H4', direction: 'BEARISH' });
    const result = evaluateIchimokuBreakout({}, { ichimokuBreakouts: [h1, h4], now: NOW });
    expect((result.triggerValues.breakouts as unknown[])).toHaveLength(2);
  });

  it('filters out only the stale ones when a mix of fresh and stale breakouts is present', () => {
    const fresh = breakout({ timeframe: 'M30' });
    const stale = breakout({ timeframe: 'D1', timestamp: new Date(NOW.getTime() - 60 * 60_000).toISOString() });
    const result = evaluateIchimokuBreakout({}, { ichimokuBreakouts: [fresh, stale], now: NOW });
    expect(result.status).toBe('TRIGGERED');
    expect((result.triggerValues.breakouts as IchimokuBreakoutSignal[]).map((b) => b.timeframe)).toEqual(['M30']);
  });
});
