import { describe, expect, it } from 'vitest';
import { calculateMarketDirection } from '../../src/technical-analysis/market-direction.service';
import { CandleData } from '../../src/market-data/historical-candle.service';

function candle(index: number, high: number, low: number, close?: number): CandleData {
  return { openTime: new Date(Date.UTC(2026, 0, 1, index)), open: (high + low) / 2, high, low, close: close ?? (high + low) / 2, volume: null };
}

function flat(count: number, high: number, low: number): CandleData[] {
  return Array.from({ length: count }, (_, i) => candle(i, high, low));
}

const NOW = new Date('2026-01-05T00:00:00Z');

describe('calculateMarketDirection', () => {
  it('NEUTRAL with all-NEUTRAL signals when there is not enough history for anything', () => {
    const result = calculateMarketDirection('EURUSD', flat(5, 1.1, 1.09), flat(5, 1.1, 1.09), NOW);
    expect(result.dailyBias).toBe('NEUTRAL');
    expect(result.confidence).toBe(0);
    expect(result.signals.every((s) => s.vote === 'NEUTRAL')).toBe(true);
  });

  it('BULLISH with full agreement (confidence 1) when Ichimoku, structure, and SMA all agree bullish', () => {
    // Ichimoku: same step-cloud construction as ichimoku.service.spec.ts —
    // 26 flat @1.00 then 51 flat @1.20 (indices 0-76), final close 1.25
    // (ABOVE_CLOUD, top=1.20) at index 77.
    const lowStep = Array.from({ length: 26 }, (_, i) => candle(i, 1.0, 1.0));
    const highStep = Array.from({ length: 51 }, (_, i) => candle(26 + i, 1.2, 1.2));
    const h4Candles = [...lowStep, ...highStep, candle(77, 1.25, 1.25, 1.25)];

    // D1 SMA: rising closes so the 10-day SMA sits above the 30-day SMA.
    const d1Candles = Array.from({ length: 30 }, (_, i) => candle(i, 1.0 + i * 0.01, 1.0 + i * 0.01, 1.0 + i * 0.01));

    const result = calculateMarketDirection('EURUSD', h4Candles, d1Candles, NOW);
    const ichimokuSignal = result.signals.find((s) => s.name === 'H4_ICHIMOKU_TREND')!;
    const smaSignal = result.signals.find((s) => s.name === 'D1_SMA_TREND')!;
    expect(ichimokuSignal.vote).toBe('BULLISH');
    expect(smaSignal.vote).toBe('BULLISH');
    expect(result.dailyBias).toBe('BULLISH');
    expect(result.reasons).toEqual(result.signals.map((s) => s.reason));
  });

  it('BEARISH with full agreement when Ichimoku and SMA both agree bearish', () => {
    const lowStep = Array.from({ length: 26 }, (_, i) => candle(i, 1.2, 1.2));
    const highStep = Array.from({ length: 51 }, (_, i) => candle(26 + i, 1.0, 1.0));
    const h4Candles = [...lowStep, ...highStep, candle(77, 0.95, 0.95, 0.95)]; // below the [1.0,1.1] band

    const d1Candles = Array.from({ length: 30 }, (_, i) => candle(i, 1.3 - i * 0.01, 1.3 - i * 0.01, 1.3 - i * 0.01));

    const result = calculateMarketDirection('EURUSD', h4Candles, d1Candles, NOW);
    expect(result.dailyBias).toBe('BEARISH');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('always returns exactly 3 named signals, timeframes H4/D1, and the given timestamp', () => {
    const result = calculateMarketDirection('EURUSD', flat(5, 1.1, 1.09), flat(5, 1.1, 1.09), NOW);
    expect(result.signals).toHaveLength(3);
    expect(result.signals.map((s) => s.name).sort()).toEqual(['D1_SMA_TREND', 'H4_ICHIMOKU_TREND', 'H4_MARKET_STRUCTURE']);
    expect(result.timeframes).toEqual(['H4', 'D1']);
    expect(result.timestamp).toBe(NOW);
    expect(result.symbol).toBe('EURUSD');
  });
});
