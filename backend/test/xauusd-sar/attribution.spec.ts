import { describe, expect, it } from 'vitest';
import { attributeMagic } from '../../src/trading-data/engine-attribution';
import { buildDailyReport } from '../../src/trading-data/daily-report';
import { SAR_MAGIC } from '../../src/xauusd-sar/safety-constants';
import { V2_MAGIC_M1, V2_MAGIC_M5 } from '../../src/xauusd-m1m5/safety-constants';

describe('xauusd-sar-v1 attribution', () => {
  it('is Engine A, with no timeframe (never a fabricated M1/M5)', () => {
    const a = attributeMagic(SAR_MAGIC);
    expect(a.engine).toBe('Engine A');
    expect(a.timeframe).toBeNull();
    expect(a.strategy).toBe('STOP_AND_REVERSE');
  });

  it('never collides with the frozen RSI magic numbers, and legacy attribution is untouched', () => {
    expect(SAR_MAGIC).not.toBe(V2_MAGIC_M1);
    expect(SAR_MAGIC).not.toBe(V2_MAGIC_M5);
    expect(attributeMagic(V2_MAGIC_M1)).toMatchObject({ engine: 'Engine A', timeframe: 'M1', strategy: 'RSI_M1_M5' });
    expect(attributeMagic(V2_MAGIC_M5)).toMatchObject({ engine: 'Engine A', timeframe: 'M5', strategy: 'RSI_M1_M5' });
  });
});

describe('the combined daily report includes SAR trades correctly', () => {
  it('buckets SAR trades separately from M1/M5, but both count toward Engine A', () => {
    const report = buildDailyReport('2026-09-24', 'Demo', 'USD', [
      { attribution: attributeMagic(V2_MAGIC_M1), net: 1 },
      { attribution: attributeMagic(SAR_MAGIC), net: 2, side: 'BUY', volume: 0.5, openPrice: 4500, closePrice: 4502 },
    ]);
    expect(report.engineAM1.wins).toBe(1);
    expect(report.engineASar.wins).toBe(1);
    expect(report.total.wins).toBe(2);
    expect(report.total.net).toBeCloseTo(3, 6);
  });
});
