import { CandleData } from '../market-data/historical-candle.service';
import { TrendBreakoutInstrumentId } from './instrument-config';
import { checkGapChaseFilter } from './entry-timing';
import { evaluateCombinedRiskGate, evaluateDailyLossGate, evaluateDrawdownGate, evaluateTradeRiskGate, RiskPolicyConfig, updateCashFlowAdjustedHigh } from './risk-policy';
import { evaluateTrendBreakoutSignal, TrendBreakoutDirection } from './signal-engine';
import { computeRoundedSlTp, isSlTpError } from './sl-tp';
import { getBeirutCalendarDate, isWithinEntryWindow } from './schedule';

/**
 * §13 — "reuse the corrected chronological, bid/ask-aware simulator and
 * shared mechanical/confirmation pipeline." This engine reuses that SAME
 * architecture (`backend/src/autonomous/backtest-simulator.ts`'s
 * `runBacktestWithConfirmation`): evaluate a signal using only data through
 * a bar's own close (no look-ahead), QUEUE it, fill on the next bar's data,
 * and resolve exits with side-aware bid/ask pricing. It is a NEW function,
 * not a call into that file, for one concrete reason: that engine's own
 * P&L math (`resolveOutcomeSideAware`/`summarize`) is hardcoded to EURUSD
 * "points" via `priceDistanceInPoints` (divides by the fixed
 * `EURUSD_POINT_SIZE`), which is meaningless for XAUUSD — this strategy
 * must work symbol-agnostically (§2's two allowed instruments), so P&L here
 * is tracked in raw price units and converted to money via each
 * instrument's own contract size, never in "points." The no-look-ahead /
 * side-aware-spread SHAPE of the loop is deliberately identical, not
 * reinvented independently.
 *
 * Bar-data limitation, disclosed per §13's own instruction ("if only bars
 * exist, label next-open entries and freshness/expiry modeling as
 * approximations; do not claim exact live-execution validation"): §8's
 * literal 60-second setup expiry cannot be meaningfully modeled against
 * hourly bars (the earliest a bar-only backtest can ever fill is the NEXT
 * H1 candle's open, up to ~3600s after S's close — always past a 60s
 * expiry). This engine therefore does NOT apply the 60s wall-clock expiry
 * rule at all; it fills at the next H1 candle's open as the approximation
 * of "the first eligible fresh executable quote," and still applies the
 * REAL §8 gap/chase filter (|fill price - S.close| <= 0.25 x A) against
 * that fill — a signal whose price has already run too far by the next
 * bar's open is correctly dropped, exactly as it would be live. This is a
 * genuine, disclosed modeling gap, not a silent one: the live/operational
 * code path (`entry-timing.ts`) DOES enforce the literal 60-second expiry,
 * since a live loop has real sub-minute quotes to check it against.
 */

export interface TrendBreakoutBacktestConfig {
  volumeLots: number;
  contractSize: number;
  spreadPrice: number; // constant spread assumption, same convention as the legacy engine's own spreadPoints assumption
  priceIncrement: number;
  /** H1 candle count used as the rolling window fed to the signal engine on each bar — must be large enough to satisfy H1 warm-up (BREAKOUT_LOOKBACK_BARS + 2, ATR settle). */
}

export interface TrendBreakoutBacktestTrade {
  instrument: TrendBreakoutInstrumentId;
  direction: TrendBreakoutDirection;
  signalCloseAt: Date;
  filledAt: Date;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  atr: number;
  closedAt: Date | null;
  outcome: 'WIN' | 'LOSS' | 'OPEN_AT_END';
  /** Raw signed price distance (positive = profit), NOT points — see module comment. */
  pnlPrice: number;
  pnlMoney: number;
}

export interface GateRejectionCounts {
  [gate: string]: number;
}

