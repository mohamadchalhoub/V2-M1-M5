import { Inject, Injectable } from '@nestjs/common';
import { pointsToPrice } from '../technical-analysis/point-value';
import { CandleData, HistoricalCandleService } from '../market-data/historical-candle.service';
import { AUTONOMOUS_RULES_CONFIG, AutonomousRulesConfig } from './autonomous-rules.config';
import { evaluateLevelState, hasConfluence, isVolatilitySpike, LevelState } from './level-confirmation';
import { RuleLevelType } from './types';
import { calculateWeeklyRangeLevels, getPreviousCompletedWeekBounds, WeeklyRangeLevels } from './weekly-range-levels.service';

export const SYMBOL = 'EURUSD';

export type AutonomousRuleAction = 'OPEN_BUY' | 'OPEN_SELL' | 'HOLD';
export type { RuleLevelType };

export interface AutonomousRuleDecision {
  action: AutonomousRuleAction;
  symbol: typeof SYMBOL;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  levelUsed: RuleLevelType | null;
  referenceWeekStart: Date | null;
  reasoning: string;
}

export interface CurrentPrice {
  bid: number;
  ask: number;
}

export interface AutonomousRuleInput {
  h4Levels: WeeklyRangeLevels | null;
  d1Levels: WeeklyRangeLevels | null;
  /** Every candle (H4-native, i.e. the same timeframe the levels themselves are watched on) from the H4 reference week's END up to "now" — drives touch/retrace/break detection. Chronological order. */
  activeCandles: CandleData[];
  /** Fine-grained (M15 or finer) candles covering at least the volatility filter's window, up to "now" — kept separate from `activeCandles` because the volatility check needs finer resolution than H4 to be meaningful over a 1-2 hour window. */
  recentIntradayCandles: CandleData[];
  now: Date;
  currentPrice: CurrentPrice | null;
  /** How many orders this system has already placed today — the friend's Rule 3 gate. Always 0 until an execution layer exists to place any. */
  ordersPlacedToday: number;
  config: AutonomousRulesConfig;
}

/**
 * Deterministic, AI-free evaluation of the friend's rules
 * (AUTONOMOUS_DEMO_TRADING_PLAN.md §7 "rules-only baseline" / §13.1's
 * recommendation to keep entry/SL/TP math out of the AI's hands). Pure
 * function, no I/O — `AutonomousRuleEngineService` below does the candle/
 * tick fetching and calls this.
 *
 * As of the friend's direct answers (AUTONOMOUS_RULE_ENGINE_SPEC.md §2),
 * this is a touch-and-retrace confirmation model, not a simple "within X
 * points of the level" check — see `level-confirmation.ts` for the state
 * machine this delegates to.
 */
export function evaluateAutonomousRule(input: AutonomousRuleInput): AutonomousRuleDecision {
  const { h4Levels, d1Levels, activeCandles, recentIntradayCandles, now, currentPrice, ordersPlacedToday, config } = input;
  const base = {
    symbol: SYMBOL,
    entryPrice: null,
    stopLoss: null,
    takeProfit: null,
    levelUsed: null,
    referenceWeekStart: h4Levels?.referenceWeekStart ?? null,
  } as const;

  if (ordersPlacedToday >= config.maxOrdersPerDay) {
    return { ...base, action: 'HOLD', reasoning: `Friend's Rule 3 (max ${config.maxOrdersPerDay} order/day): ${ordersPlacedToday} already placed today.` };
  }

  if (!h4Levels) {
    return { ...base, action: 'HOLD', reasoning: "No H4 candles found for the previous completed week — can't compute the friend's Rule 4 support/resistance levels." };
  }

  if (!currentPrice) {
    return { ...base, action: 'HOLD', reasoning: 'No current EURUSD price available (no live tick and no recent candle close).' };
  }

  if (isVolatilitySpike(recentIntradayCandles, now, config.volatilityFilterWindowHours, config.volatilityFilterMaxPoints)) {
    return {
      ...base,
      action: 'HOLD',
      reasoning: `Friend's volatility filter: price has moved >= ${config.volatilityFilterMaxPoints}pt within the last ${config.volatilityFilterWindowHours}h — market moving too hard, skipping.`,
    };
  }

  const mid = (currentPrice.bid + currentPrice.ask) / 2;
  const weekLabel = h4Levels.referenceWeekStart.toISOString().slice(0, 10);

  const candidates: { levelType: RuleLevelType; levelPrice: number }[] = [
    { levelType: 'SUPPORT', levelPrice: h4Levels.support },
    { levelType: 'RESISTANCE', levelPrice: h4Levels.resistance },
  ];

  for (const { levelType, levelPrice } of candidates) {
    if (!hasConfluence(levelPrice, d1Levels, levelType, config.confluenceTolerancePoints)) continue;

    const state = evaluateLevelState(levelPrice, levelType, activeCandles, mid, config.entryRetracePoints, config.levelBreakOvershootPoints);
    if (state !== 'READY') continue;

    const isSupport = levelType === 'SUPPORT';
    const entry = isSupport ? currentPrice.ask : currentPrice.bid;
    return {
      ...base,
      action: isSupport ? 'OPEN_BUY' : 'OPEN_SELL',
      entryPrice: entry,
      stopLoss: isSupport ? entry - pointsToPrice(config.stopLossPoints) : entry + pointsToPrice(config.stopLossPoints),
      takeProfit: isSupport ? entry + pointsToPrice(config.takeProfitPoints) : entry - pointsToPrice(config.takeProfitPoints),
      levelUsed: levelType,
      reasoning:
        `Friend's rules: price touched the week-of-${weekLabel} H4 ${levelType.toLowerCase()} at ${levelPrice.toFixed(5)} (confirmed by a nearby D1 level) ` +
        `and has retraced >= ${config.entryRetracePoints}pt, confirming the bounce — ${isSupport ? 'buying' : 'selling'} at ${entry.toFixed(5)} with a ` +
        `symmetric ${config.stopLossPoints}/${config.takeProfitPoints}pt bracket.`,
    };
  }

  return {
    ...base,
    action: 'HOLD',
    reasoning: `Friend's rules: no confluence-confirmed H4/D1 level near ${mid.toFixed(5)} is currently touched-and-retraced (week-of-${weekLabel} support ${h4Levels.support.toFixed(5)} / resistance ${h4Levels.resistance.toFixed(5)}).`,
  };
}

