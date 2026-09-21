/**
 * Absolute, non-negotiable safety bounds for
 * `xauusd-m1-m5-rsi-threshold-v2`.
 *
 * Compile-time constants, deliberately NOT `.env` config — the same posture
 * as the strategies this one sits alongside. A bound an operator could edit
 * without a code change and a spec re-freeze is not a bound.
 *
 * This is its OWN file rather than an extension of the previous strategy's
 * `xauusd-rsi/safety-constants.ts`, for the reason that file gives for
 * itself: two strategies must never share a magic number or a volume
 * constant, so that a position can always be attributed to exactly one owner
 * and an accidental code-path reuse fails a magic-number check loudly
 * instead of operating on the wrong strategy's position.
 *
 * That matters more here than it ever has before, because the strategy this
 * one is copied from is STILL RUNNING, on its own account, from its own
 * deployment. Nothing in this file may collide with it.
 */
import { SPEC, type Direction, type Timeframe } from './spec';

export const V2_SYMBOL = SPEC.symbol;

/**
 * XAUUSD price increment at this broker: 2 decimal digits, so one point is
 * $0.01. This constant is the EXPECTATION, never the authority — §7 requires
 * the live value to be verified from broker `SymbolMetadata` before every
 * submission rather than assuming every broker uses the same decimal
 * representation.
 */
export const V2_EXPECTED_GOLD_POINT_SIZE = 0.01;

/** USER RULE §7 — TP and SL are each a $5.00 move in quoted gold price. */
export const V2_TP_USD = SPEC.brackets.takeProfitUsd;
export const V2_SL_USD = SPEC.brackets.stopLossUsd;

/** Tolerance when re-verifying a candidate's bracket distances, in points. */
export const V2_SL_TP_TOLERANCE_POINTS = 1;

/**
 * ONE MAGIC NUMBER PER TIMEFRAME.
 *
 * This is what makes an open broker position attributable to a specific
 * execution path rather than merely to this strategy. With M1 and M5 each
 * able to hold a position at the same time, a single shared magic would
 * leave close requests, protection remediation, Friday liquidation and the
 * dashboard unable to say which timeframe a given ticket belongs to — and
 * unable to tell whether a timeframe's slot is actually free. §4 requires
 * that closing or remediating M1 never targets M5.
 *
 * Both numbers are clear of every number any other strategy on this broker
 * account uses, INCLUDING the still-running M1 revision-5 bot:
 *
 *   262610180  legacy EURUSD autonomous strategy
 *   262610181  H4 confirmed-retest gold (archived)
 *   262610190  xauusd-m1-rsi-retest-extremes-v1, RETEST slot   <- still live
 *   262610191  xauusd-m1-rsi-retest-extremes-v1, EXTREME slot  <- still live
 *   262610200  THIS strategy, M1 path
 *   262610201  THIS strategy, M5 path
 *
 * This strategy claims ONLY 262610200 and 262610201, and never adopts,
 * relabels, closes or modifies a position it did not open (§1, §4, §9.3).
 */
export const V2_MAGIC_M1 = 262610200;
export const V2_MAGIC_M5 = 262610201;

/** Every magic number this strategy owns, for ownership and occupancy checks. */
export const V2_MAGIC_NUMBERS: readonly number[] = [V2_MAGIC_M1, V2_MAGIC_M5];

/**
 * Magic numbers known to belong to OTHER systems on this broker account.
 *
 * Listed so that a collision is caught at startup by an explicit assertion
 * rather than discovered when two strategies fight over one ticket. This is
 * a denylist for self-checking, never a list of things this strategy may
 * touch — everything here is foreign and is never closed or modified.
 */
export const V2_FOREIGN_MAGIC_NUMBERS: readonly number[] = [262610180, 262610181, 262610190, 262610191];

export function v2MagicForTimeframe(timeframe: Timeframe): number {
  return timeframe === 'M1' ? V2_MAGIC_M1 : V2_MAGIC_M5;
}

export function v2TimeframeForMagic(magic: number | null | undefined): Timeframe | null {
  if (magic === V2_MAGIC_M1) return 'M1';
  if (magic === V2_MAGIC_M5) return 'M5';
  return null;
}

