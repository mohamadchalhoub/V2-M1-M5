import { CandleData } from '../market-data/historical-candle.service';
import { calculateIchimokuState } from './ichimoku.service';
import { calculateSupportResistanceLevels } from './support-resistance.service';

export type MarketBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface MarketDirectionSignal {
  name: string;
  vote: MarketBias;
  reason: string;
}

export interface MarketDirectionAnalysis {
  symbol: string;
  dailyBias: MarketBias;
  /** Fraction of the 3 signals agreeing with the majority (1.0 = all 3 agree), not an AI confidence score — deterministic agreement only. */
  confidence: number;
  reasons: string[];
  signals: MarketDirectionSignal[];
  timeframes: string[];
  timestamp: Date;
}

// Implementation constants (not user-configurable — a plain trend cross,
// not a tuned strategy parameter).
const SHORT_SMA_PERIOD = 10;
const LONG_SMA_PERIOD = 30;

function simpleMovingAverage(candles: CandleData[], period: number): number | null {
  if (candles.length < period) return null;
  const window = candles.slice(candles.length - period);
  return window.reduce((sum, c) => sum + c.close, 0) / period;
}

function ichimokuTrendSignal(h4Candles: CandleData[]): MarketDirectionSignal {
  const state = calculateIchimokuState(h4Candles, 'H4');
  if (state.position === 'ABOVE_CLOUD') {
    return { name: 'H4_ICHIMOKU_TREND', vote: 'BULLISH', reason: 'H4 Ichimoku trend condition is bullish (price above the cloud)' };
  }
  if (state.position === 'BELOW_CLOUD') {
    return { name: 'H4_ICHIMOKU_TREND', vote: 'BEARISH', reason: 'H4 Ichimoku trend condition is bearish (price below the cloud)' };
  }
  return {
    name: 'H4_ICHIMOKU_TREND',
    vote: 'NEUTRAL',
    reason: state.position === 'INSIDE_CLOUD' ? 'H4 price is inside the Ichimoku cloud (no clear trend)' : 'insufficient H4 history for the Ichimoku signal',
  };
}

/** Classic higher-highs/higher-lows (bullish) vs lower-highs/lower-lows (bearish) structure, from the same fractal pivots support-resistance.service.ts already computes. */
function marketStructureSignal(h4Candles: CandleData[]): MarketDirectionSignal {
  const levels = calculateSupportResistanceLevels(h4Candles, 'H4');
  const resistances = levels.filter((l) => l.type === 'RESISTANCE').sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const supports = levels.filter((l) => l.type === 'SUPPORT').sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  if (resistances.length < 2 || supports.length < 2) {
    return { name: 'H4_MARKET_STRUCTURE', vote: 'NEUTRAL', reason: 'insufficient H4 pivot history for a market-structure signal' };
  }

  const [prevHigh, lastHigh] = resistances.slice(-2);
  const [prevLow, lastLow] = supports.slice(-2);

  if (lastHigh.price > prevHigh.price && lastLow.price > prevLow.price) {
    return { name: 'H4_MARKET_STRUCTURE', vote: 'BULLISH', reason: 'H4 market structure remains bullish (higher highs and higher lows)' };
  }
  if (lastHigh.price < prevHigh.price && lastLow.price < prevLow.price) {
    return { name: 'H4_MARKET_STRUCTURE', vote: 'BEARISH', reason: 'H4 market structure remains bearish (lower highs and lower lows)' };
  }
  return { name: 'H4_MARKET_STRUCTURE', vote: 'NEUTRAL', reason: 'H4 structure shows no consistent higher-high/higher-low or lower-high/lower-low pattern' };
}

function smaTrendSignal(d1Candles: CandleData[]): MarketDirectionSignal {
  const shortSma = simpleMovingAverage(d1Candles, SHORT_SMA_PERIOD);
  const longSma = simpleMovingAverage(d1Candles, LONG_SMA_PERIOD);
  if (shortSma === null || longSma === null) {
    return { name: 'D1_SMA_TREND', vote: 'NEUTRAL', reason: 'insufficient D1 history for the SMA trend signal' };
  }
  if (shortSma > longSma) {
    return { name: 'D1_SMA_TREND', vote: 'BULLISH', reason: `D1 ${SHORT_SMA_PERIOD}-day SMA is above the ${LONG_SMA_PERIOD}-day SMA` };
  }
  if (shortSma < longSma) {
    return { name: 'D1_SMA_TREND', vote: 'BEARISH', reason: `D1 ${SHORT_SMA_PERIOD}-day SMA is below the ${LONG_SMA_PERIOD}-day SMA` };
  }
  return { name: 'D1_SMA_TREND', vote: 'NEUTRAL', reason: 'D1 short and long SMA are equal' };
}

/**
 * A deliberately small, named 3-signal majority vote (user's own explicit
 * "do not silently create a complex new strategy" instruction) — H4
 * Ichimoku trend, H4 market structure, and D1 SMA trend, mirroring the
 * user's own example reasons verbatim ("H4 market structure remains
 * bullish... Ichimoku trend condition is bullish"). Nothing more elaborate
 * is added. Pure — h4Candles/d1Candles are already-fetched.
 */
export function calculateMarketDirection(symbol: string, h4Candles: CandleData[], d1Candles: CandleData[], now: Date): MarketDirectionAnalysis {
  const signals = [ichimokuTrendSignal(h4Candles), marketStructureSignal(h4Candles), smaTrendSignal(d1Candles)];

  const bullishCount = signals.filter((s) => s.vote === 'BULLISH').length;
  const bearishCount = signals.filter((s) => s.vote === 'BEARISH').length;

  let dailyBias: MarketBias = 'NEUTRAL';
  if (bullishCount > bearishCount) dailyBias = 'BULLISH';
  else if (bearishCount > bullishCount) dailyBias = 'BEARISH';

  const agreement = Math.max(bullishCount, bearishCount);
  const confidence = agreement / signals.length;

  return {
    symbol,
    dailyBias,
    confidence,
    reasons: signals.map((s) => s.reason),
    signals,
    timeframes: ['H4', 'D1'],
    timestamp: now,
  };
}
