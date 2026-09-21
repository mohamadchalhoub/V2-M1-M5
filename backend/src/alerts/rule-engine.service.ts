import { Inject, Injectable, Logger } from '@nestjs/common';
import { RuleDefinition, RuleType } from '@prisma/client';
import { AnalyticsService } from '../analytics/analytics.service';
import { CurrentMetrics } from '../analytics/types/analytics.types';
import { MarketEventQueryService } from '../market-events/market-event-query.service';
import { PrismaService } from '../prisma/prisma.service';
import { CompoundParams, HighImpactEventExposureParams, TradeFrequencyMultipleParams } from '../rules/dto/rule-parameters.dto';
import { evaluateCompound, evaluateLeafRule } from '../rules/evaluators';
import { parseForexSymbolCurrencies } from '../rules/evaluators/forex-symbol';
import { RuleDefinitionsService } from '../rules/rule-definitions.service';
import { RuleStateService } from '../rules/rule-state.service';
import {
  DailyMarketAnalysisPayload,
  EvaluatorExtras,
  RuleComparisonOutcome,
  RuleEvaluationResult,
  RuleEvaluationStatus,
} from '../rules/types/rule-engine.types';
import { TECHNICAL_ANALYSIS_CONFIG, TechnicalAnalysisConfig } from '../technical-analysis/technical-analysis.config';
import { TechnicalAnalysisReportService } from '../technical-analysis/technical-analysis-report.service';
import { AlertLifecycleService } from './alert-lifecycle.service';

const RECENT_NEWS_LOOKBACK_MS = 24 * 60 * 60_000;
const UPCOMING_EVENTS_LOOKAHEAD_MINUTES = 24 * 60;

/**
 * The orchestrator (RULE_ENGINE_SPEC.md §3):
 *
 *   AnalyticsService → current metrics + baseline → evaluators → RuleEvaluationResult
 *     → AlertLifecycleService → rule_state transition (+ Alert row if applicable)
 *
 * Calls AnalyticsService.getCurrentMetrics/getHistoricalBaselines exactly
 * once per account per pass (plus one getTradesInTrailingWindow call per
 * distinct TRADE_FREQUENCY_MULTIPLE rule — window_minutes is a per-rule
 * parameter the fixed CurrentMetrics shape can't carry, see
 * RULE_ENGINE_SPEC.md §12.12 decision 2). Never touches MT5, the collector,
 * an AI provider, or Telegram. For the user's custom EURUSD rules
 * (technical-analysis phase), this class never fetches a candle or runs an
 * indicator calculation itself — it only calls TechnicalAnalysisReportService
 * and reshapes already-computed results into each evaluator's extras, same
 * posture as HIGH_IMPACT_EVENT_EXPOSURE's MarketEventQueryService call below.
 */
@Injectable()
export class RuleEngineService {
  private readonly logger = new Logger(RuleEngineService.name);

  constructor(
    private readonly analytics: AnalyticsService,
    private readonly ruleDefinitions: RuleDefinitionsService,
    private readonly ruleStates: RuleStateService,
    private readonly alertLifecycle: AlertLifecycleService,
    private readonly marketEventQuery: MarketEventQueryService,
    private readonly technicalAnalysis: TechnicalAnalysisReportService,
    private readonly prisma: PrismaService,
    @Inject(TECHNICAL_ANALYSIS_CONFIG) private readonly technicalAnalysisConfig: TechnicalAnalysisConfig,
  ) {}

