import { describe, expect, it } from 'vitest';
import { evaluateLevelState, hasConfluence, isVolatilitySpike } from '../../src/autonomous/level-confirmation';
import { CandleData } from '../../src/market-data/historical-candle.service';
import { WeeklyRangeLevels } from '../../src/autonomous/weekly-range-levels.service';

function candle(openTime: string, high: number, low: number, close?: number): CandleData {
  return { openTime: new Date(openTime), open: (high + low) / 2, high, low, close: close ?? (high + low) / 2, volume: null };
}

const RESISTANCE = 1.105;
const SUPPORT = 1.099;
const RETRACE = 50; // points
const BREAK = 50; // points

describe('evaluateLevelState — RESISTANCE', () => {
  it('is NOT_TOUCHED when price never reaches the level', () => {
    const candles = [candle('2026-09-07T08:00:00Z', 1.1045, 1.104)];
    expect(evaluateLevelState(RESISTANCE, 'RESISTANCE', candles, 1.104, RETRACE, BREAK)).toBe('NOT_TOUCHED');
  });

  it('is TOUCHED_WAITING after a small touch, before enough retrace', () => {
    const candles = [candle('2026-09-07T08:00:00Z', 1.10505, 1.1045)]; // 5pt overshoot
    expect(evaluateLevelState(RESISTANCE, 'RESISTANCE', candles, 1.1048, RETRACE, BREAK)).toBe('TOUCHED_WAITING'); // only 20pt retrace
  });

  it('is READY once touched and retraced >= the threshold', () => {
    const candles = [candle('2026-09-07T08:00:00Z', 1.10505, 1.1045)];
    expect(evaluateLevelState(RESISTANCE, 'RESISTANCE', candles, 1.1045, RETRACE, BREAK)).toBe('READY'); // 50pt retrace from the level
  });

  it('is BROKEN once the overshoot itself reaches the break threshold, regardless of current price', () => {
    const candles = [candle('2026-09-07T08:00:00Z', 1.1055, 1.104)]; // 50pt overshoot
    expect(evaluateLevelState(RESISTANCE, 'RESISTANCE', candles, 1.1045, RETRACE, BREAK)).toBe('BROKEN');
  });

  it('is not touched by a currentPrice above the level alone, without a candle high actually reaching it', () => {
    // Guards against a bug where only currentPrice, not candle history, is checked for the touch.
    const candles = [candle('2026-09-07T08:00:00Z', 1.1049, 1.104)];
    expect(evaluateLevelState(RESISTANCE, 'RESISTANCE', candles, 1.1051, RETRACE, BREAK)).toBe('NOT_TOUCHED');
  });
});

describe('evaluateLevelState — SUPPORT (mirror image)', () => {
  it('is NOT_TOUCHED when price never reaches the level', () => {
    const candles = [candle('2026-09-07T08:00:00Z', 1.0995, 1.0991)];
    expect(evaluateLevelState(SUPPORT, 'SUPPORT', candles, 1.0995, RETRACE, BREAK)).toBe('NOT_TOUCHED');
  });

  it('is READY once touched and retraced upward >= the threshold', () => {
    const candles = [candle('2026-09-07T08:00:00Z', 1.0995, 1.09895)]; // 5pt undershoot
    expect(evaluateLevelState(SUPPORT, 'SUPPORT', candles, 1.0995, RETRACE, BREAK)).toBe('READY'); // 50pt retrace up from the level
  });

  it('is BROKEN once the undershoot reaches the break threshold', () => {
    const candles = [candle('2026-09-07T08:00:00Z', 1.0995, 1.0985)]; // 50pt undershoot
    expect(evaluateLevelState(SUPPORT, 'SUPPORT', candles, 1.0995, RETRACE, BREAK)).toBe('BROKEN');
  });
});

describe('isVolatilitySpike', () => {
  it('is false with fewer than 2 candles in the window', () => {
    const candles = [candle('2026-09-07T10:00:00Z', 1.1, 1.099, 1.0995)];
    expect(isVolatilitySpike(candles, new Date('2026-09-07T10:00:00Z'), 2, 500)).toBe(false);
  });

  it('is false when the net move within the window is under the threshold', () => {
    const candles = [candle('2026-09-07T08:30:00Z', 1.1, 1.099, 1.0995), candle('2026-09-07T10:00:00Z', 1.1005, 1.0998, 1.1)];
    expect(isVolatilitySpike(candles, new Date('2026-09-07T10:00:00Z'), 2, 500)).toBe(false); // 5pt move
  });

  it('is true when the net move within the window meets the threshold', () => {
    const candles = [candle('2026-09-07T08:30:00Z', 1.1, 1.099, 1.0995), candle('2026-09-07T10:00:00Z', 1.106, 1.104, 1.105)];
    expect(isVolatilitySpike(candles, new Date('2026-09-07T10:00:00Z'), 2, 500)).toBe(true); // 550pt move
  });

  it('ignores candles outside the window even if they would otherwise trigger it', () => {
    const candles = [
      candle('2026-09-07T06:00:00Z', 1.1, 1.099, 1.0995), // 4h before "now" — outside a 2h window
      candle('2026-09-07T09:30:00Z', 1.0997, 1.0993, 1.0995), // inside the window, tiny move from here
      candle('2026-09-07T10:00:00Z', 1.15, 1.05, 1.0996), // wild range, but close barely moved within-window
    ];
    expect(isVolatilitySpike(candles, new Date('2026-09-07T10:00:00Z'), 2, 500)).toBe(false);
  });
});

function levels(overrides: Partial<WeeklyRangeLevels> = {}): WeeklyRangeLevels {
  return {
    referenceWeekStart: new Date('2026-08-31T00:00:00Z'),
    referenceWeekEnd: new Date('2026-09-07T00:00:00Z'),
    resistance: 1.105,
    support: 1.099,
    candleCount: 10,
    ...overrides,
  };
}

describe('hasConfluence', () => {
  it('is false when no D1 levels are available (fail closed, never assumed confirmed)', () => {
    expect(hasConfluence(1.105, null, 'RESISTANCE', 50)).toBe(false);
  });

  it('is true when the D1 level is within tolerance of the H4 level', () => {
    expect(hasConfluence(1.105, levels({ resistance: 1.10505 }), 'RESISTANCE', 50)).toBe(true); // 5pt apart
  });

  it('is false when the D1 level is outside tolerance', () => {
    expect(hasConfluence(1.105, levels({ resistance: 1.107 }), 'RESISTANCE', 50)).toBe(false); // 200pt apart
  });

  it('checks the support field for a SUPPORT level, not resistance', () => {
    expect(hasConfluence(1.099, levels({ support: 1.09902 }), 'SUPPORT', 50)).toBe(true);
    expect(hasConfluence(1.099, levels({ support: 1.101 }), 'SUPPORT', 50)).toBe(false);
  });
});
