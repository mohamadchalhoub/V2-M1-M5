import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { loadTechnicalAnalysisConfig } from '../../src/technical-analysis/technical-analysis.config';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('loadTechnicalAnalysisConfig', () => {
  it('uses the documented defaults when nothing is set', () => {
    expect(loadTechnicalAnalysisConfig(configWith({}))).toEqual({
      supportResistanceProximityPoints: 50,
      ichimokuTimeframes: ['M30', 'H1', 'H4', 'D1'],
      dailyAnalysisTime: '08:00',
      dailyAnalysisTimezone: 'Asia/Beirut',
      fibonacciLookbackDays: 90,
      marketDirectionLookbackDays: 90,
    });
  });

  it('reads every value from env when set', () => {
    const result = loadTechnicalAnalysisConfig(
      configWith({
        SUPPORT_RESISTANCE_PROXIMITY_POINTS: '75',
        ICHIMOKU_TIMEFRAMES: 'h1,h4', // lower-case, trimmed — should normalize
        DAILY_ANALYSIS_TIME: '06:30',
        DAILY_ANALYSIS_TIMEZONE: 'America/New_York',
        FIBONACCI_LOOKBACK: '30',
        MARKET_DIRECTION_LOOKBACK: '60',
      }),
    );
    expect(result).toEqual({
      supportResistanceProximityPoints: 75,
      ichimokuTimeframes: ['H1', 'H4'],
      dailyAnalysisTime: '06:30',
      dailyAnalysisTimezone: 'America/New_York',
      fibonacciLookbackDays: 30,
      marketDirectionLookbackDays: 60,
    });
  });

  it('rejects an invalid DAILY_ANALYSIS_TIME', () => {
    expect(() => loadTechnicalAnalysisConfig(configWith({ DAILY_ANALYSIS_TIME: '25:99' }))).toThrow(/DAILY_ANALYSIS_TIME/);
    expect(() => loadTechnicalAnalysisConfig(configWith({ DAILY_ANALYSIS_TIME: '8am' }))).toThrow(/DAILY_ANALYSIS_TIME/);
  });

  it('rejects an invalid DAILY_ANALYSIS_TIMEZONE', () => {
    expect(() => loadTechnicalAnalysisConfig(configWith({ DAILY_ANALYSIS_TIMEZONE: 'Not/A_Timezone' }))).toThrow(/DAILY_ANALYSIS_TIMEZONE/);
  });

  it('rejects an unsupported ICHIMOKU_TIMEFRAMES value', () => {
    expect(() => loadTechnicalAnalysisConfig(configWith({ ICHIMOKU_TIMEFRAMES: 'H1,W2' }))).toThrow(/ICHIMOKU_TIMEFRAMES/);
  });

  it('accepts W1/MN1 (Ichimoku breakout alerts on weekly/monthly candles)', () => {
    const result = loadTechnicalAnalysisConfig(configWith({ ICHIMOKU_TIMEFRAMES: 'M30,H1,H4,D1,W1,MN1' }));
    expect(result.ichimokuTimeframes).toEqual(['M30', 'H1', 'H4', 'D1', 'W1', 'MN1']);
  });

  it('rejects a non-positive SUPPORT_RESISTANCE_PROXIMITY_POINTS', () => {
    expect(() => loadTechnicalAnalysisConfig(configWith({ SUPPORT_RESISTANCE_PROXIMITY_POINTS: '0' }))).toThrow(/SUPPORT_RESISTANCE_PROXIMITY_POINTS/);
    expect(() => loadTechnicalAnalysisConfig(configWith({ SUPPORT_RESISTANCE_PROXIMITY_POINTS: 'nope' }))).toThrow(/SUPPORT_RESISTANCE_PROXIMITY_POINTS/);
  });
});