export interface TrendBreakoutBacktestResult {
  trades: TrendBreakoutBacktestTrade[];
  totalTrades: number;
  wins: number;
  losses: number;
  openAtEnd: number;
  winRate: number | null;
  profitFactorMoney: number | null;
  totalPnlMoney: number;
  maxDrawdownMoney: number;
  avgHoldingHours: number | null;
  gateRejectionCounts: GateRejectionCounts;
  /** How many otherwise-valid signals were dropped by the gap/chase filter at the (approximated) next-open fill — a real, disclosed effect of the bar-only approximation, tracked separately from the signal engine's own gates. */
  gapChaseRejections: number;
  scheduleRejections: number;
}

interface OpenPos {
  direction: TrendBreakoutDirection;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  atr: number;
  signalCloseAt: Date;
  filledAt: Date;
}

/**
 * Single-instrument backtest. `h4Candles`/`h1Candles` must be the FULL
 * available history (chronological) — the function itself performs the
 * rolling "only data through this bar's close" slicing the no-look-ahead
 * requirement demands; a caller must never pre-trim these to "just around
 * one signal."
 */
export function runTrendBreakoutInstrumentBacktest(
  instrument: TrendBreakoutInstrumentId,
  h4Candles: CandleData[],
  h1Candles: CandleData[],
  config: TrendBreakoutBacktestConfig,
): TrendBreakoutBacktestResult {
  const trades: TrendBreakoutBacktestTrade[] = [];
  const gateRejectionCounts: GateRejectionCounts = {};
  let gapChaseRejections = 0;
  let scheduleRejections = 0;

  let openPos: OpenPos | null = null;
  let pendingSignal: { direction: TrendBreakoutDirection; signalClose: number; atr: number; signalCloseAt: Date } | null = null;

  // Pre-slice H4 candles into "as-of each H1 timestamp" cheaply: track a
  // pointer that only ever advances (both arrays are chronological).
  let h4Pointer = 0;

  for (let i = 0; i < h1Candles.length; i++) {
    const candle = h1Candles[i];

    // 1. Fill a signal queued at the previous H1 bar's close, at THIS bar's
    // open (see module comment for why this replaces the literal 60s expiry).
    if (pendingSignal && !openPos) {
      const fillPrice = candle.open; // approximation — no tick data (§13)
      const gapCheck = checkGapChaseFilter(fillPrice, pendingSignal.signalClose, pendingSignal.atr);
      if (!gapCheck.passed) {
        gapChaseRejections++;
      } else if (!isWithinEntryWindow(candle.openTime)) {
        scheduleRejections++;
      } else {
        const sltp = computeRoundedSlTp(pendingSignal.direction, fillPrice, pendingSignal.atr, config.priceIncrement);
        if (isSlTpError(sltp)) {
          gateRejectionCounts['sl_tp_rounding'] = (gateRejectionCounts['sl_tp_rounding'] ?? 0) + 1;
        } else {
          openPos = {
            direction: pendingSignal.direction,
            entryPrice: fillPrice,
            stopLoss: sltp.stopLoss,
            takeProfit: sltp.takeProfit,
            atr: pendingSignal.atr,
            signalCloseAt: pendingSignal.signalCloseAt,
            filledAt: candle.openTime,
          };
        }
      }
      pendingSignal = null;
    }

    // 2. Resolve an open position with side-aware bid/ask pricing (candles
    // are the bid series; a BUY exits by selling at bid — its own raw
    // series; a SELL exits by buying at ask — bid + spread, same
    // documented assumption the legacy engine uses).
    if (openPos) {
      const isBuy = openPos.direction === 'BUY';
      const high = isBuy ? candle.high : candle.high + config.spreadPrice;
      const low = isBuy ? candle.low : candle.low + config.spreadPrice;
      const hitStop = isBuy ? low <= openPos.stopLoss : high >= openPos.stopLoss;
      const hitTarget = isBuy ? high >= openPos.takeProfit : low <= openPos.takeProfit;
      if (hitStop || hitTarget) {
        // Both in the same bar: stop-loss-first, same conservative convention as the legacy engine.
        const exitPrice = hitStop ? openPos.stopLoss : openPos.takeProfit;
        const pnlPrice = isBuy ? exitPrice - openPos.entryPrice : openPos.entryPrice - exitPrice;
        trades.push({
          instrument,
          direction: openPos.direction,
          signalCloseAt: openPos.signalCloseAt,
          filledAt: openPos.filledAt,
          entryPrice: openPos.entryPrice,
          stopLoss: openPos.stopLoss,
          takeProfit: openPos.takeProfit,
          atr: openPos.atr,
          closedAt: candle.openTime,
          outcome: hitStop ? 'LOSS' : 'WIN',
          pnlPrice,
          pnlMoney: pnlPrice * config.volumeLots * config.contractSize,
        });
        openPos = null;
      }
    }

    // Advance the H4 pointer to the latest H4 candle whose close time <= this H1 candle's close time (§5 — "never use a still-forming H4 candle").
    const h1CloseTime = h1CandleCloseTimeBound(candle);
    while (h4Pointer + 1 < h4Candles.length && h4CandleCloseTimeBound(h4Candles[h4Pointer + 1]) <= h1CloseTime) {
      h4Pointer++;
    }
    if (h4CandleCloseTimeBound(h4Candles[h4Pointer]) > h1CloseTime) {
      continue; // no H4 candle has even closed yet as of this H1 bar
    }

    // 3. Evaluate a NEW signal using data through THIS H1 bar's close.
    if (!openPos && !pendingSignal) {
      const h4Slice = h4Candles.slice(0, h4Pointer + 1);
      const h1Slice = h1Candles.slice(0, i + 1);
      const result = evaluateTrendBreakoutSignal({ h4Candles: h4Slice, h1Candles: h1Slice });
      for (const gate of result.gateResults) {
        if (!gate.passed) gateRejectionCounts[gate.gate] = (gateRejectionCounts[gate.gate] ?? 0) + 1;
      }
      if (result.direction && result.h1 && result.atr !== null) {
        pendingSignal = { direction: result.direction, signalClose: result.h1.signalClose, atr: result.atr, signalCloseAt: result.h1.signalCloseAt };
      }
    }
  }

  if (openPos) {
    trades.push({
      instrument,
      direction: openPos.direction,
      signalCloseAt: openPos.signalCloseAt,
      filledAt: openPos.filledAt,
      entryPrice: openPos.entryPrice,
      stopLoss: openPos.stopLoss,
      takeProfit: openPos.takeProfit,
      atr: openPos.atr,
      closedAt: null,
      outcome: 'OPEN_AT_END',
      pnlPrice: 0,
      pnlMoney: 0,
    });
  }

  return summarizeTrendBreakout(trades, gateRejectionCounts, gapChaseRejections, scheduleRejections);
}

