/**
 * Absolute, non-negotiable safety bounds for
 * `xauusd-m1-rsi-retest-extremes-v1`.
 *
 * Compile-time constants, deliberately NOT `.env` config — the same posture
 * as the strategies this one replaces. A bound an operator could edit
 * without a code change and a spec re-freeze is not a bound.
 *
 * This is its OWN file rather than an extension of
 * `gold-execution/gold-safety-constants.ts`, for the reason that file gives
 * for itself: two strategies must never share a magic number or a volume
 * constant, so that a position can always be attributed to exactly one
 * owner and an accidental code-path reuse fails a magic-number check
 * loudly instead of operating on the wrong strategy's position.
 */
import { SPEC } from './spec';

export const RSI_SYMBOL = SPEC.symbol;

/**
 * XAUUSD price increment at this broker: 2 decimal digits, so one point is
 * $0.01. Same figure the previous gold module verified against broker
 * contract metadata; the live value is still validated per-order against
 * `SymbolMetadata` before submission, so this constant is the expectation,
 * never the authority.
 */
export const RSI_GOLD_POINT_SIZE = 0.01;

/**
 * USER RULE — TP and SL are each a $5.00 move in quoted gold price
 * (spec §7). Expressed in points for the broker hand-off.
 */
export const RSI_TP_USD = SPEC.brackets.takeProfitUsd;
export const RSI_SL_USD = SPEC.brackets.stopLossUsd;
export const RSI_TP_POINTS = RSI_TP_USD / RSI_GOLD_POINT_SIZE; // 500 points
export const RSI_SL_POINTS = RSI_SL_USD / RSI_GOLD_POINT_SIZE; // 500 points

/** Tolerance when re-verifying a candidate's bracket distances, in points. */
export const RSI_SL_TP_TOLERANCE_POINTS = 1;

/**
 * ONE MAGIC NUMBER PER RULE FAMILY.
 *
 * This is what makes an open broker position attributable to a specific
 * execution slot rather than merely to this strategy. With the two families
 * able to hold a position each at the same time, a single shared magic would
 * leave close requests, protection remediation, Friday liquidation and the
 * dashboard unable to say which slot a given ticket belongs to — and unable
 * to tell whether a family's slot is actually free.
 *
 * Both are clear of every number any previous strategy used: 262610180 was
 * the legacy EURUSD autonomous strategy and 262610181 the H4 confirmed-retest
 * gold strategy, while trend-breakout allocated its own from instrument
 * config. This strategy claims ONLY these two, and never adopts or relabels a
 * position it did not open.
 */
export const RSI_MAGIC_RETEST = 262610190;
export const RSI_MAGIC_EXTREME = 262610191;

/** Every magic number this strategy owns, for ownership and occupancy checks. */
export const RSI_MAGIC_NUMBERS: readonly number[] = [RSI_MAGIC_RETEST, RSI_MAGIC_EXTREME];

export function rsiMagicForFamily(family: 'RETEST' | 'EXTREME'): number {
  return family === 'RETEST' ? RSI_MAGIC_RETEST : RSI_MAGIC_EXTREME;
}

export function rsiFamilyForMagic(magic: number | null | undefined): 'RETEST' | 'EXTREME' | null {
  if (magic === RSI_MAGIC_RETEST) return 'RETEST';
  if (magic === RSI_MAGIC_EXTREME) return 'EXTREME';
  return null;
}

/**
 * USER RULE (spec §10) — "Keep the current valid configured volume. Default
 * to 0.5 lot if no valid explicit setting exists." This is the fallback
 * only; the live value comes from the runtime settings service and is
 * validated against real broker min/max/step before every submission.
 * Never auto-resized to make an order acceptable.
 */
export const RSI_DEFAULT_VOLUME_LOTS = 0.5;

