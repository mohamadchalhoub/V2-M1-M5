import { CandleData } from '../market-data/historical-candle.service';
import { failGate, GateResult, passGate } from './gate-result';
import { calculateAtr, calculateEma, H1_ATR_PERIOD, H4_EMA_FAST, H4_EMA_SLOW, isAtrSettled, isEmaSettled } from './indicators';

export type TrendBreakoutDirection = 'BUY' | 'SELL';
export type { GateResult };

export const BREAKOUT_LOOKBACK_BARS = 20;
export const ATR_RANGE_MULTIPLIER = 2;

export interface H4TrendSnapshot {
  closeAt: Date;
  close: number;
  ema50: number;
  ema200: number;
}

export interface H1BreakoutSnapshot {
  signalCloseAt: Date;
  signalClose: number;
  signalHigh: number;
  signalLow: number;
  rangeHigh: number;
  rangeLow: number;
}

export interface TrendBreakoutSignalResult {
  direction: TrendBreakoutDirection | null;
  gateResults: GateResult[];
  h4: H4TrendSnapshot | null;
  h1: H1BreakoutSnapshot | null;
  /** Frozen A — ATR14 through the H1 candle immediately preceding S (§5), never S itself. */
  atr: number | null;
}

export interface TrendBreakoutSignalInput {
  /**
   * Completed H4 candles, chronological, ending at "the latest H4 candle
   * whose closing time is <= the decision time" (§5) — the caller (the live
   * evaluation loop, or the backtest) is responsible for that slicing;
   * this function trusts the LAST element of this array is that candle and
   * never looks past it.
   */
  h4Candles: CandleData[];
  /**
   * Completed H1 candles, chronological, ending at signal candle S (the
   * last element IS S). Must contain at least
   * `BREAKOUT_LOOKBACK_BARS + 2` candles before gate 3/4 can be evaluated
   * (20 for S's own range, 1 more for the previous candle's own prior-20
   * range) — a shorter array fails the warm-up gate below, never partially
   * evaluates.
   */
  h1Candles: CandleData[];
}

const fail = failGate;
const pass = passGate;

/**
 * §6/§7 — the deterministic H4-trend / H1-breakout signal. Pure function,
 * no I/O, no AI, no randomness: the same inputs always produce the same
 * gate results and the same direction (§1's "decisions must be
 * deterministic and reproducible"). Used unchanged by both the live
 * evaluation path and the backtest (`backtest.ts`) — never two independent
 * implementations of the same rule.
 *
 * Evaluates ONE trend regime at a time: H4 close/EMA50/EMA200 first decide
 * whether this is a BULLISH, BEARISH, or NO-TREND bar; only the breakout
 * side matching that regime is ever checked (a bullish H4 regime never
 * evaluates a SELL breakout, and vice versa) — this keeps the gate log
 * focused on what could ACTUALLY have qualified, rather than padding it
 * with a mirror-image check that was never in contention.
 */
