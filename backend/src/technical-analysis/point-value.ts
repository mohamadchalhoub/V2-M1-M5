/**
 * User's Rule 1 (support/resistance proximity) — "the system must document
 * internally what a point means for EURUSD... do not silently confuse
 * pip/point/pipette." No symbol-metadata fetch exists anywhere in this
 * system (the collector never calls MetaTrader5's `symbol_info()`) —
 * building one just to answer this would be new architecture for a system
 * that only ever trades EURUSD. Instead this is a documented, explicit
 * constant, verified against real stored candle data in this deployment
 * (`historical_candles.close` values like `1.161460` — 5 significant
 * decimal digits, a trailing zero at the 6th), which is the standard
 * 5-digit EURUSD broker quoting convention:
 *
 * - MT5's own "point" (`SymbolInfo.point`) is the smallest price
 *   increment: 0.00001 (the 5th decimal).
 * - A traditional forex "pip" is 10 points: 0.0001 (the 4th decimal).
 * - A "pipette" is the same thing as MT5's point at 5-digit quoting —
 *   the two terms describe the same increment; this module always says
 *   "point" to match the user's own rule wording and MT5's terminology.
 *
 * So "50 points" (the user's Rule 1 example) = 0.00050 = 5 traditional pips.
 */
export const EURUSD_POINT_SIZE = 0.00001;
export const EURUSD_PIP_SIZE = EURUSD_POINT_SIZE * 10;

/**
 * Absolute price distance between two prices, expressed in EURUSD points.
 * Rounded to 6 decimal places of POINTS (i.e. noise far below any
 * meaningful fractional point) — found live in this session: dividing a
 * floating-point price difference by the tiny 0.00001 point size amplifies
 * ordinary binary floating-point representation error (e.g. `1.105 -
 * 1.1045` is `0.0004999999999999449`, not exactly `0.0005`), which was
 * enough to make an exact-threshold comparison like "retraced >= 50
 * points" fail on inputs that are mathematically exactly 50.
 */
export function priceDistanceInPoints(priceA: number, priceB: number): number {
  return Math.round((Math.abs(priceA - priceB) / EURUSD_POINT_SIZE) * 1e6) / 1e6;
}

export function pointsToPrice(points: number): number {
  return points * EURUSD_POINT_SIZE;
}
