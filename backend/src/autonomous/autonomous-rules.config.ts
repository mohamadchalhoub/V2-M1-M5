import { ConfigService } from '@nestjs/config';
import { CandleTimeframe } from '@prisma/client';

export const AUTONOMOUS_RULES_CONFIG = Symbol('AUTONOMOUS_RULES_CONFIG');

/**
 * The friend's EURUSD weekly H4 support/resistance rule
 * (AUTONOMOUS_DEMO_TRADING_PLAN.md, "THE TRADING STRATEGY"), expressed as
 * `.env` config rather than hardcoded constants — the plan's §2 commits to
 * this because the friend is expected to revise the rule over time, and a
 * config value survives that; a literal buried in an `if` doesn't. This
 * follows the same precedent `technical-analysis.config.ts` already set in
 * this codebase for its OTHER single-symbol, system-wide EURUSD rule.
 *
 * As of the friend's direct answers (see AUTONOMOUS_RULE_ENGINE_SPEC.md §2),
 * `takeProfitPoints`/`stopLossPoints`/`entryRetracePoints`/
 * `volatilityFilter*` are now the friend's actual stated numbers, not
 * guesses. `levelBreakOvershootPoints` and `confluenceTolerancePoints` are
 * still this project's own placeholder reconciliations — see spec §2 for
 * exactly which is which.
 */
export interface AutonomousRulesConfig {
  referenceTimeframe: CandleTimeframe;
  /** CONFIRMED by the friend directly (spec §2.1): 180 points, worked example given. */
  takeProfitPoints: number;
  /** CONFIRMED by the friend directly (spec §2.1). */
  stopLossPoints: number;
  /** CONFIRMED by the friend directly (spec §2.2): price must touch the level, then retrace this many points back before entering — replaces the old "within X points" proximity model entirely. */
  entryRetracePoints: number;
  /** PLACEHOLDER, this project's own reconciliation (spec §2.5) — how far PAST the level (beyond a touch) counts as the level having actually broken (friend's Rule 5: stop trading it, wait for the next opportunity), as opposed to just the normal overshoot before a retrace-confirmed bounce. */
  levelBreakOvershootPoints: number;
  /** CONFIRMED by the friend directly (spec §2.3): block all entries if price has moved this many points within the volatility filter window. */
  volatilityFilterMaxPoints: number;
  /** PLACEHOLDER — the friend said "1 or 2 hours"; 2 was picked as the more conservative reading (spec §2.3). */
  volatilityFilterWindowHours: number;
  /** PLACEHOLDER, this project's own reconciliation (spec §2.4) — how close the D1-timeframe level must be to the H4 level to count as confluence ("don't count on every support and resistance"). */
  confluenceTolerancePoints: number;
  /** The friend's own Rule 3, stated plainly in the source rules — not a placeholder. */
  maxOrdersPerDay: number;
}

const DEFAULT_REFERENCE_TIMEFRAME: CandleTimeframe = 'H4';
const DEFAULT_TAKE_PROFIT_POINTS = 180;
const DEFAULT_STOP_LOSS_POINTS = 180;
const DEFAULT_ENTRY_RETRACE_POINTS = 50;
const DEFAULT_LEVEL_BREAK_OVERSHOOT_POINTS = 50;
const DEFAULT_VOLATILITY_FILTER_MAX_POINTS = 500;
const DEFAULT_VOLATILITY_FILTER_WINDOW_HOURS = 2;
const DEFAULT_CONFLUENCE_TOLERANCE_POINTS = 50;
const DEFAULT_MAX_ORDERS_PER_DAY = 1;

export function loadAutonomousRulesConfig(config: ConfigService): AutonomousRulesConfig {
  const referenceTimeframe = (config.get<string>('AUTONOMOUS_REFERENCE_TIMEFRAME')?.trim() as CandleTimeframe) || DEFAULT_REFERENCE_TIMEFRAME;

  return {
    referenceTimeframe,
    takeProfitPoints: readPositiveNumber(config.get<string>('AUTONOMOUS_TAKE_PROFIT_POINTS'), DEFAULT_TAKE_PROFIT_POINTS, 'AUTONOMOUS_TAKE_PROFIT_POINTS'),
    stopLossPoints: readPositiveNumber(config.get<string>('AUTONOMOUS_STOP_LOSS_POINTS'), DEFAULT_STOP_LOSS_POINTS, 'AUTONOMOUS_STOP_LOSS_POINTS'),
    entryRetracePoints: readPositiveNumber(
      config.get<string>('AUTONOMOUS_ENTRY_RETRACE_POINTS'),
      DEFAULT_ENTRY_RETRACE_POINTS,
      'AUTONOMOUS_ENTRY_RETRACE_POINTS',
    ),
    levelBreakOvershootPoints: readPositiveNumber(
      config.get<string>('AUTONOMOUS_LEVEL_BREAK_OVERSHOOT_POINTS'),
      DEFAULT_LEVEL_BREAK_OVERSHOOT_POINTS,
      'AUTONOMOUS_LEVEL_BREAK_OVERSHOOT_POINTS',
    ),
    volatilityFilterMaxPoints: readPositiveNumber(
      config.get<string>('AUTONOMOUS_VOLATILITY_FILTER_MAX_POINTS'),
      DEFAULT_VOLATILITY_FILTER_MAX_POINTS,
      'AUTONOMOUS_VOLATILITY_FILTER_MAX_POINTS',
    ),
    volatilityFilterWindowHours: readPositiveNumber(
      config.get<string>('AUTONOMOUS_VOLATILITY_FILTER_WINDOW_HOURS'),
      DEFAULT_VOLATILITY_FILTER_WINDOW_HOURS,
      'AUTONOMOUS_VOLATILITY_FILTER_WINDOW_HOURS',
    ),
    confluenceTolerancePoints: readPositiveNumber(
      config.get<string>('AUTONOMOUS_CONFLUENCE_TOLERANCE_POINTS'),
      DEFAULT_CONFLUENCE_TOLERANCE_POINTS,
      'AUTONOMOUS_CONFLUENCE_TOLERANCE_POINTS',
    ),
    maxOrdersPerDay: readPositiveNumber(config.get<string>('AUTONOMOUS_MAX_ORDERS_PER_DAY'), DEFAULT_MAX_ORDERS_PER_DAY, 'AUTONOMOUS_MAX_ORDERS_PER_DAY'),
  };
}

function readPositiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return parsed;
}