/** H4 candles in this database are OHLC bars with a known fixed duration (4h) — "closing time" = openTime + 4h. Kept as its own tiny function so the +4h assumption is written down in exactly one place. */
function h4CandleCloseTimeBound(candle: CandleData): number {
  return candle.openTime.getTime() + 4 * 3600_000;
}

/** H1's own close-time bound (+1h) — a DELIBERATELY separate function from `h4CandleCloseTimeBound` even though both are one-liners, so a future edit to either bar duration can never accidentally apply the wrong one to the other timeframe's candles (exactly the bug this comment exists to prevent a regression of). */
function h1CandleCloseTimeBound(candle: CandleData): number {
  return candle.openTime.getTime() + 3600_000;
}

function summarizeTrendBreakout(
  trades: TrendBreakoutBacktestTrade[],
  gateRejectionCounts: GateRejectionCounts,
  gapChaseRejections: number,
  scheduleRejections: number,
): TrendBreakoutBacktestResult {
  const closed = trades.filter((t) => t.outcome !== 'OPEN_AT_END');
  const wins = closed.filter((t) => t.outcome === 'WIN');
  const losses = closed.filter((t) => t.outcome === 'LOSS');

  const grossProfit = wins.reduce((sum, t) => sum + t.pnlMoney, 0);
  const grossLoss = losses.reduce((sum, t) => sum + t.pnlMoney, 0);

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const t of closed) {
    equity += t.pnlMoney;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  const holdingHours = closed.filter((t) => t.closedAt).map((t) => (t.closedAt!.getTime() - t.filledAt.getTime()) / 3_600_000);

  return {
    trades,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    openAtEnd: trades.length - closed.length,
    winRate: closed.length > 0 ? wins.length / closed.length : null,
    profitFactorMoney: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : grossProfit > 0 ? Infinity : null,
    totalPnlMoney: grossProfit + grossLoss,
    maxDrawdownMoney: maxDrawdown,
    avgHoldingHours: holdingHours.length > 0 ? holdingHours.reduce((a, b) => a + b, 0) / holdingHours.length : null,
    gateRejectionCounts,
    gapChaseRejections,
    scheduleRejections,
  };
}

