/**
 * The hard publication-to-submission lifetime (`TELEGRAM_SPEC.maxSignalAgeMs`
 * — currently 1 hour, raised by explicit operator instruction from an
 * earlier 60 seconds), which is Engine B's ONLY strategy-level timing rule.
 *
 * Three properties make it what the specification asks for rather than an
 * approximation of it:
 *
 * 1. **Measured from publication, not receipt.** A message delayed in
 *    delivery, or replayed after a reconnect, is old however recently this
 *    process first saw it. Using receipt time would make every replayed
 *    message look brand new, which is precisely the failure the lifetime
 *    exists to prevent.
 * 2. **Re-evaluated per leg, immediately before that leg is submitted.** A
 *    two-leg signal is two broker round trips; the second can easily land
 *    seconds after the first. Checking once for the signal would submit a leg
 *    just past the deadline on the strength of a check that passed earlier.
 * 3. **Expiry is terminal.** An expired signal is consumed, never queued and
 *    never retried. There is no state in which a signal waits for something.
 *
 * Both bounds are enforced. `age <= limit` alone accepts every negative age,
 * so a message dated in the future would pass forever; beyond a small skew
 * tolerance a negative age means a wrong clock, not a very fresh signal.
 */
import { TELEGRAM_SPEC } from './spec';

export type FreshnessVerdict = 'FRESH' | 'EXPIRED' | 'PUBLICATION_IN_FUTURE';

export interface FreshnessResult {
  readonly verdict: FreshnessVerdict;
  readonly fresh: boolean;
  readonly ageMs: number;
  readonly detail: string;
}

/**
 * @param publishedAtMs the ORIGINAL Telegram publication instant, UTC ms.
 * @param atMs the instant being judged — for a leg, the instant immediately
 *   before it is handed to the broker.
 */
export function evaluateFreshness(publishedAtMs: number, atMs: number): FreshnessResult {
  const ageMs = atMs - publishedAtMs;

  if (ageMs < -TELEGRAM_SPEC.futurePublicationToleranceMs) {
    return {
      verdict: 'PUBLICATION_IN_FUTURE',
      fresh: false,
      ageMs,
      detail:
        `The message is dated ${Math.abs(Math.round(ageMs / 1000))}s in the future, beyond the ` +
        `${TELEGRAM_SPEC.futurePublicationToleranceMs / 1000}s clock-skew tolerance. That is a wrong clock or a ` +
        'wrong conversion, not a fresh signal, and it is refused rather than trusted.',
    };
  }
  if (ageMs > TELEGRAM_SPEC.maxSignalAgeMs) {
    return {
      verdict: 'EXPIRED',
      fresh: false,
      ageMs,
      detail:
        `The signal is ${(ageMs / 1000).toFixed(1)}s old, past its hard ` +
        `${TELEGRAM_SPEC.maxSignalAgeMs / 1000}s lifetime. It is consumed permanently: never queued, never ` +
        'retried, and never executed later.',
    };
  }
  return {
    verdict: 'FRESH',
    fresh: true,
    ageMs,
    detail: `Signal is ${(ageMs / 1000).toFixed(1)}s old, within its ${TELEGRAM_SPEC.maxSignalAgeMs / 1000}s lifetime.`,
  };
}

/**
 * The per-leg gate, called immediately before each individual submission.
 *
 * Deliberately a separate named function from `evaluateFreshness` despite
 * being a thin wrapper: call sites read as the rule they are enforcing, and
 * the one place where forgetting to re-check would be invisible is the leg
 * loop.
 */
export function legMayBeSubmitted(publishedAtMs: number, submissionAtMs: number): FreshnessResult {
  return evaluateFreshness(publishedAtMs, submissionAtMs);
}
