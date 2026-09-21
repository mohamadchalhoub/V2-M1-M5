import { ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsUUID, Max, Min } from 'class-validator';

// RULE_ENGINE_SPEC.md §1 — one small, explicitly validated shape per
// rule_type, checked at rule-creation/update time (class-validator, same
// pattern as collector-ingress/dto/*), never a generic jsonb-anything column.

export class DailyLossLimitParamsDto {
  // Fraction (0-1), matching DRAWDOWN's own convention (ANALYTICS_SPEC.md §2.1).
  @IsNumber() @Min(0) @Max(1) threshold_pct!: number;
}

export class DrawdownParamsDto {
  @IsNumber() @Min(0) @Max(1) threshold_pct!: number;
}

export class ConsecutiveLossesParamsDto {
  @IsInt() @Min(1) count!: number;
}

export class PositionSizeMultipleParamsDto {
  @IsNumber() @Min(0) factor!: number;
  @IsIn(['avg', 'max']) baseline!: 'avg' | 'max';
}

export class TradeFrequencyMultipleParamsDto {
  @IsNumber() @Min(0) factor!: number;
  @IsInt() @Min(1) window_minutes!: number;
}

export class CompoundParamsDto {
  @IsIn(['AND', 'OR']) combinator!: 'AND' | 'OR';
  @IsArray() @ArrayMinSize(2) @IsUUID('4', { each: true }) component_rule_ids!: string[];
}

// Live-test production-readiness pass — professional trading-behavior rules,
// items C/E/F (margin utilization, no-stop-loss, concentration). Same
// per-type-shape convention as every rule above; no new architecture.

// Fires when margin_level (%) drops to/below the configured floor WHILE
// margin is actually in use — see margin-utilization.evaluator.ts for why
// margin=0 (no open positions) is deliberately never treated as "low."
export class MarginUtilizationParamsDto {
  @IsNumber() @Min(0) min_margin_level_pct!: number;
}

// Parameterless by design (RULE_ENGINE_SPEC.md §1 still gives every rule_type
// its own validated shape, even an empty one) — triggers whenever at least
// one open position has no stop loss set; see no-stop-loss.evaluator.ts.
export class NoStopLossParamsDto {}

// threshold_pct is a 0-1 fraction, same convention as DRAWDOWN/DAILY_LOSS_LIMIT.
// Checks symbol concentration and direction (all-BUY/all-SELL) concentration
// — NOT cross-instrument correlation (Phase 0 explicitly scoped that out
// unless already supported, and it isn't).
export class ConcentrationParamsDto {
  @IsNumber() @Min(0) @Max(1) threshold_pct!: number;
}

// Market intelligence, phase 5 — triggers when open-position volume in a
// currency affected by an upcoming HIGH-impact economic event (FRED,
// market-events module) exceeds `minimum_exposure_volume` within
// `minutes_before` minutes of that event's scheduled time. Both fields
// required (RULE_ENGINE_SPEC.md §1: every rule_type gets its own validated
// shape) — no implicit defaults for a threshold that materially changes
// when the rule fires.
export class HighImpactEventExposureParamsDto {
  @IsInt() @Min(1) minutes_before!: number;
  @IsNumber() @Min(0) minimum_exposure_volume!: number;
}

// User's custom EURUSD trading rules — technical-analysis phase. All three
// are parameterless by design, same precedent as NoStopLossParamsDto: the
// actual thresholds/timeframes/lookback windows are system-wide config
// (technical-analysis/technical-analysis.config.ts, env-driven per the
// user's own spec), not something that varies per rule instance — there is
// only ever one EURUSD market to analyze. A RuleDefinition row of one of
// these types means "this account wants this analysis," nothing more.

// Rule 1 — SUPPORT_RESISTANCE_PROXIMITY. Watches H1/H4/D1 (fixed by the
// user's own rule text, not configurable) for the current price entering
// SUPPORT_RESISTANCE_PROXIMITY_POINTS of a level.
export class SupportResistanceProximityParamsDto {}

// Rule 2 — ICHIMOKU_BREAKOUT. Watches ICHIMOKU_TIMEFRAMES (env-configurable)
// for a candle-close-confirmed cloud breakout.
export class IchimokuBreakoutParamsDto {}

// Rules 3+4 — DAILY_MARKET_ANALYSIS. The combined daily morning report
// (Fibonacci + market direction + S/R state + Ichimoku state + economic
// context), evaluated on DAILY_ANALYSIS_TIME/DAILY_ANALYSIS_TIMEZONE's own
// schedule, not the snapshot-driven trigger every other rule uses.
export class DailyMarketAnalysisParamsDto {}

export type DailyLossLimitParams = { threshold_pct: number };
export type DrawdownParams = { threshold_pct: number };
export type ConsecutiveLossesParams = { count: number };
export type PositionSizeMultipleParams = { factor: number; baseline: 'avg' | 'max' };
export type TradeFrequencyMultipleParams = { factor: number; window_minutes: number };
export type CompoundParams = { combinator: 'AND' | 'OR'; component_rule_ids: string[] };
export type MarginUtilizationParams = { min_margin_level_pct: number };
export type NoStopLossParams = Record<string, never>;
export type ConcentrationParams = { threshold_pct: number };
export type HighImpactEventExposureParams = { minutes_before: number; minimum_exposure_volume: number };
export type SupportResistanceProximityParams = Record<string, never>;
export type IchimokuBreakoutParams = Record<string, never>;
export type DailyMarketAnalysisParams = Record<string, never>;
