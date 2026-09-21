import { describe, expect, it } from 'vitest';
import { calculateFibonacciAnalysis, FIBONACCI_RATIOS } from '../../src/technical-analysis/fibonacci.service';
import { CandleData } from '../../src/market-data/historical-candle.service';

function candle(openTime: string, high: number, low: number): CandleData {
  return { openTime: new Date(openTime), open: (high + low) / 2, high, low, close: (high + low) / 2, volume: null };
}

describe('calculateFibonacciAnalysis', () => {
  it('null with zero candles', () => {
    expect(calculateFibonacciAnalysis([], 1.1)).toBeNull();
  });

  it('null when the window is flat (no real range to measure)', () => {
    const candles = [candle('2026-01-01', 1.1, 1.1), candle('2026-01-02', 1.1, 1.1)];
    expect(calculateFibonacciAnalysis(candles, 1.1)).toBeNull();
  });

  it('BULLISH direction when the swing high is more recent than the swing low — retracement measured down from the high', () => {
    const candles = [
      candle('2026-01-01', 1.05, 1.0), // swing low here
      candle('2026-01-02', 1.08, 1.06),
      candle('2026-01-03', 1.2, 1.15), // swing high here, most recent extreme
    ];
    const result = calculateFibonacciAnalysis(candles, 1.15)!;
    expect(result.direction).toBe('BULLISH');
    expect(result.swingHigh).toMatchObject({ price: 1.2, timestamp: new Date('2026-01-03') });
    expect(result.swingLow).toMatchObject({ price: 1.0, timestamp: new Date('2026-01-01') });
    // 61.8% retracement of a 0.20 range down from the high: 1.2 - 0.618*0.2 = 1.0764
    const level618 = result.levels.find((l) => l.ratio === 0.618)!;
    expect(level618.price).toBeCloseTo(1.0764, 6);
  });

  it('BEARISH direction when the swing low is more recent than the swing high — retracement measured up from the low', () => {
    const candles = [
      candle('2026-01-01', 1.2, 1.15), // swing high here
      candle('2026-01-02', 1.08, 1.06),
      candle('2026-01-03', 1.05, 1.0), // swing low here, most recent extreme
    ];
    const result = calculateFibonacciAnalysis(candles, 1.05)!;
    expect(result.direction).toBe('BEARISH');
    // 50% retracement up from the low: 1.0 + 0.5*0.2 = 1.10
    const level50 = result.levels.find((l) => l.ratio === 0.5)!;
    expect(level50.price).toBeCloseTo(1.1, 6);
  });

  it('produces exactly the centralized set of standard ratios, in order', () => {
    const candles = [candle('2026-01-01', 1.2, 1.0), candle('2026-01-02', 1.15, 1.05)];
    const result = calculateFibonacciAnalysis(candles, 1.1)!;
    expect(result.levels.map((l) => l.ratio)).toEqual([...FIBONACCI_RATIOS]);
  });

  it('identifies the nearest level to the current price', () => {
    const candles = [candle('2026-01-01', 1.0, 1.0), candle('2026-01-02', 1.2, 1.2)];
    // BULLISH (high more recent): levels are 1.2, 1.1528, 1.1236, 1.10, 1.0764, 1.0428, 1.0
    const result = calculateFibonacciAnalysis(candles, 1.101)!;
    expect(result.nearestLevel.ratio).toBe(0.5); // price 1.10 is nearest to 1.101
  });
});
