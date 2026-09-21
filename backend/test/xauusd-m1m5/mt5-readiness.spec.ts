/**
 * §15.6 — MT5 permission verification.
 *
 * The governing property is negative and easy to get wrong: readiness is
 * never inferred from the quote feed, and an unreadable permission is never
 * treated as a granted one.
 */
import { describe, expect, it } from 'vitest';
import {
  describeReadiness,
  evaluateReadiness,
  PERMISSION_SNAPSHOT_MAX_AGE_MS,
  type Mt5PermissionSnapshot,
} from '../../src/xauusd-m1m5/mt5-readiness';

const NOW = Date.UTC(2026, 8, 21, 10, 0, 0);
const LOGIN = '12345678';

function snapshot(over: Partial<Mt5PermissionSnapshot> = {}): Mt5PermissionSnapshot {
  return {
    capturedAtMs: NOW - 1000,
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

function verdict(over: Partial<Mt5PermissionSnapshot> = {}, expectedLoginId: string | null = LOGIN) {
  return evaluateReadiness({ snapshot: snapshot(over), expectedLoginId, nowMs: NOW });
}

const codes = (v: ReturnType<typeof verdict>) => v.blockers.map((b) => b.code);

describe('§8 a fully permitted terminal is ready', () => {
  it('reports ready when every check passes', () => {
    const v = verdict();
    expect(v.ready).toBe(true);
    expect(v.blockers).toEqual([]);
    expect(v.hedgingSupported).toBe(true);
  });

  it('describes readiness without mentioning quotes', () => {
    expect(describeReadiness(verdict())).toMatch(/permissions verified/i);
  });
});

describe('§8 quotes are not permission to trade', () => {
  it('blocks when no snapshot exists at all', () => {
    const v = evaluateReadiness({ snapshot: null, expectedLoginId: LOGIN, nowMs: NOW });
    expect(v.ready).toBe(false);
    expect(v.blockers[0].code).toBe('NO_SNAPSHOT');
    expect(v.blockers[0].detail).toMatch(/quotes are not evidence/i);
  });

  it('blocks on a stale snapshot, because permissions can change at any moment', () => {
    const fresh = verdict({ capturedAtMs: NOW - PERMISSION_SNAPSHOT_MAX_AGE_MS });
    expect(codes(fresh)).not.toContain('SNAPSHOT_STALE');

    const stale = verdict({ capturedAtMs: NOW - PERMISSION_SNAPSHOT_MAX_AGE_MS - 1 });
    expect(codes(stale)).toContain('SNAPSHOT_STALE');
    expect(stale.ready).toBe(false);
  });
});

describe('§8 unknown blocks, never permits', () => {
  it.each([
    ['terminalConnected', 'TERMINAL_CONNECTION_UNKNOWN'],
    ['terminalTradeAllowed', 'TERMINAL_TRADE_ALLOWED_UNKNOWN'],
    ['terminalTradeApiDisabled', 'TERMINAL_TRADE_API_UNKNOWN'],
    ['accountTradeAllowed', 'ACCOUNT_TRADE_ALLOWED_UNKNOWN'],
    ['accountTradeExpert', 'ACCOUNT_TRADE_EXPERT_UNKNOWN'],
  ])('an unreadable %s blocks with %s', (field, code) => {
    const v = verdict({ [field]: null } as Partial<Mt5PermissionSnapshot>);
    expect(v.ready).toBe(false);
    expect(codes(v)).toContain(code);
  });

  it('an unknown trade mode blocks rather than assuming DEMO', () => {
    const v = verdict({ tradeMode: null });
    expect(codes(v)).toContain('TRADE_MODE_UNKNOWN');
    expect(v.blockers.find((b) => b.code === 'TRADE_MODE_UNKNOWN')?.detail).toMatch(/positively verified/i);
  });

  it('an unknown margin mode blocks rather than assuming hedging', () => {
    const v = verdict({ marginMode: null });
    expect(codes(v)).toContain('HEDGING_UNKNOWN');
    expect(v.hedgingSupported).toBeNull();
  });
});

describe('§8 DEMO only', () => {
  it.each(['REAL', 'CONTEST'] as const)('refuses a %s account', (mode) => {
    const v = verdict({ tradeMode: mode });
    expect(v.ready).toBe(false);
    expect(codes(v)).toContain('NOT_DEMO');
    expect(v.blockers.find((b) => b.code === 'NOT_DEMO')?.detail).toMatch(/no real-account path/i);
  });
});

describe('§8 account identity', () => {
  it('refuses when the terminal is logged into a different account', () => {
    const v = verdict({ loginId: '99999999' });
    expect(codes(v)).toContain('ACCOUNT_IDENTITY_MISMATCH');
    // And warns against the specific dangerous fix.
    expect(v.blockers.find((b) => b.code === 'ACCOUNT_IDENTITY_MISMATCH')?.detail).toMatch(
      /Do NOT switch another deployment/i,
    );
  });

  it('refuses when the terminal does not report an account', () => {
    expect(codes(verdict({ loginId: null }))).toContain('ACCOUNT_IDENTITY_UNKNOWN');
  });

  it('refuses when no expected account is configured', () => {
    const v = verdict({}, null);
    expect(codes(v)).toContain('ACCOUNT_IDENTITY_UNKNOWN');
    expect(v.blockers.find((b) => b.code === 'ACCOUNT_IDENTITY_UNKNOWN')?.origin).toBe('CONFIGURATION');
  });
});

describe('§8 terminal-side versus broker-side', () => {
  it('attributes terminal permissions to the TERMINAL', () => {
    const v = verdict({ terminalTradeAllowed: false });
    expect(v.blockers.find((b) => b.code === 'TERMINAL_TRADE_NOT_ALLOWED')?.origin).toBe('TERMINAL');
  });

  it('attributes account permissions to the BROKER, and says they cannot be fixed locally', () => {
    const allowed = verdict({ accountTradeAllowed: false });
    expect(allowed.blockers.find((b) => b.code === 'ACCOUNT_TRADE_NOT_ALLOWED')?.origin).toBe('BROKER');
    expect(allowed.blockers.find((b) => b.code === 'ACCOUNT_TRADE_NOT_ALLOWED')?.detail).toMatch(
      /cannot be fixed from the terminal/i,
    );

    const expert = verdict({ accountTradeExpert: false });
    expect(expert.blockers.find((b) => b.code === 'ACCOUNT_TRADE_EXPERT_DISABLED')?.origin).toBe('BROKER');
  });

  it('summarises blockers by origin', () => {
    const v = verdict({ terminalTradeAllowed: false, accountTradeExpert: false });
    const text = describeReadiness(v);
    expect(text).toMatch(/terminal/);
    expect(text).toMatch(/broker/);
    expect(text).toMatch(/TERMINAL_TRADE_NOT_ALLOWED/);
  });
});

describe('§8 tradeapi_disabled has inverted sense', () => {
  it('blocks when true, passes when false', () => {
    expect(codes(verdict({ terminalTradeApiDisabled: true }))).toContain('TERMINAL_TRADE_API_DISABLED');
    expect(codes(verdict({ terminalTradeApiDisabled: false }))).not.toContain('TERMINAL_TRADE_API_DISABLED');
  });
});

describe('§4 hedging is structural, not merely a permission', () => {
  it('blocks a netting account and explains why emulation is refused', () => {
    const v = verdict({ marginMode: 'RETAIL_NETTING' });
    expect(v.ready).toBe(false);
    expect(v.hedgingSupported).toBe(false);
    const blocker = v.blockers.find((b) => b.code === 'HEDGING_UNSUPPORTED');
    expect(blocker?.detail).toMatch(/merge them into one net position/i);
    expect(blocker?.detail).toMatch(/will not silently emulate/i);
  });

  it('blocks an exchange account too', () => {
    expect(codes(verdict({ marginMode: 'EXCHANGE' }))).toContain('HEDGING_UNSUPPORTED');
  });
});

describe('§8 all blockers are reported, not just the first', () => {
  it('lists every failing check at once', () => {
    const v = evaluateReadiness({
      snapshot: {
        capturedAtMs: NOW - 10 * 60_000,
        loginId: '99999999',
        tradeMode: 'REAL',
        terminalConnected: false,
        terminalTradeAllowed: false,
        terminalTradeApiDisabled: true,
        accountTradeAllowed: false,
        accountTradeExpert: false,
        marginMode: 'RETAIL_NETTING',
      },
      expectedLoginId: LOGIN,
      nowMs: NOW,
    });

    expect(v.ready).toBe(false);
    expect(codes(v)).toEqual(
      expect.arrayContaining([
        'SNAPSHOT_STALE',
        'ACCOUNT_IDENTITY_MISMATCH',
        'NOT_DEMO',
        'TERMINAL_DISCONNECTED',
        'TERMINAL_TRADE_NOT_ALLOWED',
        'TERMINAL_TRADE_API_DISABLED',
        'ACCOUNT_TRADE_NOT_ALLOWED',
        'ACCOUNT_TRADE_EXPERT_DISABLED',
        'HEDGING_UNSUPPORTED',
      ]),
    );
    expect(v.blockers.length).toBe(9);
  });

  it('never reports ready while any blocker stands', () => {
    // Exhaustive single-fault sweep: flipping any one check must block.
    const faults: Array<Partial<Mt5PermissionSnapshot>> = [
      { tradeMode: 'REAL' },
      { terminalConnected: false },
      { terminalTradeAllowed: false },
      { terminalTradeApiDisabled: true },
      { accountTradeAllowed: false },
      { accountTradeExpert: false },
      { marginMode: 'RETAIL_NETTING' },
      { loginId: 'other' },
    ];
    for (const fault of faults) {
      expect(verdict(fault).ready, JSON.stringify(fault)).toBe(false);
    }
  });
});
