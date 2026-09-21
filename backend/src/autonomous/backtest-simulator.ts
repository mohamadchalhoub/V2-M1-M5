import { pointsToPrice, priceDistanceInPoints } from '../technical-analysis/point-value';
import { CandleData } from '../market-data/historical-candle.service';
import { AutonomousRulesConfig } from './autonomous-rules.config';
import { evaluateAutonomousRule } from './autonomous-rule-engine.service';
import { evaluateLevelState, LevelState } from './level-confirmation';
import { RuleLevelType } from './types';
import { calculateWeeklyRangeLevels, getPreviousCompletedWeekBounds, WeeklyRangeLevels } from './weekly-range-levels.service';

export interface BacktestTrade {
  action: 'OPEN_BUY' | 'OPEN_SELL';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  levelUsed: RuleLevelType;
  referenceWeekStart: Date;
  openedAt: Date;
  closedAt: Date | null;
  outcome: 'WIN' | 'LOSS' | 'OPEN_AT_END';
  pnlPoints: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  totalTrades: number;
  wins: number;
  losses: number;
  openAtEnd: number;
  winRate: number | null;
  avgWinPoints: number | null;
  avgLossPoints: number | null;
  profitFactor: number | null;
  totalPnlPoints: number;
  maxDrawdownPoints: number;
  /** Per-trade (not annualized) — mean/stddev of each closed trade's points P&L. Meaningless with this few trades; reported anyway per the plan's "report honestly" instruction, alongside the sample-size caveat. */
  sharpeRatioPerTrade: number | null;
}

/** Exported for reuse by `scripts/backtest-autonomous-rule.ts`'s AI-assisted backtest — same shape, resolved the same way, whichever layer decided to open it. */
export interface OpenPosition {
  action: 'OPEN_BUY' | 'OPEN_SELL';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  levelUsed: RuleLevelType;
  referenceWeekStart: Date;
  openedAt: Date;
}

/**
 * ⚠ LEGACY — kept unchanged as a labeled prior result, per this project's
 * reconciliation audit (2nd pass). Two confirmed simulation defects live
 * here, both fixed in `runBacktestNoLookahead` below, which is now the
 * engine to trust:
 *
 * 1. **Look-ahead**: this function timestamps a decision at `candle.openTime`
 *    but fills it using that SAME candle's `close` — i.e., it uses
 *    information (the bar's own close, ~15 minutes in the "future" relative
 *    to the bar's open) that was not actually available at the nominal
 *    decision instant. Every entry price, and the touch/retrace state that
 *    gated it, was computed this way.
 * 2. **Short-side pricing**: `resolveOutcome` below checks SL/TP against ONE
 *    OHLC series for both directions. This database's candles are MT5's own
 *    bid-convention bars — correct for a BUY's exit (closing a buy = selling
 *    at bid) but wrong for a SELL's exit (closing a sell = buying at ask,
 *    never modeled here).
 *
 * Retained ONLY so the originally-reported numbers remain reproducible and
 * inspectable against the corrected engine's — do not use this function for
 * any new work.
 *
 * Event-driven replay of `evaluateAutonomousRule` over historical data —
 * the same pure decision function a live dry-run loop calls, so the
 * backtest can never silently diverge from what the live system would
 * actually do (AUTONOMOUS_RULE_ENGINE_SPEC.md §1). `h4Candles`/`d1Candles`
 * compute the friend's Rule 4 weekly levels (H4) and the confluence check
 * (D1); `m15Candles` (the finest timeframe with full multi-year coverage in
 * this database) drive the entry scan, the touch/retrace/break state
 * machine, the volatility filter, AND the SL/TP resolution — H4 alone is
 * both too coarse to know which of SL/TP hit first and too coarse for the
 * friend's 50-point retrace pattern.
 *
 * PLACEHOLDER assumption (unchanged from before): when a single M15
 * candle's range touches BOTH stop-loss and take-profit, this resolves as
 * the STOP LOSS having hit first — the standard conservative convention
 * for OHLC-bar backtesting. (Quantified separately: only 1 of 61 trades in
 * the original reported run ever hit this case — see the audit report.)
 *
 * PLACEHOLDER assumption: no spread is applied to level-touch/SL/TP
 * checks themselves (a candle's own high/low, not a bid/ask-adjusted
 * version) — only the ENTRY price has the configured spread applied.
 */
