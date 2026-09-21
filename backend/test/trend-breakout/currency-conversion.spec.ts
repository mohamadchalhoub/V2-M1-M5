import { describe, expect, it } from 'vitest';
import { resolveConversionRate } from '../../src/trend-breakout/currency-conversion';

describe('resolveConversionRate', () => {
  it('is 1 when profit and account currency match', () => {
    expect(resolveConversionRate({ profitCurrency: 'EUR', accountCurrency: 'EUR', eurUsdMid: null })).toBe(1);
  });

  it('converts USD profit into a EUR account via 1/EURUSD', () => {
    const rate = resolveConversionRate({ profitCurrency: 'USD', accountCurrency: 'EUR', eurUsdMid: 1.1 });
    expect(rate).toBeCloseTo(1 / 1.1, 10);
  });

  it('converts EUR profit into a USD account via EURUSD directly', () => {
    const rate = resolveConversionRate({ profitCurrency: 'EUR', accountCurrency: 'USD', eurUsdMid: 1.1 });
    expect(rate).toBeCloseTo(1.1, 10);
  });

  it('fails closed (null) when the EURUSD rate is unavailable', () => {
    expect(resolveConversionRate({ profitCurrency: 'USD', accountCurrency: 'EUR', eurUsdMid: null })).toBeNull();
  });

  it('fails closed for an unsupported currency combination rather than guessing', () => {
    expect(resolveConversionRate({ profitCurrency: 'GBP', accountCurrency: 'JPY', eurUsdMid: 1.1 })).toBeNull();
  });
});
