import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { assertUnambiguousSymbol, DEFAULT_VOLUME_LOTS, resolveInstrumentMappings } from '../../src/trend-breakout/instrument-config';

function config(vars: Record<string, string>): ConfigService {
  return { get: (key: string) => vars[key] } as unknown as ConfigService;
}

describe('assertUnambiguousSymbol', () => {
  it('accepts the plain symbols', () => {
    expect(() => assertUnambiguousSymbol('EURUSD', 'EURUSD')).not.toThrow();
    expect(() => assertUnambiguousSymbol('XAUUSD', 'XAUUSD')).not.toThrow();
  });

  it('accepts a documented broker suffix', () => {
    expect(() => assertUnambiguousSymbol('EURUSD', 'EURUSD.a')).not.toThrow();
    expect(() => assertUnambiguousSymbol('XAUUSD', 'XAUUSDm')).not.toThrow();
  });

  it('rejects gold crosses that contain no USD at all', () => {
    expect(() => assertUnambiguousSymbol('XAUUSD', 'XAUEUR')).toThrow(/does not contain "USD"/);
    expect(() => assertUnambiguousSymbol('XAUUSD', 'XAUGBP')).toThrow(/does not contain "USD"/);
    expect(() => assertUnambiguousSymbol('XAUUSD', 'XAUAUD')).toThrow(/does not contain "USD"/);
  });

  it('rejects a symbol that contains USD but ALSO smuggles a second currency', () => {
    expect(() => assertUnambiguousSymbol('XAUUSD', 'XAUEURUSD')).toThrow(/looks like a gold cross/);
  });

  it('rejects an EURUSD mapping whose suffix smuggles another pair', () => {
    expect(() => assertUnambiguousSymbol('EURUSD', 'EURUSDGBP')).toThrow();
  });

  it('rejects a symbol unrelated to the instrument entirely', () => {
    expect(() => assertUnambiguousSymbol('EURUSD', 'GBPJPY')).toThrow();
  });

  it('rejects an empty mapping', () => {
    expect(() => assertUnambiguousSymbol('EURUSD', '   ')).toThrow(/empty/);
  });
});

describe('resolveInstrumentMappings', () => {
  it('defaults to EURUSD/XAUUSD when unconfigured', () => {
    const result = resolveInstrumentMappings(config({}));
    expect(result.EURUSD.brokerSymbol).toBe('EURUSD');
    expect(result.XAUUSD.brokerSymbol).toBe('XAUUSD');
    expect(result.EURUSD.defaultVolumeLots).toBe(DEFAULT_VOLUME_LOTS.EURUSD);
    expect(result.XAUUSD.defaultVolumeLots).toBe(DEFAULT_VOLUME_LOTS.XAUUSD);
  });

  it('honors explicit broker-symbol overrides', () => {
    const result = resolveInstrumentMappings(config({ TREND_BREAKOUT_GOLD_BROKER_SYMBOL: 'XAUUSDm' }));
    expect(result.XAUUSD.brokerSymbol).toBe('XAUUSDm');
  });

  // Note: EURUSD's and XAUUSD's own per-instrument prefix checks
  // (assertUnambiguousSymbol) already make an actual collision structurally
  // impossible (one must start with "EURUSD", the other with "XAU") — a
  // genuinely colliding config is rejected earlier, with a message about
  // the FAILING instrument's own prefix, never reaching the same-symbol
  // check at all. That cross-check is kept as harmless defense-in-depth
  // for the day either validator becomes more permissive, but there is no
  // reachable input that exercises it today, so no test pretends otherwise.
});
