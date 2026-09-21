/**
 * §9 — stop-loss/take-profit sizing off the frozen ATR (A), and broker
 * price-increment rounding. Pure, no I/O.
 */

export interface SlTpDistances {
  /** 1.5 x A, before any broker rounding. */
  rawStopDistance: number;
  /** 3 x A, before any broker rounding. */
  rawTargetDistance: number;
}

export const STOP_ATR_MULTIPLIER = 1.5;
export const TARGET_ATR_MULTIPLIER = 3;

export function computeRawDistances(atr: number): SlTpDistances {
  return { rawStopDistance: STOP_ATR_MULTIPLIER * atr, rawTargetDistance: TARGET_ATR_MULTIPLIER * atr };
}

export interface RoundedSlTp {
  stopLoss: number;
  takeProfit: number;
  /** The ACTUAL distance after rounding — §9: "include its effect in estimated risk," never the pre-rounding theoretical distance. */
  roundedStopDistance: number;
  roundedTargetDistance: number;
}

export type SlTpComputationError = { error: string };

function roundToIncrement(price: number, increment: number): number {
  // Round-half-away-from-zero at the increment boundary, then re-snap
  // through a fixed-precision string pass — plain `Math.round(price /
  // increment) * increment` reproduces ordinary binary floating-point
  // noise (e.g. an increment of 0.01 can yield 2650.0299999999997), which
  // would then get compared against broker/step tolerances incorrectly
  // downstream.
  const decimals = decimalPlacesOf(increment);
  const snapped = Math.round(price / increment) * increment;
  return Number(snapped.toFixed(Math.max(decimals, 0)));
}

function decimalPlacesOf(increment: number): number {
  const s = increment.toString();
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

/**
 * §9 — "Use valid broker price increments. Document price rounding, include
 * its effect in estimated risk, and do not silently expand the strategy's
 * distances to satisfy broker restrictions. Reject an incompatible setup."
 *
 * `priceIncrement` is the broker's smallest tradable price step for this
 * symbol (from `SymbolMetadata.point`, or its `trade_tick_size` if that
 * differs from `point` — MT5 exposes both; this project uses `point`
 * unless/until a broker is found where they diverge, documented here
 * rather than silently assumed identical forever). A setup is REJECTED
 * (not silently widened) if rounding would collapse the stop distance to
 * zero or flip its sign — i.e. the increment is larger than the intended
 * stop distance itself, which can only happen with a pathological
 * increment/ATR combination.
 */
export function computeRoundedSlTp(side: 'BUY' | 'SELL', fillPrice: number, atr: number, priceIncrement: number): RoundedSlTp | SlTpComputationError {
  if (!(priceIncrement > 0)) {
    return { error: `Invalid price increment ${priceIncrement} — refusing to compute SL/TP without a real broker price step.` };
  }
  if (!(atr > 0)) {
    return { error: `Invalid frozen ATR ${atr} — refusing to compute SL/TP from a non-positive volatility reference.` };
  }

  const { rawStopDistance, rawTargetDistance } = computeRawDistances(atr);
  const isBuy = side === 'BUY';

  const rawStopLoss = isBuy ? fillPrice - rawStopDistance : fillPrice + rawStopDistance;
  const rawTakeProfit = isBuy ? fillPrice + rawTargetDistance : fillPrice - rawTargetDistance;

  const stopLoss = roundToIncrement(rawStopLoss, priceIncrement);
  const takeProfit = roundToIncrement(rawTakeProfit, priceIncrement);

  const roundedStopDistance = Math.abs(fillPrice - stopLoss);
  const roundedTargetDistance = Math.abs(fillPrice - takeProfit);

  // Reject rather than silently widen (§9's explicit instruction) — rounding
  // must never collapse the stop to zero distance or flip which side of
  // entry it lands on (both would mean the increment is larger than the
  // intended stop itself, a broken/pathological configuration, not a
  // normal rounding nudge).
  const stopOnWrongSide = isBuy ? stopLoss >= fillPrice : stopLoss <= fillPrice;
  const targetOnWrongSide = isBuy ? takeProfit <= fillPrice : takeProfit >= fillPrice;
  if (roundedStopDistance === 0 || stopOnWrongSide) {
    return { error: `Broker price increment ${priceIncrement} is too coarse relative to the ${rawStopDistance.toFixed(6)} stop distance — rounding would collapse or invert the stop. Rejecting this setup rather than expanding it.` };
  }
  if (roundedTargetDistance === 0 || targetOnWrongSide) {
    return { error: `Broker price increment ${priceIncrement} is too coarse relative to the ${rawTargetDistance.toFixed(6)} target distance — rounding would collapse or invert the target. Rejecting this setup rather than expanding it.` };
  }

  return { stopLoss, takeProfit, roundedStopDistance, roundedTargetDistance };
}

export function isSlTpError(result: RoundedSlTp | SlTpComputationError): result is SlTpComputationError {
  return 'error' in result;
}