// ============================================================================
// Combined (multi-instrument, shared account) backtest — §13: "Backtest
// EURUSD and gold separately, then together in chronological order with a
// shared account... Enforce one position per symbol and the account-wide
// risk gates in the combined simulation."
//
// Built and unit-tested (with synthetic multi-instrument data) as part of
// this task, but NOT run against real gold history in the delivered
// report — this database has zero historical XAUUSD candles (verified
// directly; see the delivery report), so there is no real data to run it
// against yet. Kept here, fully functional, for the day gold history exists.
//
// Simplification, disclosed rather than silent: daily-loss/drawdown gating
// in this combined engine is evaluated against REALIZED equity only
// (starting equity + closed-trade P&L up to that point) — it does not
// mark open positions to market bar-by-bar. A fully intrabar-accurate
// unrealized-equity model across two concurrently-open, independently-timed
// instruments is substantially more complex than this feature's current
// value justifies while one of its two instruments has no data to validate
// it against at all; realized-equity gating is the same simplification
// already implicit in the legacy engine's own point-based summarize().
// ============================================================================

export interface CombinedInstrumentInput {
  instrument: TrendBreakoutInstrumentId;
  h4Candles: CandleData[];
  h1Candles: CandleData[];
  config: TrendBreakoutBacktestConfig;
}

export interface CombinedBacktestResult {
  perInstrument: Record<string, TrendBreakoutBacktestResult>;
  combinedTrades: TrendBreakoutBacktestTrade[];
  combinedTotalPnlMoney: number;
  combinedMaxDrawdownMoney: number;
  combinedRiskRejections: number;
  dailyLossRejections: number;
  drawdownRejections: number;
  finalEquity: number;
}

interface CombinedEvent {
  instrument: TrendBreakoutInstrumentId;
  time: number;
  h1Index: number;
}