  /**
   * `ruleTypeFilter`, when given, restricts this pass to exactly those rule
   * types — used by DailyMarketAnalysisProcessor's own cron schedule to
   * evaluate ONLY `DAILY_MARKET_ANALYSIS`. When omitted (the normal
   * snapshot-driven call from collector-ingress.controller.ts),
   * `DAILY_MARKET_ANALYSIS` is excluded by default — a scheduled analysis
   * has no business running on every ~10-second snapshot.
   */
  async evaluateAccount(
    accountId: string,
    now: Date = new Date(),
    options?: { ruleTypeFilter?: RuleType[] },
  ): Promise<RuleEvaluationResult[]> {
    let rules = await this.ruleDefinitions.findEnabledForAccount(accountId);
    if (options?.ruleTypeFilter) {
      const allowed = new Set(options.ruleTypeFilter);
      rules = rules.filter((r) => allowed.has(r.ruleType));
    } else {
      rules = rules.filter((r) => r.ruleType !== RuleType.DAILY_MARKET_ANALYSIS);
    }
    if (rules.length === 0) {
      return [];
    }

    const [currentMetrics, baseline] = await Promise.all([
      this.analytics.getCurrentMetrics(accountId, now),
      this.analytics.getHistoricalBaselines(accountId, { now }),
    ]);

    const results: RuleEvaluationResult[] = [];

    // Leaf rules first, each persisted immediately — so COMPOUND rules
    // (evaluated next) read this pass's freshly-updated rule_state, never a
    // stale value from a previous tick (RULE_ENGINE_SPEC.md §3 ordering).
    const leafRules = rules.filter((r) => r.ruleType !== RuleType.COMPOUND);
    const compoundRules = rules.filter((r) => r.ruleType === RuleType.COMPOUND);

    for (const rule of leafRules) {
      const extra = await this.buildExtras(rule, accountId, now, currentMetrics);
      const outcome = evaluateLeafRule(
        rule.ruleType as Exclude<RuleType, 'COMPOUND'>,
        rule.parameters as Record<string, unknown>,
        currentMetrics,
        baseline,
        extra,
      );
      const result = this.toResult(rule, outcome, now);
      results.push(result);
      await this.alertLifecycle.apply(rule, result);

      // Reliability pass — DAILY_MARKET_ANALYSIS is a scheduled report, not
      // a continuous condition: every real trigger is inherently NEW
      // information (a new day's bias/Fibonacci/S&R state), never a
      // continuation of an "ongoing episode" the way DRAWDOWN/
      // MARGIN_UTILIZATION are. But AlertLifecycleService's generic
      // ACTIVE/INACTIVE episode model (RULE_ENGINE_SPEC.md §4) assumes the
      // opposite by default — a re-notify within an already-ACTIVE episode
      // deliberately skips AI narration (§8: narrate the episode's first
      // alert only). Left alone, that meant this rule got AI narration on
      // its first-ever trigger and never again, silently (found via a live
      // audit — confirmed the rule's rule_state simply never returns to
      // INACTIVE, since its evaluator has no NOT_TRIGGERED path of its own).
      // Explicitly resetting to INACTIVE immediately after a real trigger
      // means tomorrow's fire is unconditionally seen as a fresh episode
      // again, so it gets AI narration every day — matching every other
      // rule's actual behavior, not just this rule type's first day.
      // Double-fire protection for the SAME day is a separate concern,
      // handled by buildExtras' own "already ran today" check below (and,
      // redundantly, by DailyMarketAnalysisProcessor's own guard) — not by
      // the cooldown this reset bypasses.
      if (rule.ruleType === RuleType.DAILY_MARKET_ANALYSIS && outcome.status === RuleEvaluationStatus.TRIGGERED) {
        await this.ruleStates.markInactive(rule.id, rule.accountId, now);
      }
    }

    if (compoundRules.length > 0) {
      const componentIds = new Set<string>();
      for (const rule of compoundRules) {
        const params = rule.parameters as unknown as CompoundParams;
        params.component_rule_ids.forEach((id) => componentIds.add(id));
      }
      const stateMap = await this.ruleStates.getManyByIds([...componentIds]);

      for (const rule of compoundRules) {
        const outcome = evaluateCompound(rule.parameters as unknown as CompoundParams, stateMap);
        const result = this.toResult(rule, outcome, now);
        results.push(result);
        await this.alertLifecycle.apply(rule, result);
      }
    }

    this.logger.log(
      `evaluated ${results.length} rule(s) for account=${accountId}: ` +
        `${results.filter((r) => r.status === 'TRIGGERED').length} triggered`,
    );
    return results;
  }

