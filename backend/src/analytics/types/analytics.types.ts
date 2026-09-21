// Shapes returned by analytics/. See ANALYTICS_SPEC.md for the formula,
// source, and null/zero handling behind every field.

export interface AccountSessionMetrics {
  startingBalance: number | null;
  currentBalance: number | null;
  currentEquity: number | null;
  dailyPl: number | null;
  dailyProfit: number | null;
  dailyLoss: number | null;
  drawdown: number | null;
  maxDrawdown: number | null;
  // Live-test production-readiness pass (item C, MARGIN_UTILIZATION) — taken
  // straight from the latest AccountSnapshot, already fetched for
  // currentBalance/currentEquity above; no new query. null only when no
  // snapshot exists yet at all (same "no data yet" meaning as the others).
  margin: number | null;
  freeMargin: number | null;
  marginLevel: number | null;
}

export interface TradingActivityMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number | null;
  averageWinningTrade: number | null;
  averageLosingTrade: number | null;
  largestWinningTrade: number | null;
  largestLosingTrade: number | null;
  totalRealizedPlGross: number;
  totalRealizedPl: number;
  totalCommission: number;
  totalSwap: number;
}

export interface PositionVolumeBySymbol {
  symbol: string;
  totalVolume: number;
  count: number;
}

export interface PositionBehaviorMetrics {
  currentOpenPositions: number;
  currentTotalVolume: number;
  maximumPositionVolume: number | null;
  positionVolumeBySymbol: PositionVolumeBySymbol[];
  numberOfSimultaneousPositions: number;
  averageHistoricalPositionVolume: number | null;
  // Live-test production-readiness pass (items E/F, NO_STOP_LOSS/CONCENTRATION)
  // — all derived from the same open-positions query already run above, no
  // new DB round-trip.
  openPositionsWithoutStopLoss: number;
  /** Largest single symbol's share of total open volume, 0-1 fraction; null when currentTotalVolume is 0 (nothing open — a known state, not missing data). */
  maximumSymbolConcentrationPct: number | null;
  /** Largest single direction's (BUY or SELL) share of total open volume, 0-1 fraction; same null convention as above. */
  maximumDirectionConcentrationPct: number | null;
}

export interface TradingFrequencyMetrics {
  tradesPerDay: number;
  tradesPerHour: number;
  averageTimeBetweenTrades: number | null;
  averageTradesPerSession: number | null;
}

export interface BehavioralSequenceMetrics {
  currentConsecutiveWins: number;
  currentConsecutiveLosses: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
}

export interface CurrentMetrics {
  account: AccountSessionMetrics;
  activity: TradingActivityMetrics;
  position: PositionBehaviorMetrics;
  frequency: TradingFrequencyMetrics;
  sequences: BehavioralSequenceMetrics;
}

export interface HistoricalBaselines {
  windowDays: number;
  windowStart: Date;
  windowEnd: Date;
  averageDailyPl: number | null;
  averageDailyLoss: number | null;
  averageTradesPerDay: number | null;
  averagePositionVolume: number | null;
  maximumNormalPositionVolume: number | null;
  averageTradeDuration: number | null;
  averageLosingTrade: number | null;
  averageWinningTrade: number | null;
  averageTradesPerHour: number | null;
}