export function runBacktest(
  h4Candles: CandleData[],
  d1Candles: CandleData[],
  m15Candles: CandleData[],
  config: AutonomousRulesConfig,
  spreadPoints: number,
): BacktestResult {
  const trades: BacktestTrade[] = [];
  let openPosition: OpenPosition | null = null;
  let lastOrderDateKey: string | null = null;

  let weekCacheKey: string | null = null;
  let h4LevelsCache: WeeklyRangeLevels | null = null;
  let d1LevelsCache: WeeklyRangeLevels | null = null;
  let activeWeekStartIndex = 0; // index into m15Candles where the CURRENT reference week's active period (referenceWeekEnd onward) begins

  for (let i = 0; i < m15Candles.length; i++) {
    const candle = m15Candles[i];

    if (openPosition) {
      const resolution = resolveOutcome(openPosition, candle);
      if (resolution) {
        trades.push({ ...openPosition, closedAt: candle.openTime, ...resolution });
        openPosition = null;
      }
    }

    const { start, end } = getPreviousCompletedWeekBounds(candle.openTime);
    const weekKey = start.toISOString();
    if (weekKey !== weekCacheKey) {
      h4LevelsCache = calculateWeeklyRangeLevels(h4Candles, candle.openTime);
      d1LevelsCache = calculateWeeklyRangeLevels(d1Candles, candle.openTime);
      weekCacheKey = weekKey;
      activeWeekStartIndex = m15Candles.findIndex((c) => c.openTime >= end);
      if (activeWeekStartIndex === -1) activeWeekStartIndex = i;
    }

    const dateKey = candle.openTime.toISOString().slice(0, 10);
    if (!openPosition && dateKey !== lastOrderDateKey) {
      const activeCandles = m15Candles.slice(activeWeekStartIndex, i + 1);
      const halfSpread = pointsToPrice(spreadPoints) / 2;
      const currentPrice = { bid: candle.close - halfSpread, ask: candle.close + halfSpread };
      const decision = evaluateAutonomousRule({
        h4Levels: h4LevelsCache,
        d1Levels: d1LevelsCache,
        activeCandles,
        recentIntradayCandles: activeCandles,
        now: candle.openTime,
        currentPrice,
        ordersPlacedToday: 0,
        config,
      });

      if (decision.action !== 'HOLD' && decision.entryPrice !== null && decision.stopLoss !== null && decision.takeProfit !== null) {
        openPosition = {
          action: decision.action,
          entryPrice: decision.entryPrice,
          stopLoss: decision.stopLoss,
          takeProfit: decision.takeProfit,
          levelUsed: decision.levelUsed!,
          referenceWeekStart: decision.referenceWeekStart!,
          openedAt: candle.openTime,
        };
        lastOrderDateKey = dateKey;
      }
    }
  }

  if (openPosition) {
    trades.push({ ...openPosition, closedAt: null, outcome: 'OPEN_AT_END', pnlPoints: 0 });
  }

  return summarize(trades);
}

/** Exported for reuse — see `OpenPosition`'s own comment. */
export function resolveOutcome(position: OpenPosition, candle: CandleData): { outcome: 'WIN' | 'LOSS'; pnlPoints: number } | null {
  const hitStopLoss = position.action === 'OPEN_BUY' ? candle.low <= position.stopLoss : candle.high >= position.stopLoss;
  const hitTakeProfit = position.action === 'OPEN_BUY' ? candle.high >= position.takeProfit : candle.low <= position.takeProfit;

  if (!hitStopLoss && !hitTakeProfit) return null;
  // Both in the same bar: stop-loss-first convention (see module comment).
  if (hitStopLoss) {
    return { outcome: 'LOSS', pnlPoints: -priceDistanceInPoints(position.entryPrice, position.stopLoss) };
  }
  return { outcome: 'WIN', pnlPoints: priceDistanceInPoints(position.entryPrice, position.takeProfit) };
}

