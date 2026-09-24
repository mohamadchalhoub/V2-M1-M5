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
 * The wide, catastrophic-only backstop stop-loss and take-profit distance
 * attached to every SAR order, in USD of gold price. NOT this strategy's
 * real exit mechanism — the $0.50 reversal is. This exists only because
 * `Executor.send_bracket_order` (the collector's send path) enforces this
 * codebase's own audited rule that no order is ever sent bare
 * (AUTONOMOUS_DEMO_TRADING_PLAN.md §1); see MIGRATION_AND_ROLLBACK.md for
 * the full discussion. Deliberately wide — 20x the reversal distance — so it
 * only matters if the reversal logic itself cannot run (process down,
 * disconnected) for long enough that price has moved this far unmanaged.
 */
export const SAR_CATASTROPHIC_STOP_USD = SPEC.reversalDistanceUsd * 20;

export function assertSarMagicIsDisjoint(otherOwnedMagics: readonly number[]): void {
  if (otherOwnedMagics.includes(SAR_MAGIC)) {
    throw new Error(
      `xauusd-sar magic ${SAR_MAGIC} collides with a magic number another strategy owns. Refusing to start: this ` +
        'must be caught at boot, not discovered when two strategies fight over one ticket.',
    );
  }
}