  private async buildExtras(
    rule: RuleDefinition,
    accountId: string,
    now: Date,
    currentMetrics: CurrentMetrics,
  ): Promise<EvaluatorExtras> {
    if (rule.ruleType === RuleType.TRADE_FREQUENCY_MULTIPLE) {
      const params = rule.parameters as unknown as TradeFrequencyMultipleParams;
      const tradesInWindow = await this.analytics.getTradesInTrailingWindow(accountId, params.window_minutes, now);
      return { tradesInWindow, now };
    }

    if (rule.ruleType === RuleType.HIGH_IMPACT_EVENT_EXPOSURE) {
      const params = rule.parameters as unknown as HighImpactEventExposureParams;
      // Currencies to check are derived from THIS account's own currently
      // open positions, not a fixed config list — a rule only cares about
      // events affecting a currency the account is actually exposed to.
      const currencies = new Set<string>();
      for (const { symbol } of currentMetrics.position.positionVolumeBySymbol) {
        const pair = parseForexSymbolCurrencies(symbol);
        if (pair) {
          currencies.add(pair[0]);
          currencies.add(pair[1]);
        }
      }
      const upcomingHighImpactEvents = await this.marketEventQuery.findUpcomingHighImpactEvents(
        [...currencies],
        now,
        params.minutes_before,
      );
      return { upcomingHighImpactEvents, now };
    }

    if (rule.ruleType === RuleType.SUPPORT_RESISTANCE_PROXIMITY) {
      const { currentPrice, matches } = await this.technicalAnalysis.getSupportResistanceMatches(now);
      // No current price at all is a genuine data problem (INSUFFICIENT_DATA
      // in the evaluator, which checks `=== undefined`) — distinct from "we
      // have a price but nothing is nearby" (NOT_TRIGGERED, an empty array).
      if (currentPrice === null) return { now };
      return {
        supportResistanceMatches: matches.map(({ timeframe, match }) => ({
          timeframe,
          levelType: match.level.type,
          levelPrice: match.level.price,
          currentPrice,
          distancePoints: match.distancePoints,
          currentPriceIsAbove: match.currentPriceIsAbove,
          trend: match.trend,
        })),
        now,
      };
    }

    if (rule.ruleType === RuleType.ICHIMOKU_BREAKOUT) {
      const breakouts = await this.technicalAnalysis.getIchimokuBreakouts(now);
      return {
        ichimokuBreakouts: breakouts.map((b) => ({
          timeframe: b.timeframe,
          direction: b.direction,
          previousState: b.previousState,
          newState: b.newState,
          breakoutPrice: b.breakoutPrice,
          timestamp: b.timestamp.toISOString(),
        })),
        now,
      };
    }

    if (rule.ruleType === RuleType.DAILY_MARKET_ANALYSIS) {
      // Reliability pass — the immediate INACTIVE reset below (after a real
      // trigger) means this rule no longer relies on cooldown for same-day
      // dedup, so it needs its own explicit guard here instead: without it,
      // a second evaluation later the same day (e.g. the real cron AND a
      // manual `trigger-daily-analysis` run) would see INACTIVE + real data
      // and fire a genuine second alert (with a second AI/Telegram send),
      // not a harmless cooldown-suppressed re-notify. `{ now }` (no
      // dailyMarketAnalysis) is the evaluator's existing INSUFFICIENT_DATA
      // path — a true no-op, same as "no current price yet" elsewhere in
      // this method.
      if (await this.hasDailyMarketAnalysisAlreadyRunToday(rule.id, now)) {
        return { now };
      }
      const dailyMarketAnalysis = await this.buildDailyMarketAnalysisPayload(now);
      return dailyMarketAnalysis ? { dailyMarketAnalysis, now } : { now };
    }

    return { now };
  }