/**
 * CORRECTED engine — reconciliation audit, 2nd pass. Fixes both defects
 * documented on `runBacktest` above:
 *
 * 1. **No look-ahead**: a signal is evaluated using data through a bar's
 *    CLOSE (that bar is now fully known) but is only QUEUED, not filled.
 *    It fills at the very NEXT bar's OPEN — the earliest price actually
 *    available after the signal bar completes. The signal bar's own
 *    high/low are never applied to the position it queues; only the fill
 *    bar onward can resolve it. The "one order per day" gate is keyed off
 *    the FILL day, not the signal day (they can differ across midnight).
 * 2. **Side-correct pricing**: candles are treated as the bid series they
 *    actually are. A BUY fills at a synthetic ASK (`bid + spread`) and its
 *    exit is checked against the raw (bid) series — closing a buy is a
 *    sell. A SELL fills at BID directly and its exit is checked against a
 *    synthetic ASK series — closing a sell is a buy. Each round trip pays
 *    exactly one spread-width, charged on whichever leg (entry for a long,
 *    exit for a short) actually crosses the spread — never both, never
 *    neither. No historical bid/ask tick archive exists in this database;
 *    `bid + spreadPoints` is a labeled ASSUMPTION (a constant offset under
 *    the same fixed-spread scenario already used elsewhere in this
 *    project), not an observed historical ask price.
 */
/** Everything a confirmation hook (a real AI call, a stub, or nothing at all) needs to decide whether a mechanically-valid candidate should actually be taken. Deliberately the same fields `AutonomousAiContext` needs, minus historical-pattern/news/events — those are external I/O the pure simulator has no business owning; a caller that wants a real AI decision merges them in around this. */
export interface BacktestCandidate {
  action: 'OPEN_BUY' | 'OPEN_SELL';
  levelUsed: RuleLevelType;
  referenceWeekStart: Date;
  h4Levels: WeeklyRangeLevels;
  d1Levels: WeeklyRangeLevels | null;
  supportState: LevelState;
  resistanceState: LevelState;
  currentPrice: { bid: number; ask: number };
  now: Date;
}

/** Return `true` to take the candidate, `false` to veto it (HOLD instead) — same confirm-or-veto contract the AI decision layer has everywhere else in this project; a hook can never originate a candidate, only approve or reject one `evaluateAutonomousRule` already found. */
export type BacktestConfirmationHook = (candidate: BacktestCandidate) => Promise<boolean>;

const APPROVE_ALL: BacktestConfirmationHook = async () => true;

/**
 * CORRECTED engine — reconciliation audit, 2nd pass. Fixes both defects
 * documented on `runBacktest` above (look-ahead, short-side pricing — see
 * that function's own comment for the detail) AND is the SINGLE simulation
 * loop for both the mechanical-only and AI-assisted backtests: reconciling
 * them was previously done by maintaining two independently-written scans
 * of the same data (`runBacktest` here, a hand-rolled loop in
 * `backtest-autonomous-rule.ts`) and shrugging at a small, unexplained
 * difference in candidate count between them. That's no longer true — an
 * AI-assisted run and a mechanical-only run now differ ONLY in what
 * `confirm` is (a real AI call vs. the `APPROVE_ALL` default below), never
 * in how candidates are found, timed, priced, or resolved. Calling this
 * with an always-true stub MUST produce byte-identical results to
 * `runBacktestNoLookahead` on the same inputs — that parity is itself a
 * regression test (`backtest-simulator.spec.ts`), not just an assertion.
 *
 * `lastCandidateDateKey` is tracked SEPARATELY from `lastOrderDateKey`
 * (which only advances on an actual FILL): a mechanical candidate that
 * exists but is VETOED still consumes today's one-look budget, exactly
 * like the friend's Rule 3 already treats a HOLD — this is the fix for the
 * real bug found live in an earlier session (a persistent unconfirmed
 * candidate re-asking a real AI provider on every subsequent M15 candle,
 * turning ~60 intended calls into ~1,900 real ones). Both keys are updated
 * at the moment they become true, never retroactively.
 */
