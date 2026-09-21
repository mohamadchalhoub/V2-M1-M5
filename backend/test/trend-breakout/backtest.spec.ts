import { describe, expect, it } from 'vitest';
import { CandleData } from '../../src/market-data/historical-candle.service';
import { runCombinedTrendBreakoutBacktest, runTrendBreakoutInstrumentBacktest, TrendBreakoutBacktestConfig } from '../../src/trend-breakout/backtest';
import { DEFAULT_RISK_POLICY } from '../../src/trend-breakout/risk-policy';

function h4(openTimeMs: number, close: number): CandleData {
  return { openTime: new Date(openTimeMs), open: close, high: close + 0.0005, low: close - 0.0005, close, volume: null };
}
function bullishH4Candles(count: number, startMs: number): CandleData[] {
  return Array.from({ length: count }, (_, i) => h4(startMs + i * 4 * 3600_000, 1.0 + i * 0.0002));
}
function h1(openTimeMs: number, o: number, hh: number, l: number, close: number): CandleData {
  return { openTime: new Date(openTimeMs), open: o, high: hh, low: l, close, volume: null };
}

// Beirut entry window is 03:00-12:00 (winter UTC+2 => 01:00-10:00 UTC).
// Tests that are NOT specifically about the schedule gate use candles
// spaced 24 HOURS apart (not 1h) at a fixed, comfortably-in-window UTC
// hour (05:00 UTC = 07:00 Beirut) — every candle then lands at the same
// safe local hour on its own "day," so the schedule gate never
// incidentally interferes with what those tests are actually checking.
// The dedicated schedule test below constructs its own precise hourly
// timestamps instead, since landing exactly on the window's boundary is
// the whole point there.
const SAFE_HOUR_UTC_MS = 5 * 3600_000; // 05:00 UTC
const DAY_MS = 24 * 3600_000;
const BASE_DAY = new Date('2026-01-05T00:00:00.000Z').getTime(); // a Monday

function flatH1CandlesDaily(count: number, startDayIndex: number): CandleData[] {
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + (i % 2 === 0 ? 0.02 : -0.02);
    const openTime = BASE_DAY + (startDayIndex + i) * DAY_MS + SAFE_HOUR_UTC_MS;
    return h1(openTime, base, base + 0.03, base - 0.03, base);
  });
}

const config: TrendBreakoutBacktestConfig = { volumeLots: 0.12, contractSize: 100_000, spreadPrice: 0.0001, priceIncrement: 0.00001 };

// This flat warm-up series' true range settles to a steady ~0.07 (Wilder
// ATR), so 2xA ~ 0.14 and 0.25xA ~ 0.0175 — every synthetic signal/fill
// candle below is sized well within those budgets UNLESS a test is
// deliberately exercising the gap/chase or ATR-range gate itself.
function smallBreakoutSignal(dayIndex: number): CandleData {
  return h1(BASE_DAY + dayIndex * DAY_MS + SAFE_HOUR_UTC_MS, 100.06, 100.09, 100.06, 100.08); // closes at 100.08, above the 100.05 range high, range 0.03
}

