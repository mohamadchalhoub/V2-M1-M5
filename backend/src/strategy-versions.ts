/**
 * Every strategy identifier this codebase has run, in one place so none can
 * be typo'd differently in two files.
 *
 * Exactly ONE of these is enabled at a time. As of the migration to
 * `xauusd-m1-rsi-retest-extremes-v1`, that one is the RSI strategy; the other
 * two are retired. Retired means their code and historical rows are left
 * intact and interpretable, and only their ability to generate or submit an
 * entry has been removed.
 *
 * - `LEGACY_WEEKLY_H4_SR_STRATEGY_ID` — the friend's EURUSD weekly H4
 *   support/resistance rule (`backend/src/autonomous/`,
 *   `AUTONOMOUS_RULE_ENGINE_SPEC.md`). ARCHIVED as of this session: its
 *   code, tables, and historical decisions are left completely untouched
 *   (nothing here migrates or reinterprets them) so its backtest/live
 *   results stay interpretable exactly as they were reported. It is simply
 *   no longer the strategy under active development. Retroactively labeled
 *   here for reference in reports/docs — no historical row anywhere was
 *   ever tagged with this string (no such column existed on
 *   `AutonomousDecision`), so absence of the tag is what "belongs to the
 *   legacy strategy" means for anything from before this session.
 * - `TREND_BREAKOUT_STRATEGY_VERSION` — the new, deterministic H4-trend /
 *   H1-breakout / H1-ATR-exit strategy (`backend/src/trend-breakout/`).
 *   Every row this strategy ever writes (TrendBreakoutDecision, slot locks,
 *   volume/risk settings) is stamped with this exact string. A future
 *   revision of the rules gets a NEW versioned string (e.g.
 *   `h4-trend-h1-breakout-v2`) rather than an in-place semantic change to
 *   this one — so a historical decision row's own `strategyVersion` field
 *   always tells you exactly which rule set produced it, even after the
 *   rules themselves change again later.
 */
export const LEGACY_WEEKLY_H4_SR_STRATEGY_ID = 'weekly-h4-sr-v1';
export const TREND_BREAKOUT_STRATEGY_VERSION = 'h4-trend-h1-breakout-v1';

/**
 * The archived H4 confirmed-retest gold strategy. Retired by the same
 * migration; its open positions keep their original $10 protective distance
 * and their own identity until they resolve (see xauusd-rsi/ownership.ts).
 */
export const ARCHIVED_H4_CONFIRMED_RETEST_STRATEGY_VERSION = 'xauusd-h4-confirmed-retest-gold-live-v1';

/**
 * The single ENABLED entry strategy. Re-exported from the strategy's own
 * frozen spec rather than retyped, so the two can never drift: the spec file
 * is the authority, and its hash is what runtime state is validated against.
 */
export { XAUUSD_RSI_STRATEGY_VERSION as ACTIVE_STRATEGY_VERSION } from './xauusd-rsi/spec';