  /** Same "already ran today" concept as DailyMarketAnalysisProcessor.alreadyRanToday — duplicated (not imported) since that one is keyed off a specific accountId loop and this one off a single ruleId, and both stay small enough that sharing isn't worth a cross-cutting abstraction. Not imported for a second reason too: daily-market-analysis.processor.ts's own constructor takes a RuleEngineService, so importing anything from it here would create a circular import between the two files, which silently breaks NestJS's constructor-parameter reflection (a real issue hit and fixed during this change — DailyMarketAnalysisProcessor's `ruleEngine` param stopped resolving, `nest can't resolve dependencies... argument Object at index [2]`). */
  private async hasDailyMarketAnalysisAlreadyRunToday(ruleId: string, now: Date): Promise<boolean> {
    const lastAlert = await this.prisma.alert.findFirst({
      where: { ruleId },
      orderBy: { triggeredAt: 'desc' },
      select: { triggeredAt: true },
    });
    if (!lastAlert) return false;
    const tz = this.technicalAnalysisConfig.dailyAnalysisTimezone;
    return dateKeyInTimezone(lastAlert.triggeredAt, tz) === dateKeyInTimezone(now, tz);
  }

  /** Rules 3+4 combined — reshapes TechnicalAnalysisReportService's own report into the rules module's local structural payload type (rules has no dependency on technical-analysis, same "alerts converts" posture as every other cross-module extra). Null only when there's no current price to anchor it to. */
  private async buildDailyMarketAnalysisPayload(now: Date): Promise<DailyMarketAnalysisPayload | null> {
    const report = await this.technicalAnalysis.getFullReport(now);
    if (!report) return null;

    const [upcomingEvents, recentNews] = await Promise.all([
      this.marketEventQuery.findUpcomingHighImpactEvents(['EUR', 'USD'], now, UPCOMING_EVENTS_LOOKAHEAD_MINUTES),
      this.marketEventQuery.findRecentNews(['EUR', 'USD'], new Date(now.getTime() - RECENT_NEWS_LOOKBACK_MS)),
    ]);

    const supportResistance: DailyMarketAnalysisPayload['supportResistance'] = [];
    for (const { timeframe, nearestSupport, nearestResistance } of report.supportResistance) {
      if (nearestResistance) supportResistance.push({ timeframe, levelType: 'RESISTANCE', price: nearestResistance.price });
      if (nearestSupport) supportResistance.push({ timeframe, levelType: 'SUPPORT', price: nearestSupport.price });
    }

    return {
      symbol: report.symbol,
      currentPrice: report.currentPrice,
      marketBias: report.marketDirection.dailyBias,
      biasConfidence: report.marketDirection.confidence,
      biasReasons: report.marketDirection.reasons,
      fibonacci: report.fibonacci
        ? {
            swingHigh: report.fibonacci.swingHigh.price,
            swingLow: report.fibonacci.swingLow.price,
            direction: report.fibonacci.direction,
            levels: report.fibonacci.levels,
            nearestLevelRatio: report.fibonacci.nearestLevel.ratio,
            nearestLevelPrice: report.fibonacci.nearestLevel.price,
          }
        : null,
      supportResistance,
      ichimoku: report.ichimoku.map((i) => ({ timeframe: i.timeframe, position: i.position, spanA: i.spanA, spanB: i.spanB })),
      upcomingEconomicEvents: upcomingEvents.map((e) => ({
        title: e.title,
        scheduledAt: e.scheduledAt.toISOString(),
        affectedCurrencies: e.affectedCurrencies,
      })),
      recentNews: recentNews.map((n) => ({ title: n.title, scheduledAt: n.scheduledAt.toISOString(), sentiment: n.sentiment })),
      timestamp: report.timestamp.toISOString(),
    };
  }

  private toResult(rule: RuleDefinition, outcome: RuleComparisonOutcome, now: Date): RuleEvaluationResult {
    return {
      ruleId: rule.id,
      accountId: rule.accountId,
      ruleType: rule.ruleType,
      evaluatedAt: now,
      parameters: rule.parameters as Record<string, unknown>,
      ...outcome,
    };
  }
}

/** The calendar date (YYYY-MM-DD) `date` falls on in `timezone` — same technique daily-market-analysis.processor.ts's own dateKeyInTimezone uses, duplicated here rather than imported (see hasDailyMarketAnalysisAlreadyRunToday's comment above for why). */
function dateKeyInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