/**
 * USER RULE §7 — "Default V2 volume: 0.5 lot."
 *
 * This is the DEFAULT for a clean V2 installation, not an inherited
 * production setting: §7 explicitly forbids blindly inheriting an unrelated
 * production volume. The live value comes from V2's own runtime settings
 * with an audit trail, and is validated against real broker min/max/step
 * before every submission. Never auto-resized to make an order acceptable.
 */
export const V2_DEFAULT_VOLUME_LOTS = 0.5;

/**
 * Max drift, in gold points, between the price a signal was formed at and
 * the executable price at send time. 100 points = $1.00, 20% of the $5 stop
 * distance. Beyond this the entry is skipped, never chased (§7).
 */
export const V2_MAX_ENTRY_DEVIATION_POINTS = 100;

/**
 * Max age, in seconds, between the observation that produced a signal and
 * the moment it is actually submitted. This strategy is intrabar; a signal
 * that has sat for more than a minute is no longer the event the rules
 * described, so it is dropped rather than submitted late (§7).
 */
export const V2_MAX_SIGNAL_AGE_SECONDS = 60;

/** A quote older than this, at the moment it is read, is unusable (§7). */
export const V2_QUOTE_MAX_STALENESS_SECONDS = SPEC.observation.maxStalenessMs / 1000;

/**
 * How far into the future an observation may be dated before it is refused.
 *
 * Freshness must be bounded on both sides. `age <= limit` accepts every
 * negative age, so without this a future-dated observation passes
 * unconditionally. The tolerance covers ordinary clock skew between this
 * machine and the broker; beyond it, a negative age is a wrong conversion,
 * not a very fresh quote (§7 — 2 seconds).
 */
export const V2_FUTURE_OBSERVATION_TOLERANCE_MS = 2_000;

/**
 * How far ahead of wall clock a PERSISTED engine clock may sit before that
 * timeframe's indicator is rebuilt from history. Much larger than the
 * per-observation tolerance, because this is about a state file being wrong
 * rather than a quote being early: a future engine clock rejects every
 * incoming observation as out-of-order and freezes RSI while the loop still
 * reports a healthy cadence, so it must self-heal.
 */
export const V2_ENGINE_CLOCK_FUTURE_LIMIT_MS = 120_000;

/** USER RULE §10 — read and evaluate once per second, on both timeframes. */
export const V2_OBSERVATION_INTERVAL_MS = SPEC.observation.targetIntervalMs;

/**
 * How far behind the target cadence the measured interval may drift before
 * the dashboard reports the cadence as degraded rather than as met.
 *
 * §3 of the operator brief is explicit that a one-second OBSERVATION loop
 * does not imply a one-second order-POLLING loop, so the two are measured
 * and reported separately; this tolerance applies to observation.
 */
export const V2_OBSERVATION_CADENCE_TOLERANCE_MS = 2_000;

/**
 * Risk caps. Carried over UNWEAKENED (§7). Percentages of live, real-queried
 * account equity. Combined risk spans BOTH timeframes and includes risk
 * already reserved but not yet filled.
 */
export const V2_STOP_RISK_CAP_PCT = 0.5;
export const V2_COMBINED_RISK_CAP_PCT = 1;
export const V2_DAILY_LOSS_CAP_PCT = 2;
export const V2_DRAWDOWN_CAP_PCT = 5;

/**
 * Friday liquidation: how long a single close/cancel attempt may remain
 * unconfirmed before the worker re-queries broker state rather than assuming
 * the earlier request worked. Bounded retry, never unbounded (§9.3).
 */
export const V2_LIQUIDATION_ATTEMPT_TIMEOUT_SECONDS = 30;

/** Maximum liquidation attempts per owned item before critical escalation. */
export const V2_LIQUIDATION_MAX_ATTEMPTS = 8;

/** Stable key for a timeframe+direction pair, used by locks and reporting. */
export function directionalKey(timeframe: Timeframe, direction: Direction): string {
  return `${timeframe}:${direction}`;
}