export function evaluateTrendBreakoutSignal(input: TrendBreakoutSignalInput): TrendBreakoutSignalResult {
  const { h4Candles, h1Candles } = input;
  const gateResults: GateResult[] = [];

  // --- H4 warm-up -----------------------------------------------------
  const h4Closes = h4Candles.map((c) => c.close);
  const h4Ema50Series = calculateEma(h4Closes, H4_EMA_FAST);
  const h4Ema200Series = calculateEma(h4Closes, H4_EMA_SLOW);
  const h4LastIndex = h4Candles.length - 1;

  if (h4LastIndex < 0 || !isEmaSettled(h4LastIndex, H4_EMA_SLOW)) {
    gateResults.push(
      fail(
        'h4_warmup',
        `Insufficient H4 warm-up: ${h4Candles.length} candle(s) available, need >= ${H4_EMA_SLOW.period * H4_EMA_SLOW.settleMultiplier} for a settled EMA${H4_EMA_SLOW.period}.`,
      ),
    );
    return { direction: null, gateResults, h4: null, h1: null, atr: null };
  }
  gateResults.push(pass('h4_warmup', `${h4Candles.length} H4 candles available (>= ${H4_EMA_SLOW.period * H4_EMA_SLOW.settleMultiplier} required).`));

  const h4Close = h4Candles[h4LastIndex].close;
  const h4Ema50 = h4Ema50Series[h4LastIndex]!;
  const h4Ema200 = h4Ema200Series[h4LastIndex]!;
  const h4: H4TrendSnapshot = { closeAt: h4Candles[h4LastIndex].openTime, close: h4Close, ema50: h4Ema50, ema200: h4Ema200 };

  let regime: TrendBreakoutDirection | null = null;
  if (h4Close > h4Ema200 && h4Ema50 > h4Ema200) {
    regime = 'BUY';
    gateResults.push(pass('h4_trend', `Bullish H4 regime: close ${h4Close} > EMA200 ${h4Ema200.toFixed(6)} and EMA50 ${h4Ema50.toFixed(6)} > EMA200.`));
  } else if (h4Close < h4Ema200 && h4Ema50 < h4Ema200) {
    regime = 'SELL';
    gateResults.push(pass('h4_trend', `Bearish H4 regime: close ${h4Close} < EMA200 ${h4Ema200.toFixed(6)} and EMA50 ${h4Ema50.toFixed(6)} < EMA200.`));
  } else {
    gateResults.push(
      fail('h4_trend', `No clear H4 trend regime: close=${h4Close}, EMA50=${h4Ema50.toFixed(6)}, EMA200=${h4Ema200.toFixed(6)} (conditions 1/2 of §6-§7 require BOTH strictly on the same side).`),
    );
    return { direction: null, gateResults, h4, h1: null, atr: null };
  }

  // --- H1 warm-up -------------------------------------------------------
  const minH1Candles = BREAKOUT_LOOKBACK_BARS + 2; // S's own 20-bar range + 1 more for the previous candle's own prior-20 range
  if (h1Candles.length < minH1Candles) {
    gateResults.push(fail('h1_warmup', `Insufficient H1 candles: ${h1Candles.length} available, need >= ${minH1Candles} for the breakout + fresh-breakout check.`));
    return { direction: null, gateResults, h4, h1: null, atr: null };
  }

  const atrSeriesThroughAllH1 = calculateAtr(h1Candles, H1_ATR_PERIOD);
  const sIndex = h1Candles.length - 1;
  const prevIndex = sIndex - 1; // the H1 candle immediately preceding S
  if (!isAtrSettled(prevIndex, H1_ATR_PERIOD)) {
    gateResults.push(fail('h1_warmup', `Insufficient H1 warm-up for a settled ATR${H1_ATR_PERIOD}: need >= ${H1_ATR_PERIOD * 3} candles before S, have ${prevIndex + 1}.`));
    return { direction: null, gateResults, h4, h1: null, atr: null };
  }
  gateResults.push(pass('h1_warmup', `${h1Candles.length} H1 candles available (>= ${minH1Candles} required); ATR settled.`));

  // §5 — "The volatility reference A is ATR14 calculated through the H1
  // candle immediately preceding S. Freeze A for the resulting setup."
  // Computed through `prevIndex`, deliberately NOT recomputed including S.
  const atr = atrSeriesThroughAllH1[prevIndex]!;

  const s = h1Candles[sIndex];
  const prev = h1Candles[prevIndex];

  // Condition 3 — S's own 20-bar breakout range EXCLUDES S itself.
  const rangeCandles = h1Candles.slice(sIndex - BREAKOUT_LOOKBACK_BARS, sIndex);
  const rangeHigh = Math.max(...rangeCandles.map((c) => c.high));
  const rangeLow = Math.min(...rangeCandles.map((c) => c.low));

  const h1: H1BreakoutSnapshot = { signalCloseAt: s.openTime, signalClose: s.close, signalHigh: s.high, signalLow: s.low, rangeHigh, rangeLow };

  const breakoutOk = regime === 'BUY' ? s.close > rangeHigh : s.close < rangeLow;
  if (!breakoutOk) {
    gateResults.push(
      fail(
        'h1_breakout',
        regime === 'BUY'
          ? `S.close ${s.close} does not exceed the preceding 20-bar high ${rangeHigh} (strict >).`
          : `S.close ${s.close} does not go below the preceding 20-bar low ${rangeLow} (strict <).`,
      ),
    );
    return { direction: null, gateResults, h4, h1, atr };
  }
  gateResults.push(
    pass('h1_breakout', regime === 'BUY' ? `S.close ${s.close} > 20-bar high ${rangeHigh}.` : `S.close ${s.close} < 20-bar low ${rangeLow}.`),
  );

  // Condition 4 — fresh breakout: the PREVIOUS H1 candle must NOT already
  // have closed beyond ITS OWN preceding 20-bar range (excluding itself).
  const prevRangeCandles = h1Candles.slice(prevIndex - BREAKOUT_LOOKBACK_BARS, prevIndex);
  const prevRangeHigh = Math.max(...prevRangeCandles.map((c) => c.high));
  const prevRangeLow = Math.min(...prevRangeCandles.map((c) => c.low));
  const prevAlreadyBrokeOut = regime === 'BUY' ? prev.close > prevRangeHigh : prev.close < prevRangeLow;
  if (prevAlreadyBrokeOut) {
    gateResults.push(
      fail(
        'fresh_breakout',
        regime === 'BUY'
          ? `Not a fresh breakout: the previous H1 candle (close ${prev.close}) had already closed above ITS OWN preceding 20-bar high ${prevRangeHigh}.`
          : `Not a fresh breakout: the previous H1 candle (close ${prev.close}) had already closed below ITS OWN preceding 20-bar low ${prevRangeLow}.`,
      ),
    );
    return { direction: null, gateResults, h4, h1, atr };
  }
  gateResults.push(pass('fresh_breakout', `Previous H1 candle (close ${prev.close}) had NOT already broken its own prior-20 range — this is a fresh breakout event.`));

  // Condition 5 — ATR range filter.
  const signalRange = s.high - s.low;
  const maxRange = ATR_RANGE_MULTIPLIER * atr;
  if (signalRange > maxRange) {
    gateResults.push(fail('atr_range_filter', `S's own range ${signalRange.toFixed(6)} exceeds ${ATR_RANGE_MULTIPLIER} x A (${maxRange.toFixed(6)}) — too volatile a signal bar, skipping.`));
    return { direction: null, gateResults, h4, h1, atr };
  }
  gateResults.push(pass('atr_range_filter', `S's own range ${signalRange.toFixed(6)} <= ${ATR_RANGE_MULTIPLIER} x A (${maxRange.toFixed(6)}).`));

  return { direction: regime, gateResults, h4, h1, atr };
}