export async function runBacktestWithConfirmation(
  h4Candles: CandleData[],
  d1Candles: CandleData[],
  m15Candles: CandleData[],
  config: AutonomousRulesConfig,
  spreadPoints: number,
  confirm: BacktestConfirmationHook = APPROVE_ALL,
): Promise<BacktestResult> {
  const trades: BacktestTrade[] = [];
  let openPosition: OpenPosition | null = null;
  let lastOrderDateKey: string | null = null;
  let lastCandidateDateKey: string | null = null;
  let pendingSignal: { action: 'OPEN_BUY' | 'OPEN_SELL'; levelUsed: RuleLevelType; referenceWeekStart: Date } | null = null;

  let weekCacheKey: string | null = null;
  let h4LevelsCache: WeeklyRangeLevels | null = null;
  let d1LevelsCache: WeeklyRangeLevels | null = null;
  let activeWeekStartIndex = 0;

  const spreadPrice = pointsToPrice(spreadPoints);

  for (let i = 0; i < m15Candles.length; i++) {
    const candle = m15Candles[i];

    // 1. Fill a signal queued at the PREVIOUS bar's close, at THIS bar's
    // open. Everything from this bar's open onward is fair game to resolve
    // the position — nothing from before it (the signal bar's own range)
    // is ever used here.
    if (pendingSignal && !openPosition) {
      const isBuy = pendingSignal.action === 'OPEN_BUY';
      const entry = isBuy ? candle.open + spreadPrice : candle.open;
      openPosition = {
        action: pendingSignal.action,
        entryPrice: entry,
        stopLoss: isBuy ? entry - pointsToPrice(config.stopLossPoints) : entry + pointsToPrice(config.stopLossPoints),
        takeProfit: isBuy ? entry + pointsToPrice(config.takeProfitPoints) : entry - pointsToPrice(config.takeProfitPoints),
        levelUsed: pendingSignal.levelUsed,
        referenceWeekStart: pendingSignal.referenceWeekStart,
        openedAt: candle.openTime,
      };
      lastOrderDateKey = candle.openTime.toISOString().slice(0, 10); // the FILL day, not the signal day
      pendingSignal = null;
    }

    // 2. Resolve an already-open position with side-correct pricing.
    if (openPosition) {
      const resolution = resolveOutcomeSideAware(openPosition, candle, spreadPrice);
      if (resolution) {
        trades.push({ ...openPosition, closedAt: candle.openTime, ...resolution });
        openPosition = null;
      }
    }

    // 3. Level/week cache — already non-look-ahead by construction (always
    // strictly the previous completed calendar week); unchanged from the
    // legacy engine.
    const { start, end } = getPreviousCompletedWeekBounds(candle.openTime);
    const weekKey = start.toISOString();
    if (weekKey !== weekCacheKey) {
      h4LevelsCache = calculateWeeklyRangeLevels(h4Candles, candle.openTime);
      d1LevelsCache = calculateWeeklyRangeLevels(d1Candles, candle.openTime);
      weekCacheKey = weekKey;
      activeWeekStartIndex = m15Candles.findIndex((c) => c.openTime >= end);
      if (activeWeekStartIndex === -1) activeWeekStartIndex = i;
    }

    // 4. Evaluate a NEW signal using data through THIS bar's close (now
    // fully known). If the mechanical engine finds one, ask `confirm` — a
    // veto (or no confirmation at all) still consumes today's one-look
    // budget via `lastCandidateDateKey`, exactly like a HOLD would.
    const dateKey = candle.openTime.toISOString().slice(0, 10);
    if (!openPosition && !pendingSignal && dateKey !== lastOrderDateKey && dateKey !== lastCandidateDateKey) {
      const activeCandles = m15Candles.slice(activeWeekStartIndex, i + 1);
      const halfSpread = spreadPrice / 2;
      const currentPrice = { bid: candle.close - halfSpread, ask: candle.close + halfSpread };
      const decision = evaluateAutonomousRule({
        h4Levels: h4LevelsCache,
        d1Levels: d1LevelsCache,
        activeCandles,
        recentIntradayCandles: activeCandles,
        now: candle.openTime,
        currentPrice,
        ordersPlacedToday: 0,
        config,
      });

      if (decision.action !== 'HOLD' && decision.levelUsed && decision.referenceWeekStart && h4LevelsCache) {
        lastCandidateDateKey = dateKey; // set BEFORE awaiting confirm, regardless of its answer
        const mid = (currentPrice.bid + currentPrice.ask) / 2;
        const candidate: BacktestCandidate = {
          action: decision.action,
          levelUsed: decision.levelUsed,
          referenceWeekStart: decision.referenceWeekStart,
          h4Levels: h4LevelsCache,
          d1Levels: d1LevelsCache,
          supportState: evaluateLevelState(h4LevelsCache.support, 'SUPPORT', activeCandles, mid, config.entryRetracePoints, config.levelBreakOvershootPoints),
          resistanceState: evaluateLevelState(h4LevelsCache.resistance, 'RESISTANCE', activeCandles, mid, config.entryRetracePoints, config.levelBreakOvershootPoints),
          currentPrice,
          now: candle.openTime,
        };
        const confirmed = await confirm(candidate);
        if (confirmed) {
          pendingSignal = { action: decision.action, levelUsed: decision.levelUsed, referenceWeekStart: decision.referenceWeekStart };
        }
      }
    }
  }

  if (openPosition) {
    trades.push({ ...openPosition, closedAt: null, outcome: 'OPEN_AT_END', pnlPoints: 0 });
  }
  // A signal still queued at the very end of history never received a fill
  // price — correctly dropped, not recorded as a trade (it never executed).

  return summarize(trades);
}

