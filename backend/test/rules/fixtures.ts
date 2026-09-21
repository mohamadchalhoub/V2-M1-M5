import { CurrentMetrics, HistoricalBaselines } from '../../src/analytics/types/analytics.types';

/** Deterministic, fully-populated CurrentMetrics — no live MT5, no Postgres. Override only what a test cares about. */
export function currentMetricsFixture(
  overrides: Partial<{
    account: Partial<CurrentMetrics['account']>;
    activity: Partial<CurrentMetrics['activity']>;
    position: Partial<CurrentMetrics['position']>;
    frequency: Partial<CurrentMetrics['frequency']>;
    sequences: Partial<CurrentMetrics['sequences']>;
  }> = {},
): CurrentMetrics {
  return {
    account: {
      startingBalance: 10_000,
      currentBalance: 10_000,
      currentEquity: 10_000,
      dailyPl: 0,
      dailyProfit: 0,
      dailyLoss: 0,
      drawdown: 0,
      maxDrawdown: 0,
      margin: 0,
      freeMargin: 10_000,
      marginLevel: 0,
      ...overrides.account,
    },
    activity: {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: null,
      averageWinningTrade: null,
      averageLosingTrade: null,
      largestWinningTrade: null,
      largestLosingTrade: null,
      totalRealizedPlGross: 0,
      totalRealizedPl: 0,
      totalCommission: 0,
      totalSwap: 0,
      ...overrides.activity,
    },
    position: {
      currentOpenPositions: 0,
      currentTotalVolume: 0,
      maximumPositionVolume: null,
      positionVolumeBySymbol: [],
      numberOfSimultaneousPositions: 0,
      averageHistoricalPositionVolume: null,
      openPositionsWithoutStopLoss: 0,
      maximumSymbolConcentrationPct: null,
      maximumDirectionConcentrationPct: null,
      ...overrides.position,
    },
    frequency: {
      tradesPerDay: 0,
      tradesPerHour: 0,
      averageTimeBetweenTrades: null,
      averageTradesPerSession: null,
      ...overrides.frequency,
    },
    sequences: {
      currentConsecutiveWins: 0,
      currentConsecutiveLosses: 0,
      maxConsecutiveWins: 0,
      maxConsecutiveLosses: 0,
      ...overrides.sequences,
    },
  };
}

export function historicalBaselinesFixture(overrides: Partial<HistoricalBaselines> = {}): HistoricalBaselines {
  return {
    windowDays: 90,
    windowStart: new Date('2026-01-01T00:00:00Z'),
    windowEnd: new Date('2026-04-01T00:00:00Z'),
    averageDailyPl: null,
    averageDailyLoss: null,
    averageTradesPerDay: null,
    averagePositionVolume: null,
    maximumNormalPositionVolume: null,
    averageTradeDuration: null,
    averageLosingTrade: null,
    averageWinningTrade: null,
    averageTradesPerHour: null,
    ...overrides,
  };
}

/** The "bad session" worked example from RULE_ENGINE_SPEC.md §2.6 / Phase 0 §23. */
export const BAD_SESSION = {
  current: currentMetricsFixture({
    account: { drawdown: 0.038 },
    sequences: { currentConsecutiveLosses: 4 },
    position: { maximumPositionVolume: 0.5 },
  }),
  baseline: historicalBaselinesFixture({ averagePositionVolume: 0.2 }),
};
