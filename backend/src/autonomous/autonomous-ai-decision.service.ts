import { Inject, Injectable, Logger } from '@nestjs/common';
import { HistoricalPatternSummaryService } from '../ai/historical-pattern-summary.service';
import { withTransientRetry } from '../ai/retry';
import { MarketEventQueryService } from '../market-events/market-event-query.service';
import { AutonomousRuleEngineService, SYMBOL } from './autonomous-rule-engine.service';
import { AUTONOMOUS_RULES_CONFIG, AutonomousRulesConfig } from './autonomous-rules.config';
import { AUTONOMOUS_AI_PROVIDER } from './autonomous-ai-provider.token';
import { AutonomousAiContext, AutonomousAiDecision, AutonomousAiProvider } from './autonomous-ai-decision.types';
import { validateAutonomousAiDecision } from './validate-autonomous-ai-decision';

const MONITORED_CURRENCIES = ['EUR', 'USD'];
const EVENT_LOOKAHEAD_MINUTES = 24 * 60;
const NEWS_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface AutonomousAiEvaluationResult {
  /** Null when the mechanical rule engine found no candidate — the AI is never invoked in that case (AUTONOMOUS_DEMO_TRADING_PLAN.md §13.1: a confirm/veto layer over mechanically-valid setups, never the originator of one). */
  aiDecision: AutonomousAiDecision | null;
  aiRejected: boolean;
  aiRejectionReason: string | null;
  aiRawResponse: unknown;
  aiProvider: string | null;
  aiModel: string | null;
}

/**
 * Phase 4 — AUTONOMOUS_DEMO_TRADING_PLAN.md §3. Sits on top of
 * `AutonomousRuleEngineService`: only when the deterministic engine has
 * already found a confluence-confirmed, touched-and-retraced candidate
 * does this call the AI at all, so the AI never originates a trade idea —
 * it can only confirm one or veto it back to HOLD (or be rejected outright
 * by `validateAutonomousAiDecision` if its own numbers don't check out).
 * This is also what keeps real API call volume to roughly one per
 * mechanical candidate (a few dozen a year, per the Phase 3 backtest)
 * rather than one per tick.
 *
 * KNOWN GAP for whenever a live scheduled loop is built (no scheduler
 * exists yet — this service is only ever called manually, once per
 * invocation, by evaluate-autonomous-rule.ts): if a scheduler calls
 * `evaluate()` every few minutes, a mechanical candidate that persists
 * across several calls (price sitting in an already-retraced zone for a
 * while) would get re-asked to the AI on every single call, not just once.
 * Found live in this session's own Phase 5 backtest — the FIRST version of
 * that backtest script made this exact mistake and turned ~60 intended AI
 * calls into ~1,900 real ones. The backtest's fix (mark the day as "the AI
 * was already asked" as soon as it's consulted, regardless of outcome, not
 * only when a trade opens) is NOT yet wired into this live-facing service,
 * since `ordersPlacedToday` (this service's only per-day signal) only
 * tracks actual orders, and no order ever exists for a veto/rejection to
 * increment it. Whatever builds the live scheduler needs an equivalent
 * "already consulted the AI today" signal, separate from "orders placed
 * today," before running this on a recurring schedule.
 */
@Injectable()
export class AutonomousAiDecisionService {
  private readonly logger = new Logger(AutonomousAiDecisionService.name);

  constructor(
    private readonly ruleEngine: AutonomousRuleEngineService,
    private readonly historicalPattern: HistoricalPatternSummaryService,
    private readonly marketEvents: MarketEventQueryService,
    @Inject(AUTONOMOUS_AI_PROVIDER) private readonly aiProvider: AutonomousAiProvider,
    @Inject(AUTONOMOUS_RULES_CONFIG) private readonly config: AutonomousRulesConfig,
  ) {}

  async evaluate(now: Date, ordersPlacedToday: number) {
    const mechanical = await this.ruleEngine.evaluate(now, ordersPlacedToday);

    if (mechanical.decision.action === 'HOLD') {
      const noAiResult: AutonomousAiEvaluationResult = {
        aiDecision: null,
        aiRejected: false,
        aiRejectionReason: null,
        aiRawResponse: null,
        aiProvider: null,
        aiModel: null,
      };
      return { mechanical, ai: noAiResult };
    }

    // Non-null by construction: evaluateAutonomousRule never returns
    // OPEN_BUY/OPEN_SELL without h4Levels/currentPrice/levelUsed set.
    const context: AutonomousAiContext = {
      now,
      currentPrice: mechanical.currentPrice!,
      h4Levels: mechanical.h4Levels!,
      d1Levels: mechanical.d1Levels,
      supportState: mechanical.supportState!,
      resistanceState: mechanical.resistanceState!,
      mechanicalCandidateLevel: mechanical.decision.levelUsed!,
      historicalPattern: await this.historicalPattern.build(),
      upcomingEvents: await this.marketEvents.findUpcomingHighImpactEvents(MONITORED_CURRENCIES, now, EVENT_LOOKAHEAD_MINUTES),
      recentNews: await this.marketEvents.findRecentNews(MONITORED_CURRENCIES, new Date(now.getTime() - NEWS_LOOKBACK_MS)),
      ordersPlacedToday,
    };

    let ai: AutonomousAiEvaluationResult;
    try {
      const raw = await withTransientRetry(() => this.aiProvider.decide(context));
      const decision = validateAutonomousAiDecision(raw, this.config);
      // Audit finding, now fixed: this used to hardcode 'gemini' regardless
      // of which provider in the fallback chain actually answered — reading
      // `providerName` AFTER a successful decide() reports the true source
      // (see AutonomousAiProvider.providerName's own comment).
      ai = { aiDecision: decision, aiRejected: false, aiRejectionReason: null, aiRawResponse: raw, aiProvider: this.aiProvider.providerName, aiModel: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI decision rejected/failed for ${SYMBOL} candidate at ${now.toISOString()}: ${message}`);
      ai = { aiDecision: null, aiRejected: true, aiRejectionReason: message, aiRawResponse: null, aiProvider: null, aiModel: null };
    }

    return { mechanical, ai };
  }
}
