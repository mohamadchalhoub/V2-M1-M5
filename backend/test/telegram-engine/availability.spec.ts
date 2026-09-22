/**
 * What Engine B still requires, now that it requires no schedule.
 *
 * The distinction every case here turns on: these are ACCOUNT-level facts
 * shared by both engines because both use one MT5 account, not Engine A
 * strategy rules under another name. A closed market is physics; a 14:00
 * pause is a rule, and only one of them appears in this file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateTelegramAvailability } from '../../src/telegram-engine/availability';
import type { Mt5PermissionSnapshot } from '../../src/xauusd-m1m5/mt5-readiness';

const NOW = Date.UTC(2026, 8, 23, 16, 0, 0);
const LOGIN = '5039912345';

function snapshot(over: Partial<Mt5PermissionSnapshot> = {}): Mt5PermissionSnapshot {
  return {
    capturedAtMs: NOW - 1_000,
    loginId: LOGIN,
    tradeMode: 'DEMO',
    terminalConnected: true,
    terminalTradeAllowed: true,
    terminalTradeApiDisabled: false,
    accountTradeAllowed: true,
    accountTradeExpert: true,
    marginMode: 'RETAIL_HEDGING',
    ...over,
  };
}

function evaluate(over: Partial<Parameters<typeof evaluateTelegramAvailability>[0]> = {}) {
  return evaluateTelegramAvailability({
    nowMs: NOW,
    snapshot: snapshot(),
    expectedLoginId: LOGIN,
    symbolSessionOpen: true,
    symbolTradable: true,
    quote: { bid: 4337.5, ask: 4338.0, tickAtMs: NOW - 500 },
    recoveryComplete: true,
    ...over,
  });
}

afterEach(() => {
  delete process.env.V2_GLOBAL_KILL_SWITCH;
  delete process.env.TELEGRAM_ENGINE_KILL_SWITCH;
});

describe('a healthy account at 16:00 Beirut — inside the RSI engine’s pause', () => {
  it('is available', () => {
    const v = evaluate();
    expect(v.available).toBe(true);
    expect(v.block).toBeNull();
  });

  it('says so in terms that name the pauses it is NOT applying', () => {
    expect(evaluate().detail).toMatch(/14:00.*19:00/);
  });
});

describe('a closed market is terminal, never a queue', () => {
  it('refuses with TELEGRAM_MARKET_CLOSED when the broker session is closed', () => {
    const v = evaluate({ symbolSessionOpen: false });
    expect(v.block).toBe('TELEGRAM_MARKET_CLOSED');
    expect(v.marketClosed).toBe(true);
  });

  it('says explicitly that the signal is not replayed at reopening', () => {
    expect(evaluate({ symbolSessionOpen: false }).detail).toMatch(/never queued and never replayed/i);
  });

  it('treats an UNKNOWN session as closed, because unknown must block rather than permit', () => {
    const v = evaluate({ symbolSessionOpen: null });
    expect(v.block).toBe('TELEGRAM_MARKET_CLOSED');
    expect(v.marketClosed).toBe(true);
  });

  it('distinguishes a closed session from a symbol the broker will not let us trade', () => {
    expect(evaluate({ symbolTradable: false }).block).toBe('TELEGRAM_SYMBOL_NOT_TRADABLE');
    expect(evaluate({ symbolTradable: null }).block).toBe('TELEGRAM_SYMBOL_NOT_TRADABLE');
  });
});

describe('shared MT5 safety still applies', () => {
  it.each([
    ['no snapshot at all', { snapshot: null }],
    ['a stale snapshot', { snapshot: snapshot({ capturedAtMs: NOW - 10 * 60_000 }) }],
    ['the wrong account', { expectedLoginId: '9999999' }],
    ['a live account rather than DEMO', { snapshot: snapshot({ tradeMode: 'REAL' as const }) }],
    ['a disconnected terminal', { snapshot: snapshot({ terminalConnected: false }) }],
    ['algo trading switched off', { snapshot: snapshot({ terminalTradeAllowed: false }) }],
    ['expert trading disallowed by the broker', { snapshot: snapshot({ accountTradeExpert: false }) }],
    ['a netting account, where independent legs are impossible', { snapshot: snapshot({ marginMode: 'RETAIL_NETTING' as const }) }],
    ['an unreadable permission', { snapshot: snapshot({ accountTradeAllowed: null }) }],
  ])('blocks on %s', (_label, over) => {
    const v = evaluate(over as never);
    expect(v.available).toBe(false);
    expect(v.block).toBe('TELEGRAM_MT5_NOT_READY');
  });
});

describe('the quote must be executable, and recent enough to prove it', () => {
  it('blocks when there is no quote', () => {
    expect(evaluate({ quote: null }).block).toBe('TELEGRAM_NO_EXECUTABLE_QUOTE');
  });

  it('blocks on a crossed quote', () => {
    expect(evaluate({ quote: { bid: 4340, ask: 4330, tickAtMs: NOW } }).block).toBe('TELEGRAM_NO_EXECUTABLE_QUOTE');
  });

  it('blocks on a stale tick, which cannot show that price has run away from the entry', () => {
    expect(evaluate({ quote: { bid: 4337.5, ask: 4338, tickAtMs: NOW - 30_000 } }).block).toBe(
      'TELEGRAM_NO_EXECUTABLE_QUOTE',
    );
  });
});

describe('the kill switches', () => {
  it('the global emergency switch stops Engine B', () => {
    process.env.V2_GLOBAL_KILL_SWITCH = 'true';
    const v = evaluate();
    expect(v.block).toBe('TELEGRAM_KILL_SWITCH');
    expect(v.detail).toMatch(/Global emergency kill switch/);
  });

  it('the Telegram-specific switch stops Engine B', () => {
    process.env.TELEGRAM_ENGINE_KILL_SWITCH = 'true';
    expect(evaluate().block).toBe('TELEGRAM_KILL_SWITCH');
  });

  it('Engine A’s own kill switch does not stop Engine B, because it is named after Engine A', () => {
    process.env.XAUUSD_M1M5_KILL_SWITCH = 'true';
    try {
      expect(evaluate().available).toBe(true);
    } finally {
      delete process.env.XAUUSD_M1M5_KILL_SWITCH;
    }
  });
});

describe('reconciliation', () => {
  it('blocks until recovery of this engine’s own prior orders has finished', () => {
    expect(evaluate({ recoveryComplete: false }).block).toBe('TELEGRAM_RECOVERY_INCOMPLETE');
  });
});
