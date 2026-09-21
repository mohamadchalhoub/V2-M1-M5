import { Inject, Injectable, Logger } from '@nestjs/common';
import { CandleTimeframe } from '@prisma/client';
import { CandleData, HistoricalCandleService } from '../market-data/historical-candle.service';
import { calculateFibonacciAnalysis, FibonacciAnalysis } from './fibonacci.service';
import { calculateIchimokuState, detectIchimokuBreakout, IchimokuBreakout, IchimokuState } from './ichimoku.service';
import { calculateMarketDirection, MarketDirectionAnalysis } from './market-direction.service';
import { calculateSupportResistanceLevels, findLevelsNearPrice, LevelProximityMatch, SupportResistanceLevel } from './support-resistance.service';
import { TECHNICAL_ANALYSIS_CONFIG, TechnicalAnalysisConfig } from './technical-analysis.config';

const EURUSD = 'EURUSD';

// TECHNICAL_ANALYSIS_SPEC.md §3 — how far back to fetch candles per
// timeframe. Chosen so there is comfortably more than Ichimoku's own
// 78-candle minimum (26 displacement + 52 Senkou B period) on every
// timeframe, while staying bounded — never "all of history" on every call.
// W1/MN1 (Ichimoku breakout alerts only, not support/resistance — see
// SUPPORT_RESISTANCE_TIMEFRAMES below) use a much longer lookback than
// D1's 500 days because each Ichimoku candle "costs" far more wall-clock
// time: 78 W1 candles alone need ~1.5 years, so 1095d (3yr, 156 candles)
// and 3650d (10yr, 120 MN1 candles) keep comfortable headroom above the
// 78-candle minimum without requesting "all of history" on every call.
const TIMEFRAME_LOOKBACK_DAYS: Record<CandleTimeframe, number> = {
  M5: 2,
  M15: 5,
  M30: 10,
  H1: 30,
  H4: 90,
  D1: 500,
  W1: 1095,
  MN1: 3650,
  // Gold historical-collection phase — M1 added to CandleTimeframe for the
  // tick/candle backfill's finest granularity (not used by this module's
  // own support/resistance/Ichimoku/Fibonacci features — see
  // technical-analysis.config.ts's own separate, unchanged timeframe
  // lists); this entry exists only because this Record must stay
  // exhaustive over the full enum.
  M1: 1,
};

// User's Rule 1 fixes these three timeframes explicitly (not configurable
// — unlike ICHIMOKU_TIMEFRAMES, which the user did ask to be configurable).
export const SUPPORT_RESISTANCE_TIMEFRAMES: CandleTimeframe[] = ['H1', 'H4', 'D1'];

// User request (reliability pass) — H1 support/resistance now starts from a
// tight, recent 14-calendar-day window instead of the shared
// TIMEFRAME_LOOKBACK_DAYS.H1 (30 days) — deliberately a SEPARATE constant
// from that map, and applied only inside getSupportResistanceLevels below,
// so Ichimoku's own H1 usage (getIchimokuState/getIchimokuBreakouts, which
// call fetchCandles directly) is completely unaffected. If no fractal-pivot
// level exists in that window (a genuinely quiet recent market), the window
// doubles — 14 -> 28 -> 56 -> 112 -> 224 -> 365 (SR_H1_MAX_LOOKBACK_DAYS) —
// until at least one level is found or the cap is hit; date-range queries
// naturally return "the full available dataset" on their own once the
// window exceeds it, so no separate "dataset size" check is needed. H4/D1
// are untouched — still the original, unbounded-by-this-change
// TIMEFRAME_LOOKBACK_DAYS values (90d/500d).
const SR_H1_INITIAL_LOOKBACK_DAYS = 14;
const SR_H1_MAX_LOOKBACK_DAYS = 365;

export interface SupportResistanceMatch {
  timeframe: CandleTimeframe;
  match: LevelProximityMatch;
}

export interface IchimokuBreakoutWithTimeframe extends IchimokuBreakout {
  timeframe: CandleTimeframe;
}

export interface NearestSupportResistance {
  timeframe: CandleTimeframe;
  nearestSupport: SupportResistanceLevel | null;
  nearestResistance: SupportResistanceLevel | null;
}

export interface TechnicalAnalysisReport {
  symbol: string;
  currentPrice: number;
  marketDirection: MarketDirectionAnalysis;
  fibonacci: FibonacciAnalysis | null;
  supportResistance: NearestSupportResistance[];
  ichimoku: (IchimokuState & { timeframe: CandleTimeframe })[];
  timestamp: Date;
}

