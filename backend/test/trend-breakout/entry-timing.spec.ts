import { describe, expect, it } from 'vitest';
import { buildSignalRequestKey, checkGapChaseFilter, isSignalExpired, selectExecutablePrice, SETUP_EXPIRY_MS } from '../../src/trend-breakout/entry-timing';

describe('isSignalExpired', () => {
  const signalCloseAt = new Date('2026-01-01T00:00:00.000Z');

  it('is not expired before the 60s window elapses', () => {
    expect(isSignalExpired(signalCloseAt, new Date(signalCloseAt.getTime() + SETUP_EXPIRY_MS - 1))).toBe(false);
  });

  it('is expired at exactly 60s and beyond — "no entry AT OR AFTER expiry"', () => {
    expect(isSignalExpired(signalCloseAt, new Date(signalCloseAt.getTime() + SETUP_EXPIRY_MS))).toBe(true);
    expect(isSignalExpired(signalCloseAt, new Date(signalCloseAt.getTime() + SETUP_EXPIRY_MS + 5000))).toBe(true);
  });
});

describe('selectExecutablePrice', () => {
  it('BUY uses ask, SELL uses bid', () => {
    const quote = { bid: 1.1, ask: 1.1002, quotedAt: new Date() };
    expect(selectExecutablePrice('BUY', quote)).toBe(1.1002);
    expect(selectExecutablePrice('SELL', quote)).toBe(1.1);
  });
});

describe('checkGapChaseFilter', () => {
  it('passes when the executable price is within 0.25 x A of S.close', () => {
    const result = checkGapChaseFilter(1.1002, 1.1, 0.001); // drift 0.0002 <= 0.00025
    expect(result.passed).toBe(true);
  });

  it('fails when price has drifted beyond 0.25 x A', () => {
    const result = checkGapChaseFilter(1.1003, 1.1, 0.001); // drift 0.0003 > 0.00025
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/drifted/);
  });

  it('is symmetric for a negative drift', () => {
    const result = checkGapChaseFilter(1.0997, 1.1, 0.001); // drift 0.0003 > 0.00025
    expect(result.passed).toBe(false);
  });
});

describe('buildSignalRequestKey', () => {
  it('assembles a stable, unique-looking key from account/strategy/instrument/direction/time', () => {
    const key = buildSignalRequestKey('acct-1', 'h4-trend-h1-breakout-v1', 'EURUSD', 'BUY', new Date('2026-01-01T00:00:00.000Z'));
    expect(key).toBe('acct-1:h4-trend-h1-breakout-v1:EURUSD:BUY:2026-01-01T00:00:00.000Z');
  });
});
