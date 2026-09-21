import { describe, expect, it } from 'vitest';
import { evaluateHighImpactEventExposure } from '../../../src/rules/evaluators/high-impact-event-exposure.evaluator';
import { parseForexSymbolCurrencies } from '../../../src/rules/evaluators/forex-symbol';
import { currentMetricsFixture } from '../fixtures';

const PARAMS = { minutes_before: 30, minimum_exposure_volume: 1 };
const NOW = new Date('2026-09-05T12:00:00Z');

describe('parseForexSymbolCurrencies', () => {
  it('parses a standard 6-letter FX pair', () => {
    expect(parseForexSymbolCurrencies('EURUSD')).toEqual(['EUR', 'USD']);
  });

  it('ignores a broker suffix after the pair', () => {
    expect(parseForexSymbolCurrencies('GBPJPY.a')).toEqual(['GBP', 'JPY']);
    expect(parseForexSymbolCurrencies('EURUSDm')).toEqual(['EUR', 'USD']);
  });

  it('is case-insensitive and normalizes to uppercase', () => {
    expect(parseForexSymbolCurrencies('eurusd')).toEqual(['EUR', 'USD']);
  });

  it('returns null for a symbol with no 6-letter run (indices/equities)', () => {
    expect(parseForexSymbolCurrencies('US30')).toBeNull();
    expect(parseForexSymbolCurrencies('NAS100')).toBeNull();
  });
});

describe('evaluateHighImpactEventExposure', () => {
  it('NOT_TRIGGERED with reason NO_UPCOMING_HIGH_IMPACT_EVENTS when there are none in the window', () => {
    const current = currentMetricsFixture({
      position: { positionVolumeBySymbol: [{ symbol: 'EURUSD', totalVolume: 5, count: 1 }] },
    });
    const result = evaluateHighImpactEventExposure(PARAMS, current, { upcomingHighImpactEvents: [], now: NOW });
    expect(result.status).toBe('NOT_TRIGGERED');
    expect(result.reasonCode).toBe('NO_UPCOMING_HIGH_IMPACT_EVENTS');
  });

  it('NOT_TRIGGERED when an event is upcoming but no open position touches its currency', () => {
    const current = currentMetricsFixture({
      position: { positionVolumeBySymbol: [{ symbol: 'GBPJPY', totalVolume: 5, count: 1 }] },
    });
    const result = evaluateHighImpactEventExposure(PARAMS, current, {
      now: NOW,
      upcomingHighImpactEvents: [
        { id: 'evt-1', title: 'Employment Situation', scheduledAt: new Date('2026-09-05T12:12:00Z'), affectedCurrencies: ['USD'] },
      ],
    });
    expect(result.status).toBe('NOT_TRIGGERED');
    expect(result.reasonCode).toBe('NO_SIGNIFICANT_EXPOSURE_BEFORE_EVENT');
  });

  it('NOT_TRIGGERED when exposure is below the configured minimum', () => {
    const current = currentMetricsFixture({
      position: { positionVolumeBySymbol: [{ symbol: 'EURUSD', totalVolume: 0.5, count: 1 }] },
    });
    const result = evaluateHighImpactEventExposure(PARAMS, current, {
      now: NOW,
      upcomingHighImpactEvents: [
        { id: 'evt-1', title: 'CPI', scheduledAt: new Date('2026-09-05T12:12:00Z'), affectedCurrencies: ['USD'] },
      ],
    });
    expect(result.status).toBe('NOT_TRIGGERED');
  });

  it('TRIGGERED when exposure in an affected currency meets the minimum ahead of a high-impact event', () => {
    const current = currentMetricsFixture({
      position: {
        positionVolumeBySymbol: [
          { symbol: 'EURUSD', totalVolume: 1.5, count: 2 },
          { symbol: 'GBPJPY', totalVolume: 3, count: 1 },
        ],
      },
    });
    const result = evaluateHighImpactEventExposure(PARAMS, current, {
      now: NOW,
      upcomingHighImpactEvents: [
        { id: 'evt-1', title: 'Employment Situation (Nonfarm Payrolls)', scheduledAt: new Date('2026-09-05T12:12:00Z'), affectedCurrencies: ['USD'] },
      ],
    });
    expect(result.status).toBe('TRIGGERED');
    expect(result.reasonCode).toBe('EXPOSURE_ABOVE_THRESHOLD_BEFORE_HIGH_IMPACT_EVENT');
    const exposures = result.triggerValues.exposures as { currency: string; volume: number; minutesUntilEvent: number }[];
    expect(exposures).toEqual([
      expect.objectContaining({ currency: 'USD', volume: 1.5, minutesUntilEvent: 12 }),
    ]);
  });

  it('sums exposure across multiple symbols sharing the affected currency', () => {
    const current = currentMetricsFixture({
      position: {
        positionVolumeBySymbol: [
          { symbol: 'EURUSD', totalVolume: 0.6, count: 1 },
          { symbol: 'USDJPY', totalVolume: 0.6, count: 1 },
        ],
      },
    });
    const result = evaluateHighImpactEventExposure(PARAMS, current, {
      now: NOW,
      upcomingHighImpactEvents: [
        { id: 'evt-1', title: 'CPI', scheduledAt: new Date('2026-09-05T12:12:00Z'), affectedCurrencies: ['USD'] },
      ],
    });
    expect(result.status).toBe('TRIGGERED');
    const exposures = result.triggerValues.exposures as { currency: string; volume: number }[];
    expect(exposures[0]).toMatchObject({ currency: 'USD', volume: 1.2 });
  });

  it('never mentions a trading instruction (buy/sell) in its output', () => {
    const current = currentMetricsFixture({
      position: { positionVolumeBySymbol: [{ symbol: 'EURUSD', totalVolume: 5, count: 1 }] },
    });
    const result = evaluateHighImpactEventExposure(PARAMS, current, {
      now: NOW,
      upcomingHighImpactEvents: [
        { id: 'evt-1', title: 'CPI', scheduledAt: new Date('2026-09-05T12:12:00Z'), affectedCurrencies: ['USD'] },
      ],
    });
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toMatch(/\bbuy\b|\bsell\b/);
  });

  it('NOT_TRIGGERED with no open positions at all', () => {
    const current = currentMetricsFixture();
    const result = evaluateHighImpactEventExposure(PARAMS, current, {
      now: NOW,
      upcomingHighImpactEvents: [
        { id: 'evt-1', title: 'CPI', scheduledAt: new Date('2026-09-05T12:12:00Z'), affectedCurrencies: ['USD'] },
      ],
    });
    expect(result.status).toBe('NOT_TRIGGERED');
  });
});