/**
 * The "Technical Analysis / Indicator Services" layer (user's own
 * architecture diagram): owns fetching real EURUSD candle data
 * (HistoricalCandleService — "Market Data" layer, provides facts only) and
 * calling the pure calculation functions in this module. The rule engine
 * (alerts/rule-engine.service.ts) calls this service and only ever
 * receives already-computed results — it never fetches candles or calls a
 * calculation function itself, so trading-calculation logic lives in
 * exactly one place, not scattered into the rule engine. A dashboard/API
 * consumer (technical-analysis.controller.ts) calls the same service, so
 * "what triggered the alert" and "what the dashboard shows right now" can
 * never silently diverge.
 */
@Injectable()
export class TechnicalAnalysisReportService {
  private readonly logger = new Logger(TechnicalAnalysisReportService.name);

  constructor(
    private readonly historicalCandles: HistoricalCandleService,
    @Inject(TECHNICAL_ANALYSIS_CONFIG) private readonly config: TechnicalAnalysisConfig,
  ) {}

  private async fetchCandles(timeframe: CandleTimeframe, now: Date): Promise<CandleData[]> {
    const lookbackMs = TIMEFRAME_LOOKBACK_DAYS[timeframe] * 86_400_000;
    return this.historicalCandles.getCandlesInRange(EURUSD, timeframe, new Date(now.getTime() - lookbackMs), now);
  }

  /**
   * The latest available EURUSD price. Reliability pass: prefers a genuine
   * live bid pushed by the collector within the last minute (LiveTick) over
   * the most recent M5 candle's close, which is only ever ~10 minutes
   * stale at best — falls back to the candle close when no fresh tick
   * exists (e.g. before the collector's first successful push).
   */
  async getCurrentPrice(now: Date): Promise<number | null> {
    return (await this.getPriceSnapshot(now)).currentPrice;
  }

  /**
   * Stage 3A addition — `currentPrice` plus a `priorPrice` reference point,
   * so callers can tell whether price is approaching or retreating from a
   * level. `priorPrice` always comes from the 30-minute M5 window (a live
   * tick has no history of its own to compare against) — `null` when that
   * window has only one candle in it.
   */
  private async getPriceSnapshot(now: Date): Promise<{ currentPrice: number | null; priorPrice: number | null }> {
    const candles = await this.historicalCandles.getCandlesInRange(EURUSD, 'M5', new Date(now.getTime() - 30 * 60_000), now);
    const priorPrice = candles.length > 1 ? candles[0].close : null;

    const liveTick = await this.historicalCandles.getLiveTick(EURUSD, now);
    if (liveTick) {
      return { currentPrice: liveTick.bid, priorPrice };
    }

    if (candles.length === 0) return { currentPrice: null, priorPrice: null };
    return {
      currentPrice: candles[candles.length - 1].close,
      priorPrice,
    };
  }

  async getSupportResistanceLevels(timeframe: CandleTimeframe, now: Date): Promise<SupportResistanceLevel[]> {
    if (timeframe === 'H1') return this.getSupportResistanceLevelsForH1(now);
    return calculateSupportResistanceLevels(await this.fetchCandles(timeframe, now), timeframe);
  }

  /** See SR_H1_INITIAL_LOOKBACK_DAYS's comment above — the dynamic 14-day-with-fallback-expansion window, H1 only. */
  private async getSupportResistanceLevelsForH1(now: Date): Promise<SupportResistanceLevel[]> {
    let lookbackDays = SR_H1_INITIAL_LOOKBACK_DAYS;
    for (;;) {
      const from = new Date(now.getTime() - lookbackDays * 86_400_000);
      const candles = await this.historicalCandles.getCandlesInRange(EURUSD, 'H1', from, now);
      const levels = calculateSupportResistanceLevels(candles, 'H1');
      const atCap = lookbackDays >= SR_H1_MAX_LOOKBACK_DAYS;

      if (levels.length > 0 || atCap) {
        this.logger.debug(`S/R H1 lookback: ${lookbackDays}d, ${candles.length} candle(s), ${levels.length} level(s) found`);
        return levels;
      }

      this.logger.debug(`S/R H1 lookback: ${lookbackDays}d found 0 levels, expanding`);
      lookbackDays = Math.min(lookbackDays * 2, SR_H1_MAX_LOOKBACK_DAYS);
    }
  }

