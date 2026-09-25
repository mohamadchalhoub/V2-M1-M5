/**
 * Absolute, non-negotiable identity and safety bounds for `xauusd-sar-v1`.
 *
 * ONE new magic number, disjoint from every other strategy on this broker
 * account:
 *
 *   262610180  legacy EURUSD autonomous strategy
 *   262610181  H4 confirmed-retest gold (archived)
 *   262610190  xauusd-m1-rsi-retest-extremes-v1, RETEST slot
 *   262610191  xauusd-m1-rsi-retest-extremes-v1, EXTREME slot
 *   262610200  xauusd-m1-m5-rsi-threshold-v2, M1 path (frozen, historical)
 *   262610201  xauusd-m1-m5-rsi-threshold-v2, M5 path (frozen, historical)
 *   262610210  telegram-sfxauusd1-copy-v1 (Engine B)
 *   262610220  THIS strategy (xauusd-sar-v1)                <- new
 *
 * This strategy claims ONLY 262610220, and never adopts, relabels, closes or
 * modifies a position it did not open — including the still-frozen
 * 262610200/262610201 positions, which remain visible in trade history but
 * are never touched by this code.
 */
import { SPEC } from './spec';

export const SAR_SYMBOL = SPEC.symbol;

export const SAR_MAGIC = 262610220;

export const SAR_FOREIGN_MAGIC_NUMBERS: readonly number[] = [
  262610180, 262610181, 262610190, 262610191, 262610200, 262610201, 262610210,
];

/** Expected XAUUSD point size at this broker: verified against live SymbolMetadata, never assumed. */
export const SAR_EXPECTED_GOLD_POINT_SIZE = 0.01;

/**
 * Default order volume for a clean installation. Migration is required to
 * carry forward whatever Engine A's PREVIOUS live-configured volume actually
 * was (see the migration plan) rather than silently resetting to this.
 */
export const SAR_DEFAULT_VOLUME_LOTS = 0.5;

/** A quote older than this, at the moment it is read, is unusable. */
export const SAR_QUOTE_MAX_STALENESS_SECONDS = SPEC.observation.maxStalenessMs / 1000;

/** How far into the future a quote's own timestamp may be dated before it is refused. */
export const SAR_FUTURE_OBSERVATION_TOLERANCE_MS = SPEC.observation.maxFutureToleranceMs;

/** Target evaluation cadence — same class as Engine B's watchers, not raw ticks (see the design report). */
export const SAR_OBSERVATION_INTERVAL_MS = SPEC.observation.targetIntervalMs;

/** How long a submitted-but-unanswered reversal may stay UNKNOWN before it is its own incident. */
export const SAR_UNKNOWN_ESCALATION_SECONDS = 300;

/**
 * A fresh, COMPLETE, connected snapshot is authoritative on position
 * presence/absence the instant it arrives -- unlike a plain "is there a
 * matching deal yet" check, there is no propagation delay to wait out.
 * This only guards the rare race of a snapshot landing before the
 * just-submitted order has registered at the broker at all; it is not a
 * substitute for freshness (see SAR_RECONCILE_MAX_SNAPSHOT_AGE_SECONDS).
 */
export const SAR_RECONCILE_MIN_AGE_SECONDS = 10;

/**
 * Distinct, deliberately more generous grace period for an order attempt
 * the collector has NEVER claimed at all (`claimedAt === null`) -- "never
 * claimed" means the collector's own pending-order poll hasn't even tried
 * yet, which is a materially weaker signal than "claimed and the close
 * didn't complete." Confirmed production incident (2026-09-24): a
 * REVERSAL sat unclaimed while the collector's MT5 lock was held by
 * observation work, and reconciliation concluded FAILED using the same
 * 10s window meant for a CLAIMED attempt -- killing a reversal that had
 * never even had its first execution attempt. Sized comfortably above the
 * worst-case bounded lock-wait introduced in the collector's main loop
 * (see runner.py's MAIN_LOOP_LOCK_ACQUIRE_TIMEOUT_SECONDS) plus normal
 * poll-cadence jitter, without being an arbitrary/unrelated number: it is
 * a genuinely different question (has the collector even tried yet?)
 * from what SAR_RECONCILE_MIN_AGE_SECONDS answers (did a claimed attempt
 * round-trip in a reasonable time?).
 */
