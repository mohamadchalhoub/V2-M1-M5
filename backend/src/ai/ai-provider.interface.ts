import { RuleType } from '@prisma/client';

export interface SimilarPastEvent {
  alertId: string;
  triggeredAt: Date;
  /** Always an approximation for now — AI_INTEGRATION_SPEC.md §6 decision: derived from other Alert timestamps, not exact episode boundaries. */
  briefOutcome: string;
}

/**
 * Market intelligence, AI phase 6 — everything the provider is told about
 * events/news, queried fresh at analysis time (same posture as
 * `similarPastEvents` below: NOT frozen at alert-creation the way
 * `triggerValues`/`baselineSnapshot` are, since it's supplementary context
 * about the world right now, not a record of what caused this specific
 * alert). Empty arrays are a known, common state (market intelligence
 * disabled, or nothing currently relevant) — never omitted or null, so a
 * provider/prompt never has to special-case "missing" vs. "genuinely none."
 */
export interface MarketContextEvent {
  id: string;
  title: string;
  scheduledAt: string;
  affectedCurrencies: string[];
}
export interface MarketContextNews {
  id: string;
  title: string;
  scheduledAt: string;
  sentiment: string;
  sourceUrl: string | null;
}
export interface MarketContext {
  /** How the two lists below were filtered — always includes EUR/USD (market-context-builder.service.ts's MONITORED_CURRENCIES, this system's one traded pair), plus whatever currencies this account's own currently open positions add. */
  exposedCurrencies: string[];
  upcomingHighImpactEvents: MarketContextEvent[];
  recentNews: MarketContextNews[];
}

/**
 * AI provider phase — deterministic, aggregate-only historical EURUSD
 * pattern statistics for THIS account's own closed trades, one side
 * (`historical-pattern-summary.service.ts`). Never raw candles or
 * per-trade detail — the AI must never receive thousands of candles
 * (historical-charts spec's own §11 rule), only descriptive summaries with
 * an explicit sample size and confidence label, so a small sample is never
 * silently presented with false authority.
 */
export interface HistoricalPatternSide {
  sampleSize: number;
  /** Fraction 0-1, null when sampleSize is 0 — never fabricated from zero trades. */
  winRate: number | null;
  /** Same currency units as Trade.profit, null when sampleSize is 0. */
  averagePnl: number | null;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
}
export interface HistoricalPatternContext {
  symbol: string;
  buy: HistoricalPatternSide;
  sell: HistoricalPatternSide;
}

/** Everything the provider is given — built entirely from already-frozen Alert data (Phase 4's immutability guarantee) plus fresh, supplementary market context, never a fresh AnalyticsService/RuleEngineService call. */
export interface AlertContext {
  alertId: string;
  ruleType: RuleType;
  ruleName: string;
  triggerValues: Record<string, unknown>;
  baselineSnapshot: Record<string, unknown>;
  triggeredAt: Date;
  similarPastEvents: SimilarPastEvent[];
  marketContext: MarketContext;
  historicalPatternContext: HistoricalPatternContext;
}

/**
 * AI_INTEGRATION_SPEC.md §3 (original narration fields) plus market
 * intelligence phase 6's risk-context fields. `recommended_action` is the
 * ONE deliberate, narrow exception to §3's original "no recommendation
 * field, structurally" rule — added on explicit sign-off, and kept safe the
 * same way every other structured field in this system is: a CLOSED enum
 * of four risk-management POSTURES (never a trade direction, never
 * "buy"/"sell", never free text) validated against this exact list
 * (validate-ai-result.ts) before it can go anywhere near Telegram. Every
 * free-text field — including the new `assessment` — still goes through
 * the unweakened keyword safety filter (safety-filter.ts).
 */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type NewsSentimentLevel = 'NEGATIVE' | 'NEUTRAL' | 'POSITIVE' | 'MIXED';
export type RecommendedAction = 'MONITOR' | 'REDUCE_RISK' | 'AVOID_NEW_EXPOSURE' | 'REVIEW_POSITION';

export interface AiAnalysisResult {
  situation_summary: string;
  historical_comparison: string;
  similar_past_events: { alert_id: string; triggered_at: string; brief_outcome: string }[];
  statistical_context: string;
  market_risk: RiskLevel;
  exposure_risk: RiskLevel;
  event_risk: RiskLevel;
  news_sentiment: NewsSentimentLevel;
  /** 0-1, same fraction convention as every threshold in this codebase (rules/dto/rule-parameters.dto.ts) — how much evidence actually supports this assessment, not a trade-confidence score. */
  confidence: number;
  /** Free text — narrates the risk picture, safety-filtered exactly like the three fields above. Never itself an instruction; that's what `recommended_action` is for, as a closed enum. */
  assessment: string;
  recommended_action: RecommendedAction;
}

/**
 * Provider abstraction (AI_INTEGRATION_SPEC.md §2, Phase 0 §10 Req. 11) —
 * `ai/ai-analysis.processor.ts` depends on this interface only, never a
 * concrete provider by name. Swapping AI_MODEL, or adding a second
 * provider, touches this module and nothing else.
 */
export interface AiProvider {
  analyze(context: AlertContext): Promise<AiAnalysisResult>;
}
