import { RuleRunState, RuleType } from '@prisma/client';

// RULE_ENGINE_SPEC.md §9. Three statuses, not two — INSUFFICIENT_DATA is a
// first-class outcome so "we couldn't check" is never collapsed into "we
// checked, and it's fine" (§8).
export enum RuleEvaluationStatus {
  TRIGGERED = 'TRIGGERED',
  NOT_TRIGGERED = 'NOT_TRIGGERED',
  INSUFFICIENT_DATA = 'INSUFFICIENT_DATA',
}

/**
 * What one evaluator function returns — no rule/account identity yet, that's
 * added by the orchestrator. Values are plain JSON-serializable data (scalars
 * or nested records, e.g. COMPOUND's per-component state map) — these are
 * written verbatim into Alert.triggerValues/baselineSnapshot (jsonb).
 */
export interface RuleComparisonOutcome {
  status: RuleEvaluationStatus;
  reasonCode: string;
  triggerValues: Record<string, unknown>;
  baselineValues: Record<string, unknown>;
}

// RULE_ENGINE_SPEC.md §9 — deliberately has no AI-generated text and no
// recommendation/action/suggested_next_step field.
export interface RuleEvaluationResult extends RuleComparisonOutcome {
  ruleId: string;
  accountId: string;
  ruleType: RuleType;
  evaluatedAt: Date;
  parameters: Record<string, unknown>;
}

/**
 * HIGH_IMPACT_EVENT_EXPOSURE only (market-events phase 5) — a minimal
 * structural shape, not `market-events`'s own `UpcomingMarketEvent` type:
 * `rules` deliberately has no dependency on `market-events` (same "depends
 * on rules, never the reverse" layering RULE_ENGINE_SPEC.md already applies
 * to `alerts`) — only `alerts/rule-engine.service.ts`, which already
 * depends on both, imports the real type and passes plain objects shaped
 * like this one.
 */
export interface UpcomingHighImpactEvent {
  id: string;
  title: string;
  scheduledAt: Date;
  affectedCurrencies: string[];
}

/**
 * User's custom EURUSD trading rules (technical-analysis phase) — SUPPORT_
 * RESISTANCE_PROXIMITY only. A minimal structural shape, not `technical-
 * analysis`'s own `LevelProximityMatch` (same "rules has no dependency on
 * the module that computes this" reasoning as `UpcomingHighImpactEvent`
 * above) — already filtered to SUPPORT_RESISTANCE_PROXIMITY_POINTS.
 */
export interface SupportResistanceProximitySignal {
  timeframe: string;
  levelType: 'SUPPORT' | 'RESISTANCE';
  levelPrice: number;
  currentPrice: number;
  distancePoints: number;
  currentPriceIsAbove: boolean;
  /** Stage 3A addition — whether price is moving toward or away from this level; 'UNKNOWN' when there's no prior price to compare against. */
  trend: 'APPROACHING' | 'RETREATING' | 'FLAT' | 'UNKNOWN';
}

/** ICHIMOKU_BREAKOUT only — a minimal structural shape, same reasoning as above; already filtered to freshness (see ichimoku-breakout.evaluator.ts). */
export interface IchimokuBreakoutSignal {
  timeframe: string;
  direction: 'BULLISH' | 'BEARISH';
  previousState: string;
  newState: string;
  breakoutPrice: number;
  timestamp: string;
}

/** DAILY_MARKET_ANALYSIS only (Rules 3+4 combined) — a minimal structural shape, same reasoning as above. */
export interface DailyMarketAnalysisPayload {
  symbol: string;
  currentPrice: number;
  marketBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  biasConfidence: number;
  biasReasons: string[];
  fibonacci: {
    swingHigh: number;
    swingLow: number;
    direction: 'BULLISH' | 'BEARISH';
    levels: { ratio: number; price: number }[];
    nearestLevelRatio: number;
    nearestLevelPrice: number;
  } | null;
  supportResistance: { timeframe: string; levelType: 'SUPPORT' | 'RESISTANCE'; price: number }[];
  ichimoku: { timeframe: string; position: string; spanA: number | null; spanB: number | null }[];
  upcomingEconomicEvents: { title: string; scheduledAt: string; affectedCurrencies: string[] }[];
  recentNews: { title: string; scheduledAt: string; sentiment: string }[];
  timestamp: string;
}

/** Extra per-rule-type inputs an evaluator needs beyond (parameters, current, baseline). */
export interface EvaluatorExtras {
  /** TRADE_FREQUENCY_MULTIPLE only — RULE_ENGINE_SPEC.md §12.12 decision 2. */
  tradesInWindow?: number;
  /** HIGH_IMPACT_EVENT_EXPOSURE only — already filtered to the rule's own `minutes_before` lookahead window and HIGH impact. */
  upcomingHighImpactEvents?: UpcomingHighImpactEvent[];
  /** SUPPORT_RESISTANCE_PROXIMITY only. */
  supportResistanceMatches?: SupportResistanceProximitySignal[];
  /** ICHIMOKU_BREAKOUT only. */
  ichimokuBreakouts?: IchimokuBreakoutSignal[];
  /** DAILY_MARKET_ANALYSIS only. */
  dailyMarketAnalysis?: DailyMarketAnalysisPayload;
  /** Evaluation timestamp — every evaluator's own `now`, so no evaluator reaches for the wall clock itself and stays pure/deterministic in tests. */
  now?: Date;
}

/** What COMPOUND rules read instead of raw metrics (RULE_ENGINE_SPEC.md §2.6). */
export type ComponentStateMap = Map<string, RuleRunState>;