export const SAR_RECONCILE_UNCLAIMED_GRACE_SECONDS = 30;

/**
 * Observability threshold ONLY (2026-09-25 hardening pass) -- when a
 * REVERSAL attempt has sat unclaimed for at least this long, a single,
 * deduplicated "SAR REVERSAL EXECUTION DELAY" alert fires. Deliberately
 * lower than SAR_RECONCILE_UNCLAIMED_GRACE_SECONDS (30s): the alert exists
 * so an abnormal delay is visible well before reconciliation's own grace
 * period would otherwise conclude anything, without itself causing any
 * state change, cancellation, or new order. Never alters execution
 * timing -- purely a signal for a human to notice.
 */
export const SAR_UNCLAIMED_REVERSAL_ALERT_THRESHOLD_SECONDS = 10;

/** A snapshot older than this, relative to when it is read, is never used to resolve an UNKNOWN. */
export const SAR_RECONCILE_MAX_SNAPSHOT_AGE_SECONDS = 30;

/**
 * How long the NORMAL evaluator may go without assessing an active position
 * against a fresh quote before the watchdog treats it as stale and steps in
 * through the exact same atomic path.
 *
 * Derived from measured behavior, not chosen arbitrarily: the normal
 * cadence targets one evaluation per second (SPEC.observation.targetIntervalMs),
 * and post-fix (commit 8dc4298) production data shows decision-to-fill
 * latency clustering under 2s with rare jitter up to ~6.5s under ordinary
 * poll contention -- never the multi-minute stalls that caused the two live
 * incidents on 2026-09-24. 8 seconds sits comfortably above that observed
 * jitter ceiling (no false triggers on ordinary variance) while still being
 * a small fraction of how long a $10 catastrophic backstop takes to matter
 * -- both real incidents ran 7-24 MINUTES stale before this existed.
 */
export const SAR_WATCHDOG_STALE_THRESHOLD_MS = 8_000;

/**
 * REMOVED from new SAR orders (2026-09-25 strategy correction): this
 * strategy has no catastrophic/emergency broker-side bracket by design --
 * the $0.50 trailing reversal IS the complete exit mechanism, and a
 * profit-side "catastrophic" take-profit is not part of the specification
 * at all. A live incident (2026-09-24) proved this bracket is actively
 * harmful, not merely redundant: a BUY's $0.50 reversal was already due
 * (price had crossed the reversal level) but execution was delayed, and
 * the broker's own $10 take-profit closed the position first, via a path
 * the app-level reversal logic never controlled — an unintended broker
 * exit competing with the intended strategy, not a safety net.
 *
 * This constant is kept, unused by new order submission, ONLY because
 * historical `xauusd_sar_catastrophic_incidents` rows reference this
 * distance for audit purposes; it must never be reintroduced into
 * `execution.controller.ts`'s pending-order payload. See
 * `collector/app/executor.py`'s `send_market_order_no_bracket` for the
 * new SAR-only, no-bracket order path (every other strategy keeps using
 * `send_bracket_order` and its mandatory-SL/TP invariant unchanged).
 */
export const SAR_CATASTROPHIC_STOP_USD = SPEC.reversalDistanceUsd * 20;

/**
 * The broker order comment every SAR order is sent with -- the single
 * source of truth for this format, so the collector-facing controller (which
 * builds it) and reconciliation (which must match it back against a broker
 * deal) can never drift apart. They did: reconciliation used to compare a
 * deal's comment against the bare idempotency tag, which never matched
 * anything, because every actual order comment carries this prefix.
 */
export function sarOrderComment(idempotencyTag: string): string {
  return `sar-${idempotencyTag}`.slice(0, 26);
}

export function assertSarMagicIsDisjoint(otherOwnedMagics: readonly number[]): void {
  if (otherOwnedMagics.includes(SAR_MAGIC)) {
    throw new Error(
      `xauusd-sar magic ${SAR_MAGIC} collides with a magic number another strategy owns. Refusing to start: this ` +
        'must be caught at boot, not discovered when two strategies fight over one ticket.',
    );
  }
}