describe('runTrendBreakoutInstrumentBacktest', () => {
  it('fills a signal at the NEXT bar\'s open (no look-ahead), sizes SL/TP off the frozen ATR, and resolves a WIN at take-profit', () => {
    const h4Candles = bullishH4Candles(1400, BASE_DAY - 1400 * 4 * 3600_000);
    const warmup = flatH1CandlesDaily(60, 0);
    const s = smallBreakoutSignal(60);
    // Fill bar opens close to S.close (passes gap/chase) and stays between the eventual SL/TP itself — the RALLY happens on the bar after.
    const fillBar = h1(BASE_DAY + 61 * DAY_MS + SAFE_HOUR_UTC_MS, 100.09, 100.1, 100.08, 100.095);
    const bigWinBar = h1(BASE_DAY + 62 * DAY_MS + SAFE_HOUR_UTC_MS, 100.095, 200, 100.09, 150); // absurdly large — guarantees TP is hit, without an intervening SL hit

    const result = runTrendBreakoutInstrumentBacktest('EURUSD', h4Candles, [...warmup, s, fillBar, bigWinBar], config);

    expect(result.totalTrades).toBe(1);
    const trade = result.trades[0];
    expect(trade.direction).toBe('BUY');
    expect(trade.entryPrice).toBe(fillBar.open); // filled at the NEXT bar's open, not S's own close
    expect(trade.filledAt.getTime()).toBe(fillBar.openTime.getTime());
    expect(trade.outcome).toBe('WIN');
    expect(trade.pnlMoney).toBeGreaterThan(0);
  });

  it('never forces a scheduled exit — a position stays open across many later bars (including many "noons" and weekends) and only closes on SL/TP', () => {
    const h4Candles = bullishH4Candles(1400, BASE_DAY - 1400 * 4 * 3600_000);
    const warmup = flatH1CandlesDaily(60, 0);
    const s = smallBreakoutSignal(60);
    const fillBar = h1(BASE_DAY + 61 * DAY_MS + SAFE_HOUR_UTC_MS, 100.09, 100.1, 100.08, 100.095);
    // 60 more quiet "days," well inside the eventual SL/TP band — spans many noons and weekends with nothing forcing an exit.
    const quietBars = Array.from({ length: 60 }, (_, i) => h1(BASE_DAY + (62 + i) * DAY_MS + SAFE_HOUR_UTC_MS, 100.095, 100.1, 100.09, 100.095));

    const result = runTrendBreakoutInstrumentBacktest('EURUSD', h4Candles, [...warmup, s, fillBar, ...quietBars], config);
    expect(result.totalTrades).toBe(1);
    expect(result.trades[0].outcome).toBe('OPEN_AT_END'); // still open — nothing closed it early
  });

  it('rejects the fill via the gap/chase filter when the next bar has already run too far from S.close', () => {
    const h4Candles = bullishH4Candles(1400, BASE_DAY - 1400 * 4 * 3600_000);
    const warmup = flatH1CandlesDaily(60, 0);
    const s = smallBreakoutSignal(60);
    // Fill bar opens way beyond 0.25xA (~0.0175) from S.close (100.08).
    const fillBar = h1(BASE_DAY + 61 * DAY_MS + SAFE_HOUR_UTC_MS, 105, 105, 105, 105);
    const result = runTrendBreakoutInstrumentBacktest('EURUSD', h4Candles, [...warmup, s, fillBar], config);
    expect(result.totalTrades).toBe(0);
    expect(result.gapChaseRejections).toBe(1);
  });

  it('rejects the fill on schedule when the next bar would open exactly at noon Beirut', () => {
    // S closes (its OWN openTime) at 09:00 UTC — winter Beirut is UTC+2, so
    // the fill bar (S.openTime + 1h = 10:00 UTC = 12:00:00 Beirut) lands
    // exactly on the excluded boundary. Real hourly spacing here (not the
    // 24h-apart daily fixture above) since landing exactly on the boundary
    // is the point of this specific test.
    const sOpenTime = new Date('2026-01-05T09:00:00.000Z').getTime();
    const warmupStart = sOpenTime - 60 * 3600_000;
    const h4Candles = bullishH4Candles(1400, warmupStart - 1400 * 4 * 3600_000);
    const warmup = Array.from({ length: 60 }, (_, i) => {
      const base = 100 + (i % 2 === 0 ? 0.02 : -0.02);
      return h1(warmupStart + i * 3600_000, base, base + 0.03, base - 0.03, base);
    });
    const s = h1(sOpenTime, 100.06, 100.09, 100.06, 100.08);
    // Opens right at S.close — passes the gap/chase filter cleanly, isolating the schedule gate as the only thing under test.
    const fillBar = h1(sOpenTime + 3600_000, 100.08, 100.09, 100.07, 100.08);

    const result = runTrendBreakoutInstrumentBacktest('EURUSD', h4Candles, [...warmup, s, fillBar], config);
    expect(result.totalTrades).toBe(0);
    expect(result.scheduleRejections).toBe(1);
  });
});

describe('runCombinedTrendBreakoutBacktest', () => {
  it('runs two instruments concurrently, sharing one account equity curve and combined-risk gating', () => {
    const h4Candles = bullishH4Candles(1400, BASE_DAY - 1400 * 4 * 3600_000);
    const warmup = flatH1CandlesDaily(60, 0);
    const s = smallBreakoutSignal(60);
    const fillBar = h1(BASE_DAY + 61 * DAY_MS + SAFE_HOUR_UTC_MS, 100.09, 100.1, 100.08, 100.095);
    const bigWinBar = h1(BASE_DAY + 62 * DAY_MS + SAFE_HOUR_UTC_MS, 100.095, 200, 100.09, 150);
    const h1Candles = [...warmup, s, fillBar, bigWinBar];

    // Starting equity large enough that BOTH instruments' estimated stop
    // risk (EURUSD's 100,000 contract size dominates: ~0.105 stop distance
    // x 0.12 lots x 100,000 ~= $1,260) clears the default 0.5%/1% risk caps
    // — this test is about concurrent multi-instrument execution sharing
    // one account, not about exercising the risk-cap rejection itself
    // (that's risk-policy.spec.ts's job).
    const startingEquity = 500_000;
    const result = runCombinedTrendBreakoutBacktest(
      [
        { instrument: 'EURUSD', h4Candles, h1Candles, config },
        { instrument: 'XAUUSD', h4Candles, h1Candles, config: { ...config, contractSize: 100, priceIncrement: 0.01 } },
      ],
      startingEquity,
      { ...DEFAULT_RISK_POLICY, version: 1 },
    );

    expect(result.combinedTrades.length).toBe(2); // both instruments traded the same synthetic signal independently
    expect(result.perInstrument.EURUSD.totalTrades).toBe(1);
    expect(result.perInstrument.XAUUSD.totalTrades).toBe(1);
    expect(result.finalEquity).toBeGreaterThan(startingEquity); // both won
  });
});