  /** Rule 1 — every H1/H4/D1 level within SUPPORT_RESISTANCE_PROXIMITY_POINTS of the current price, nearest-first. */
  async getSupportResistanceMatches(now: Date): Promise<{ currentPrice: number | null; matches: SupportResistanceMatch[] }> {
    const { currentPrice, priorPrice } = await this.getPriceSnapshot(now);
    if (currentPrice === null) return { currentPrice: null, matches: [] };

    const matches: SupportResistanceMatch[] = [];
    for (const timeframe of SUPPORT_RESISTANCE_TIMEFRAMES) {
      const levels = await this.getSupportResistanceLevels(timeframe, now);
      for (const match of findLevelsNearPrice(levels, currentPrice, this.config.supportResistanceProximityPoints, priorPrice)) {
        matches.push({ timeframe, match });
      }
    }
    matches.sort((a, b) => a.match.distancePoints - b.match.distancePoints);
    return { currentPrice, matches };
  }

  async getIchimokuState(timeframe: CandleTimeframe, now: Date): Promise<IchimokuState> {
    return calculateIchimokuState(await this.fetchCandles(timeframe, now), timeframe);
  }

  /** Rule 2 — every configured ICHIMOKU_TIMEFRAMES timeframe's Ichimoku state, in config order. */
  async getIchimokuStates(now: Date): Promise<(IchimokuState & { timeframe: CandleTimeframe })[]> {
    const states: (IchimokuState & { timeframe: CandleTimeframe })[] = [];
    for (const timeframe of this.config.ichimokuTimeframes) {
      states.push({ ...(await this.getIchimokuState(timeframe, now)), timeframe });
    }
    return states;
  }

  /** Rule 2 — a confirmed, candle-close breakout on any configured ICHIMOKU_TIMEFRAMES timeframe. */
  async getIchimokuBreakouts(now: Date): Promise<IchimokuBreakoutWithTimeframe[]> {
    const breakouts: IchimokuBreakoutWithTimeframe[] = [];
    for (const timeframe of this.config.ichimokuTimeframes) {
      const breakout = detectIchimokuBreakout(await this.fetchCandles(timeframe, now), timeframe);
      if (breakout) breakouts.push({ ...breakout, timeframe });
    }
    return breakouts;
  }

  /** Rule 3 — Fibonacci analysis over the D1 FIBONACCI_LOOKBACK window. */
  async getFibonacciAnalysis(now: Date): Promise<FibonacciAnalysis | null> {
    const currentPrice = await this.getCurrentPrice(now);
    if (currentPrice === null) return null;
    const from = new Date(now.getTime() - this.config.fibonacciLookbackDays * 86_400_000);
    const candles = await this.historicalCandles.getCandlesInRange(EURUSD, 'D1', from, now);
    return calculateFibonacciAnalysis(candles, currentPrice);
  }

  /** Rule 4 — H4 + D1 (MARKET_DIRECTION_LOOKBACK window) market bias. */
  async getMarketDirection(now: Date): Promise<MarketDirectionAnalysis> {
    const h4Candles = await this.fetchCandles('H4', now);
    const from = new Date(now.getTime() - this.config.marketDirectionLookbackDays * 86_400_000);
    const d1Candles = await this.historicalCandles.getCandlesInRange(EURUSD, 'D1', from, now);
    return calculateMarketDirection(EURUSD, h4Candles, d1Candles, now);
  }

  /** The nearest support and nearest resistance to the current price, per H1/H4/D1 — used by the daily report and the dashboard, distinct from the proximity-alert matches above (no threshold filtering here). */
  async getNearestSupportResistance(currentPrice: number, now: Date): Promise<NearestSupportResistance[]> {
    const result: NearestSupportResistance[] = [];
    for (const timeframe of SUPPORT_RESISTANCE_TIMEFRAMES) {
      const levels = await this.getSupportResistanceLevels(timeframe, now);
      const nearestResistance = levels.filter((l) => l.type === 'RESISTANCE' && l.price >= currentPrice).sort((a, b) => a.price - b.price)[0] ?? null;
      const nearestSupport = levels.filter((l) => l.type === 'SUPPORT' && l.price <= currentPrice).sort((a, b) => b.price - a.price)[0] ?? null;
      result.push({ timeframe, nearestSupport, nearestResistance });
    }
    return result;
  }

  /** Rules 3+4 combined, plus current S/R and Ichimoku state — everything the daily report and the dashboard's technical-analysis panel need in one call. */
  async getFullReport(now: Date): Promise<TechnicalAnalysisReport | null> {
    const currentPrice = await this.getCurrentPrice(now);
    if (currentPrice === null) return null;

    const [marketDirection, fibonacci, supportResistance, ichimoku] = await Promise.all([
      this.getMarketDirection(now),
      this.getFibonacciAnalysis(now),
      this.getNearestSupportResistance(currentPrice, now),
      this.getIchimokuStates(now),
    ]);

    return { symbol: EURUSD, currentPrice, marketDirection, fibonacci, supportResistance, ichimoku, timestamp: now };
  }
}