/** Mechanical-only convenience wrapper — `runBacktestWithConfirmation` with every candidate auto-approved. Kept as its own name because "the mechanical baseline" is a meaningful, frequently-reproduced thing on its own; it is NOT a second implementation — parity between this and an approve-all confirmation hook is enforced by a regression test, not by trust. */
export function runBacktestNoLookahead(
  h4Candles: CandleData[],
  d1Candles: CandleData[],
  m15Candles: CandleData[],
  config: AutonomousRulesConfig,
  spreadPoints: number,
): Promise<BacktestResult> {
  return runBacktestWithConfirmation(h4Candles, d1Candles, m15Candles, config, spreadPoints, APPROVE_ALL);
}

/** Exported for reuse — see `OpenPosition`'s own comment. Side-aware version of `resolveOutcome` — see `runBacktestNoLookahead`'s own doc comment for why BUY and SELL need different series. */
export function resolveOutcomeSideAware(position: OpenPosition, candle: CandleData, spreadPrice: number): { outcome: 'WIN' | 'LOSS'; pnlPoints: number } | null {
  const isBuy = position.action === 'OPEN_BUY';
  // Closing a BUY sells at bid (the raw series). Closing a SELL buys at
  // ask — approximated as bid + spreadPrice, a labeled assumption (see the
  // module comment), not an observed historical ask.
  const high = isBuy ? candle.high : candle.high + spreadPrice;
  const low = isBuy ? candle.low : candle.low + spreadPrice;

  const hitStopLoss = isBuy ? low <= position.stopLoss : high >= position.stopLoss;
  const hitTakeProfit = isBuy ? high >= position.takeProfit : low <= position.takeProfit;

  if (!hitStopLoss && !hitTakeProfit) return null;
  // Both in the same bar: stop-loss-first convention, same as the legacy
  // engine (see its own module comment) — unresolved intrabar ordering is
  // disclosed, not silently invented, in both engines alike.
  if (hitStopLoss) {
    return { outcome: 'LOSS', pnlPoints: -priceDistanceInPoints(position.entryPrice, position.stopLoss) };
  }
  return { outcome: 'WIN', pnlPoints: priceDistanceInPoints(position.entryPrice, position.takeProfit) };
}

/** Exported for reuse — see `OpenPosition`'s own comment. */
export function summarize(trades: BacktestTrade[]): BacktestResult {
  const closed = trades.filter((t) => t.outcome !== 'OPEN_AT_END');
  const wins = closed.filter((t) => t.outcome === 'WIN');
  const losses = closed.filter((t) => t.outcome === 'LOSS');
  const openAtEnd = trades.length - closed.length;

  const grossProfit = wins.reduce((sum, t) => sum + t.pnlPoints, 0);
  const grossLoss = losses.reduce((sum, t) => sum + t.pnlPoints, 0); // negative

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const t of closed) {
    equity += t.pnlPoints;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  const pnlSeries = closed.map((t) => t.pnlPoints);
  const mean = pnlSeries.length > 0 ? pnlSeries.reduce((a, b) => a + b, 0) / pnlSeries.length : null;
  const stddev =
    mean !== null && pnlSeries.length > 1
      ? Math.sqrt(pnlSeries.reduce((sum, p) => sum + (p - mean) ** 2, 0) / (pnlSeries.length - 1))
      : null;

  return {
    trades,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    openAtEnd,
    winRate: closed.length > 0 ? wins.length / closed.length : null,
    avgWinPoints: wins.length > 0 ? grossProfit / wins.length : null,
    avgLossPoints: losses.length > 0 ? grossLoss / losses.length : null,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : grossProfit > 0 ? Infinity : null,
    totalPnlPoints: grossProfit + grossLoss,
    maxDrawdownPoints: maxDrawdown,
    sharpeRatioPerTrade: stddev !== null && stddev > 0 ? (mean as number) / stddev : null,
  };
}