/**
 * Max drift, in gold points, between the price a signal was formed at and
 * the executable price at send time. 100 points = $1.00, 20% of the $5
 * stop distance. Tighter than the previous strategy's 200pt because this
 * strategy's stop is half as wide: the guard is scaled to the bracket it
 * protects, not carried over unchanged. Beyond this the entry is skipped,
 * never chased.
 */
export const RSI_MAX_ENTRY_DEVIATION_POINTS = 100;

/**
 * Max age, in seconds, between the observation that produced a signal and
 * the moment it is actually submitted. This strategy is intrabar and M1;
 * a signal that has sat for more than a minute is no longer the event the
 * rules described, so it is dropped rather than submitted late.
 */
export const RSI_MAX_SIGNAL_AGE_SECONDS = 60;

/**
 * A quote older than this, measured against the moment it is read, is not
 * usable for entry detection or submission.
 */
export const RSI_QUOTE_MAX_STALENESS_SECONDS = SPEC.observation.maxStalenessMs / 1000;

/**
 * How far into the future an observation may be dated before it is refused.
 *
 * Freshness must be bounded on both sides. `age <= limit` accepts every
 * negative age, so without this a future-dated observation passes
 * unconditionally — and that blind spot was live: while stored tick
 * timestamps carried the broker's wall clock, every observation was three
 * hours ahead and the staleness test could never reject anything.
 *
 * The tolerance covers ordinary clock skew between this machine and the
 * broker. Beyond it, a negative age is a wrong conversion, not a very fresh
 * quote. It deliberately matches the collector's own
 * QUOTE_FUTURE_TOLERANCE_SECONDS so both ends of the pipeline agree.
 */
export const RSI_FUTURE_OBSERVATION_TOLERANCE_MS = 2_000;

/**
 * How far ahead of wall clock a PERSISTED engine clock may sit before the
 * indicator is rebuilt from history.
 *
 * Much larger than the per-observation tolerance, because this is about a
 * state file being wrong rather than a quote being early: an engine a few
 * seconds ahead is ordinary, one minutes ahead cannot be right. A future
 * engine clock rejects every incoming observation as out-of-order and
 * freezes RSI while the loop still reports a healthy cadence, so it must
 * self-heal rather than wait for someone to notice.
 */
export const RSI_ENGINE_CLOCK_FUTURE_LIMIT_MS = 120_000;

/**
 * Target observation cadence: read XAUUSD and evaluate once per second.
 *
 * Both halves matter. A one-second collector feeding a sixty-second evaluator
 * would satisfy neither the letter nor the point of the requirement, so the
 * collector's dedicated XAUUSD loop and the strategy's own watch loop are
 * both driven at this interval.
 */
export const RSI_OBSERVATION_INTERVAL_MS = 1_000;

/**
 * How far behind the target cadence the measured interval may drift before
 * the dashboard reports the cadence as degraded rather than as met. Generous
 * enough to absorb ordinary scheduling jitter on a desktop machine, tight
 * enough that a genuinely stalled loop is visible.
 */
export const RSI_OBSERVATION_CADENCE_TOLERANCE_MS = 2_000;

/**
 * Risk caps. Carried over UNWEAKENED from the strategy this one replaces
 * (spec §10 — "Do not increase volume, weaken caps"). Percentages of live,
 * real-queried account equity.
 */
export const RSI_STOP_RISK_CAP_PCT = 0.5;
export const RSI_COMBINED_RISK_CAP_PCT = 1;
export const RSI_DAILY_LOSS_CAP_PCT = 2;
export const RSI_DRAWDOWN_CAP_PCT = 5;

/**
 * Friday liquidation: how long a single close/cancel attempt may remain
 * unconfirmed before the worker re-queries broker state rather than
 * assuming the earlier request worked. Bounded retry, never unbounded.
 */
export const RSI_LIQUIDATION_ATTEMPT_TIMEOUT_SECONDS = 30;

/** Maximum liquidation attempts per owned item before it is escalated as a critical incident. */
export const RSI_LIQUIDATION_MAX_ATTEMPTS = 8;
