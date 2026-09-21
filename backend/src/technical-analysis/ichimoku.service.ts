import { CandleTimeframe } from '@prisma/client';
import { CandleData } from '../market-data/historical-candle.service';

// Standard Ichimoku Kinko Hyo periods — a universal, decades-old
// convention (Tenkan 9 / Kijun 26 / Senkou B 52 / displacement 26), not a
// value anyone tunes per-symbol. Treated as implementation constants, not
// env config, per the user's own "don't add unnecessary configuration for
// values that are truly implementation constants" instruction.
const TENKAN_PERIOD = 9;
const KIJUN_PERIOD = 26;
const SENKOU_B_PERIOD = 52;
const DISPLACEMENT = 26;

export type CloudPosition = 'ABOVE_CLOUD' | 'BELOW_CLOUD' | 'INSIDE_CLOUD';

export interface IchimokuState {
  timeframe: CandleTimeframe;
  /** The closed candle this state reflects. */
  timestamp: Date;
  close: number;
  spanA: number | null;
  spanB: number | null;
  position: CloudPosition | 'INSUFFICIENT_DATA';
}

export interface IchimokuBreakout {
  timeframe: CandleTimeframe;
  direction: 'BULLISH' | 'BEARISH';
  previousState: CloudPosition;
  newState: CloudPosition;
  /** The close that confirmed the breakout. */
  breakoutPrice: number;
  timestamp: Date;
}

function highLowMidpoint(candles: CandleData[], endIndex: number, period: number): number | null {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  const window = candles.slice(start, endIndex + 1);
  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  return (high + low) / 2;
}

/**
 * Senkou Span A/B are calculated from data as of `DISPLACEMENT` periods
 * ago and plotted forward — the cloud value "active" at candle index i was
 * computed using the window ending at (i - DISPLACEMENT), not the window
 * ending at i itself. Getting this displacement right is what makes the
 * cloud a leading indicator rather than a coincident one.
 */
function activeCloudAt(candles: CandleData[], index: number): { spanA: number; spanB: number } | null {
  const sourceIndex = index - DISPLACEMENT;
  if (sourceIndex < 0) return null;

  const tenkan = highLowMidpoint(candles, sourceIndex, TENKAN_PERIOD);
  const kijun = highLowMidpoint(candles, sourceIndex, KIJUN_PERIOD);
  const spanB = highLowMidpoint(candles, sourceIndex, SENKOU_B_PERIOD);
  if (tenkan === null || kijun === null || spanB === null) return null;

  return { spanA: (tenkan + kijun) / 2, spanB };
}

function cloudPositionOf(close: number, spanA: number, spanB: number): CloudPosition {
  const top = Math.max(spanA, spanB);
  const bottom = Math.min(spanA, spanB);
  if (close > top) return 'ABOVE_CLOUD';
  if (close < bottom) return 'BELOW_CLOUD';
  return 'INSIDE_CLOUD';
}

/** Current Ichimoku cloud state for the latest closed candle. Pure — candles are already-fetched. */
export function calculateIchimokuState(candles: CandleData[], timeframe: CandleTimeframe): IchimokuState {
  if (candles.length === 0) {
    return { timeframe, timestamp: new Date(0), close: 0, spanA: null, spanB: null, position: 'INSUFFICIENT_DATA' };
  }
  const lastIndex = candles.length - 1;
  const last = candles[lastIndex];
  const cloud = activeCloudAt(candles, lastIndex);
  if (!cloud) {
    return { timeframe, timestamp: last.openTime, close: last.close, spanA: null, spanB: null, position: 'INSUFFICIENT_DATA' };
  }
  return {
    timeframe,
    timestamp: last.openTime,
    close: last.close,
    spanA: cloud.spanA,
    spanB: cloud.spanB,
    position: cloudPositionOf(last.close, cloud.spanA, cloud.spanB),
  };
}

/**
 * A confirmed breakout: the latest CLOSED candle's close is definitively on
 * the opposite side of the cloud from the prior closed candle's close.
 * Candle-close confirmation only (user's explicit preference) — never an
 * intra-candle/live-price trigger. Distinguishes "confirmed breakout" from
 * merely touching or entering the cloud: a transition INTO
 * `INSIDE_CLOUD` from either side is never itself a breakout — only a
 * transition that lands definitively ABOVE or BELOW counts, whether it
 * came from the opposite side or from inside the cloud.
 */
export function detectIchimokuBreakout(candles: CandleData[], timeframe: CandleTimeframe): IchimokuBreakout | null {
  if (candles.length < 2) return null;

  const lastIndex = candles.length - 1;
  const prevCloud = activeCloudAt(candles, lastIndex - 1);
  const currCloud = activeCloudAt(candles, lastIndex);
  if (!prevCloud || !currCloud) return null;

  const prevCandle = candles[lastIndex - 1];
  const currCandle = candles[lastIndex];
  const previousState = cloudPositionOf(prevCandle.close, prevCloud.spanA, prevCloud.spanB);
  const newState = cloudPositionOf(currCandle.close, currCloud.spanA, currCloud.spanB);

  if (previousState === newState) return null;

  if (newState === 'ABOVE_CLOUD') {
    return { timeframe, direction: 'BULLISH', previousState, newState, breakoutPrice: currCandle.close, timestamp: currCandle.openTime };
  }
  if (newState === 'BELOW_CLOUD') {
    return { timeframe, direction: 'BEARISH', previousState, newState, breakoutPrice: currCandle.close, timestamp: currCandle.openTime };
  }
  // Transition landed INSIDE_CLOUD (from ABOVE or BELOW) — entering the
  // cloud, not a confirmed breakout to the other side.
  return null;
}