export interface AutonomousEvaluationResult {
  decision: AutonomousRuleDecision;
  h4Levels: WeeklyRangeLevels | null;
  d1Levels: WeeklyRangeLevels | null;
  currentPrice: CurrentPrice | null;
  /** Computed independently of which branch `decision` took (unlike the mechanical decision, which stops at the first READY candidate) — for observability/dry-run output and reused by the AI decision layer's context so it doesn't need to recompute the same state machine a second time. Null when h4Levels/currentPrice are unavailable. */
  supportState: LevelState | null;
  resistanceState: LevelState | null;
}

/**
 * Fetches what `evaluateAutonomousRule` needs (H4 + D1 levels, the active
 * week's candles, recent intraday candles, live price) and calls it — the
 * same split `TechnicalAnalysisReportService` uses (candle-fetching in one
 * place, pure calculation in another). This is the one thing both a future
 * live dry-run loop and the backtest script are meant to call, so the two
 * never drift into evaluating the rule two different ways.
 */
@Injectable()
export class AutonomousRuleEngineService {
  constructor(
    private readonly candles: HistoricalCandleService,
    @Inject(AUTONOMOUS_RULES_CONFIG) private readonly config: AutonomousRulesConfig,
  ) {}

  async evaluate(now: Date, ordersPlacedToday: number): Promise<AutonomousEvaluationResult> {
    const { start, end } = getPreviousCompletedWeekBounds(now);
    // activeCandles/recentIntradayCandles are BOTH M15 — touch/retrace
    // detection needs finer resolution than H4 to catch the friend's
    // 50-point retrace pattern accurately (H4 bars are too coarse), and
    // this must be the exact same granularity the backtest script uses
    // (backtest-simulator.ts), or the two could silently evaluate the same
    // rule differently.
    const [h4RangeCandles, m15ActiveCandles, d1RangeCandles] = await Promise.all([
      this.candles.getCandlesInRange(SYMBOL, this.config.referenceTimeframe, start, now),
      this.candles.getCandlesInRange(SYMBOL, 'M15', end, now),
      this.candles.getCandlesInRange(SYMBOL, 'D1', start, now),
    ]);
    const h4Levels = calculateWeeklyRangeLevels(h4RangeCandles, now);
    const d1Levels = calculateWeeklyRangeLevels(d1RangeCandles, now);
    const currentPrice = await this.resolveCurrentPrice(now, h4RangeCandles);

    const decision = evaluateAutonomousRule({
      h4Levels,
      d1Levels,
      activeCandles: m15ActiveCandles,
      recentIntradayCandles: m15ActiveCandles,
      now,
      currentPrice,
      ordersPlacedToday,
      config: this.config,
    });

    let supportState: LevelState | null = null;
    let resistanceState: LevelState | null = null;
    if (h4Levels && currentPrice) {
      const mid = (currentPrice.bid + currentPrice.ask) / 2;
      supportState = evaluateLevelState(h4Levels.support, 'SUPPORT', m15ActiveCandles, mid, this.config.entryRetracePoints, this.config.levelBreakOvershootPoints);
      resistanceState = evaluateLevelState(h4Levels.resistance, 'RESISTANCE', m15ActiveCandles, mid, this.config.entryRetracePoints, this.config.levelBreakOvershootPoints);
    }

    return { decision, h4Levels, d1Levels, currentPrice, supportState, resistanceState };
  }

  /**
   * Prefers the live tick (seconds-fresh); falls back to the most recent
   * candle close in the already-fetched range, treated as bid=ask=close
   * (no spread) — an approximation only good enough for dry-run evaluation
   * when no live tick is available (e.g. run outside market hours), never
   * for an actual order (the real execution module in a later phase reads
   * the broker's own live price directly, never this fallback).
   */
  private async resolveCurrentPrice(now: Date, rangeCandles: { openTime: Date; close: number }[]): Promise<CurrentPrice | null> {
    const tick = await this.candles.getLiveTick(SYMBOL, now);
    if (tick) return { bid: tick.bid, ask: tick.ask };

    const latest = rangeCandles.at(-1);
    if (!latest) return null;
    return { bid: latest.close, ask: latest.close };
  }
}