export function runCombinedTrendBreakoutBacktest(inputs: CombinedInstrumentInput[], startingEquity: number, riskPolicy: RiskPolicyConfig): CombinedBacktestResult {
  // Merge every instrument's H1 timeline into one chronological event
  // stream — each event is "instrument X's H1 candle at index i has just
  // closed," processed in true time order across instruments.
  const events: CombinedEvent[] = [];
  for (const input of inputs) {
    for (let i = 0; i < input.h1Candles.length; i++) {
      events.push({ instrument: input.instrument, time: input.h1Candles[i].openTime.getTime(), h1Index: i });
    }
  }
  events.sort((a, b) => a.time - b.time);

  const byInstrument = new Map(inputs.map((i) => [i.instrument, i]));
  const h4Pointers = new Map<TrendBreakoutInstrumentId, number>(inputs.map((i) => [i.instrument, 0]));
  const openPositions = new Map<TrendBreakoutInstrumentId, OpenPos & { estimatedRisk: number }>();
  const pendingSignals = new Map<TrendBreakoutInstrumentId, { direction: TrendBreakoutDirection; signalClose: number; atr: number; signalCloseAt: Date }>();

  const perInstrumentTrades = new Map<TrendBreakoutInstrumentId, TrendBreakoutBacktestTrade[]>(inputs.map((i) => [i.instrument, []]));
  const combinedTrades: TrendBreakoutBacktestTrade[] = [];

  let realizedEquity = startingEquity;
  let cashFlowAdjustedHigh = startingEquity;
  let dailyBaseline = startingEquity;
  let dailyDateKey: string | null = null;
  let dailyTriggered = false;
  let drawdownTriggered = false;
  let combinedRiskRejections = 0;
  let dailyLossRejections = 0;
  let drawdownRejections = 0;

  for (const event of events) {
    const input = byInstrument.get(event.instrument)!;
    const candle = input.h1Candles[event.h1Index];

    // Roll the Beirut daily baseline forward on a calendar-day change —
    // backtest has no deposits/withdrawals, so dailyNetCashFlow is always 0 here.
    const beirutDate = getBeirutCalendarDate(candle.openTime);
    if (dailyDateKey !== beirutDate) {
      dailyDateKey = beirutDate;
      dailyBaseline = realizedEquity;
      dailyTriggered = false;
    }

    // 1. Fill any pending signal for THIS instrument.
    const pending = pendingSignals.get(event.instrument);
    if (pending && !openPositions.has(event.instrument)) {
      const fillPrice = candle.open;
      const gapCheck = checkGapChaseFilter(fillPrice, pending.signalClose, pending.atr);
      const withinWindow = isWithinEntryWindow(candle.openTime);
      if (gapCheck.passed && withinWindow) {
        const sltp = computeRoundedSlTp(pending.direction, fillPrice, pending.atr, input.config.priceIncrement);
        if (!isSlTpError(sltp)) {
          const stopRisk = sltp.roundedStopDistance * input.config.volumeLots * input.config.contractSize;
          const tradeGate = evaluateTradeRiskGate({ estimatedRiskAmount: stopRisk, accountEquity: realizedEquity, maxTradeRiskPct: riskPolicy.maxTradeRiskPct });
          const reservedElsewhere = [...openPositions.values()].map((p) => p.estimatedRisk);
          const combinedGate = evaluateCombinedRiskGate({ reservedRiskAmounts: reservedElsewhere, newRiskAmount: stopRisk, accountEquity: realizedEquity, maxCombinedRiskPct: riskPolicy.maxCombinedRiskPct });
          const dailyGate = evaluateDailyLossGate({ currentEquity: realizedEquity, dailyBaselineEquity: dailyBaseline, dailyNetCashFlow: 0, dailyLossPct: riskPolicy.dailyLossPct, alreadyTriggered: dailyTriggered });
          const drawdownGate = evaluateDrawdownGate({ currentEquity: realizedEquity, cashFlowAdjustedHigh, drawdownPct: riskPolicy.drawdownPct, alreadyTriggered: drawdownTriggered });
          if (!dailyGate.passed) dailyTriggered = true;
          if (!drawdownGate.passed) drawdownTriggered = true;

          if (!tradeGate.passed || !combinedGate.passed) {
            combinedRiskRejections++;
          } else if (!dailyGate.passed) {
            dailyLossRejections++;
          } else if (!drawdownGate.passed) {
            drawdownRejections++;
          } else {
            openPositions.set(event.instrument, {
              direction: pending.direction,
              entryPrice: fillPrice,
              stopLoss: sltp.stopLoss,
              takeProfit: sltp.takeProfit,
              atr: pending.atr,
              signalCloseAt: pending.signalCloseAt,
              filledAt: candle.openTime,
              estimatedRisk: stopRisk,
            });
          }
        }
      }
      pendingSignals.delete(event.instrument);
    }

    // 2. Resolve an open position for THIS instrument.
    const open = openPositions.get(event.instrument);
    if (open) {
      const isBuy = open.direction === 'BUY';
      const high = isBuy ? candle.high : candle.high + input.config.spreadPrice;
      const low = isBuy ? candle.low : candle.low + input.config.spreadPrice;
      const hitStop = isBuy ? low <= open.stopLoss : high >= open.stopLoss;
      const hitTarget = isBuy ? high >= open.takeProfit : low <= open.takeProfit;
      if (hitStop || hitTarget) {
        const exitPrice = hitStop ? open.stopLoss : open.takeProfit;
        const pnlPrice = isBuy ? exitPrice - open.entryPrice : open.entryPrice - exitPrice;
        const pnlMoney = pnlPrice * input.config.volumeLots * input.config.contractSize;
        const trade: TrendBreakoutBacktestTrade = {
          instrument: event.instrument,
          direction: open.direction,
          signalCloseAt: open.signalCloseAt,
          filledAt: open.filledAt,
          entryPrice: open.entryPrice,
          stopLoss: open.stopLoss,
          takeProfit: open.takeProfit,
          atr: open.atr,
          closedAt: candle.openTime,
          outcome: hitStop ? 'LOSS' : 'WIN',
          pnlPrice,
          pnlMoney,
        };
        perInstrumentTrades.get(event.instrument)!.push(trade);
        combinedTrades.push(trade);
        realizedEquity += pnlMoney;
        const cashFlowAdjustedEquity = realizedEquity; // no deposits/withdrawals in a backtest
        cashFlowAdjustedHigh = updateCashFlowAdjustedHigh(cashFlowAdjustedHigh, cashFlowAdjustedEquity);
        openPositions.delete(event.instrument);
      }
    }

    // 3. Advance this instrument's H4 pointer and evaluate a new signal.
    const h1CloseTime = h1CandleCloseTimeBound(candle);
    let h4Pointer = h4Pointers.get(event.instrument)!;
    while (h4Pointer + 1 < input.h4Candles.length && h4CandleCloseTimeBound(input.h4Candles[h4Pointer + 1]) <= h1CloseTime) {
      h4Pointer++;
    }
    h4Pointers.set(event.instrument, h4Pointer);
    if (h4CandleCloseTimeBound(input.h4Candles[h4Pointer]) > h1CloseTime) continue;

    if (!openPositions.has(event.instrument) && !pendingSignals.has(event.instrument)) {
      const h4Slice = input.h4Candles.slice(0, h4Pointer + 1);
      const h1Slice = input.h1Candles.slice(0, event.h1Index + 1);
      const result = evaluateTrendBreakoutSignal({ h4Candles: h4Slice, h1Candles: h1Slice });
      if (result.direction && result.h1 && result.atr !== null) {
        pendingSignals.set(event.instrument, { direction: result.direction, signalClose: result.h1.signalClose, atr: result.atr, signalCloseAt: result.h1.signalCloseAt });
      }
    }
  }

  const perInstrument: Record<string, TrendBreakoutBacktestResult> = {};
  for (const [instrument, trades] of perInstrumentTrades) {
    perInstrument[instrument] = summarizeTrendBreakout(trades, {}, 0, 0);
  }

  let peak = 0;
  let equity = 0;
  let maxDrawdown = 0;
  for (const t of combinedTrades.sort((a, b) => (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0))) {
    equity += t.pnlMoney;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  return {
    perInstrument,
    combinedTrades,
    combinedTotalPnlMoney: realizedEquity - startingEquity,
    combinedMaxDrawdownMoney: maxDrawdown,
    combinedRiskRejections,
    dailyLossRejections,
    drawdownRejections,
    finalEquity: realizedEquity,
  };
}
