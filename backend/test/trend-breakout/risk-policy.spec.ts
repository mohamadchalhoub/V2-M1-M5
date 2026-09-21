import { describe, expect, it } from 'vitest';
import {
  estimateStopRiskAmount,
  evaluateCombinedRiskGate,
  evaluateDailyLossGate,
  evaluateDrawdownGate,
  evaluateQuoteAgeGate,
  evaluateSpreadGate,
  evaluateTradeRiskGate,
  updateCashFlowAdjustedHigh,
} from '../../src/trend-breakout/risk-policy';

describe('estimateStopRiskAmount', () => {
  it('computes volume x contractSize x stopDistance x conversionRate', () => {
    const amount = estimateStopRiskAmount({ volumeLots: 0.12, contractSize: 100_000, stopDistancePrice: 0.0027, conversionRateToAccountCcy: 1 });
    expect(amount).toBeCloseTo(0.12 * 100_000 * 0.0027, 6);
  });

  it('fails closed (null) when the conversion rate is unavailable', () => {
    expect(estimateStopRiskAmount({ volumeLots: 0.12, contractSize: 100_000, stopDistancePrice: 0.0027, conversionRateToAccountCcy: null })).toBeNull();
  });
});

describe('evaluateTradeRiskGate — §10 per-trade 0.5% cap, volume is NEVER resized', () => {
  it('passes when estimated risk is within the cap', () => {
    const result = evaluateTradeRiskGate({ estimatedRiskAmount: 40, accountEquity: 10_000, maxTradeRiskPct: 0.5 }); // 0.4% <= 0.5%
    expect(result.passed).toBe(true);
  });

  it('rejects the TRADE (not the volume) when the estimated risk exceeds the cap', () => {
    const result = evaluateTradeRiskGate({ estimatedRiskAmount: 60, accountEquity: 10_000, maxTradeRiskPct: 0.5 }); // 0.6% > 0.5%
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/volume is NOT reduced/);
  });
});

describe('evaluateCombinedRiskGate — §10 1% combined cap across reserved + new', () => {
  it('accounts for already-reserved risk from other open/pending positions', () => {
    const result = evaluateCombinedRiskGate({ reservedRiskAmounts: [80], newRiskAmount: 30, accountEquity: 10_000, maxCombinedRiskPct: 1 }); // 110 > 100
    expect(result.passed).toBe(false);
  });

  it('passes when combined stays within the cap', () => {
    const result = evaluateCombinedRiskGate({ reservedRiskAmounts: [50], newRiskAmount: 30, accountEquity: 10_000, maxCombinedRiskPct: 1 }); // 80 <= 100
    expect(result.passed).toBe(true);
  });
});

describe('evaluateDailyLossGate — §10, Beirut calendar day, cash-flow adjusted', () => {
  it('stays passed while cash-flow-adjusted trading P&L is within -2%', () => {
    const result = evaluateDailyLossGate({ currentEquity: 9_850, dailyBaselineEquity: 10_000, dailyNetCashFlow: 0, dailyLossPct: 2, alreadyTriggered: false }); // -1.5%
    expect(result.passed).toBe(true);
  });

  it('triggers at or beyond -2% trading loss', () => {
    const result = evaluateDailyLossGate({ currentEquity: 9_800, dailyBaselineEquity: 10_000, dailyNetCashFlow: 0, dailyLossPct: 2, alreadyTriggered: false }); // exactly -2%
    expect(result.passed).toBe(false);
  });

  it('a deposit is never counted as trading profit that offsets a real loss', () => {
    // Equity is flat (10,000 -> 10,000) only because a 500 deposit offset a real 500 trading loss.
    const result = evaluateDailyLossGate({ currentEquity: 10_000, dailyBaselineEquity: 10_000, dailyNetCashFlow: 500, dailyLossPct: 2, alreadyTriggered: false });
    expect(result.passed).toBe(false); // real trading P&L = 10000 - 10000 - 500 = -500, i.e. -5%
  });

  it('stays blocked for the rest of the day once already triggered', () => {
    const result = evaluateDailyLossGate({ currentEquity: 10_000, dailyBaselineEquity: 10_000, dailyNetCashFlow: 0, dailyLossPct: 2, alreadyTriggered: true });
    expect(result.passed).toBe(false);
  });
});

describe('evaluateDrawdownGate — §10, 5% below cash-flow-adjusted high, sticky until explicit reset', () => {
  it('triggers at or beyond 5% below the high', () => {
    const result = evaluateDrawdownGate({ currentEquity: 9_500, cashFlowAdjustedHigh: 10_000, drawdownPct: 5, alreadyTriggered: false });
    expect(result.passed).toBe(false);
  });

  it('stays blocked once triggered even if equity partially recovers', () => {
    const result = evaluateDrawdownGate({ currentEquity: 9_800, cashFlowAdjustedHigh: 10_000, drawdownPct: 5, alreadyTriggered: true });
    expect(result.passed).toBe(false);
  });
});

describe('evaluateSpreadGate / evaluateQuoteAgeGate', () => {
  it('rejects a spread wider than 10% of D', () => {
    const result = evaluateSpreadGate({ spreadPrice: 0.0005, stopDistancePrice: 0.003, maxSpreadPctOfD: 10 }); // max 0.0003
    expect(result.passed).toBe(false);
  });

  it('rejects a quote older than the max age', () => {
    const result = evaluateQuoteAgeGate({ quoteAgeMs: 6000, maxQuoteAgeSeconds: 5 });
    expect(result.passed).toBe(false);
  });
});

describe('updateCashFlowAdjustedHigh', () => {
  it('is monotonic non-decreasing', () => {
    expect(updateCashFlowAdjustedHigh(10_000, 9_500)).toBe(10_000);
    expect(updateCashFlowAdjustedHigh(10_000, 10_500)).toBe(10_500);
  });
});
