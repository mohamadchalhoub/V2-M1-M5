/**
 * Duplicate protection: a Telegram trade signal executes at most once, as one
 * signal group.
 *
 * Five distinct ways the same trade can arrive twice, and what stops each:
 *
 * | # | How it repeats                                   | Stopped by            |
 * |---|--------------------------------------------------|-----------------------|
 * | 1 | the same update delivered twice                  | source key, in DB     |
 * | 2 | replay after a reconnect                         | source key, in DB     |
 * | 3 | replay after an application restart              | source key, in DB     |
 * | 4 | Telegram re-sending an update it already sent    | source key, in DB     |
 * | 5 | the channel republishing the same effective trade| semantic key + window |
 *
 * The first four are one mechanism: `(channelId, messageId)` is the message's
 * identity, and it is checked against a DURABLE unique constraint rather than
 * an in-memory set. An in-memory guard would cover 1, 2 and 4 and fail
 * exactly on 3 — a restart mid-signal, which is when a duplicate is most
 * likely and least excusable.
 *
 * The fifth is different in kind: a genuinely new message, carrying a trade
 * already taken. It cannot be caught by identity, so it is caught by
 * CONTENT — direction, entry, stop and the full ordered target list — within
 * a bounded window. The window is what keeps the rule from refusing a real
 * re-entry at the same level hours later, which is a legitimate trade and not
 * a repost.
 *
 * Both keys are computed here and stored on the signal row, so the constraint
 * that enforces them lives in the database and a lost race resolves to one
 * winner rather than to two sets of positions.
 */
import { createHash } from 'node:crypto';
import { TELEGRAM_SPEC } from './spec';
import type { ParsedSignal } from './parser';

/**
 * The message's identity. Exact, and independent of content: an edited repost
 * of the same message id is still that message.
 */
export function sourceKey(channelId: string, messageId: string | number): string {
  return `${channelId}:${messageId}`;
}

/**
 * The TRADE's identity, independent of which message carried it.
 *
 * Prices are normalized to three decimals before hashing so that "4338" and
 * "4338.0" are the same trade — the channel is inconsistent about this and a
 * textual comparison would let a reformatted repost through.
 *
 * The target list is ordered and complete. A repost that adds a third take
 * profit is a DIFFERENT instruction — it asks for a third position — so it
 * must not collide with the two-leg original, and it does not.
 */
export function semanticKey(signal: ParsedSignal): string {
  const n = (v: number): string => v.toFixed(3);
  const canonical = [
    TELEGRAM_SPEC.symbol,
    signal.direction,
    n(signal.entry),
    n(signal.stopLoss),
    signal.takeProfits.map(n).join(','),
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export type DuplicateKind = 'EXACT_MESSAGE' | 'SEMANTIC_REPOST' | 'RESTATEMENT';

export interface DuplicateVerdict {
  readonly duplicate: boolean;
  readonly kind: DuplicateKind | null;
  readonly detail: string | null;
}

/**
 * The TRADE, ignoring its targets.
 *
 * Observed behaviour of the source channel, from a 100-message scan: it
 * publishes a signal and then republishes it within seconds, sometimes
 * identically and sometimes with the target list varied - one dollar moved,
 * or a second target added. Three of five bursts contained such a variant.
 *
 * Those are not the same trade by `semanticKey`, because a different target
 * list is a different fingerprint, so that check lets them through. They are
 * plainly the same instruction restated, and treating them as new signals
 * would open a second position from a repost.
 *
 * Direction, entry and stop are what identify the trade; the targets are how
 * it is being managed. So the restatement key deliberately drops them.
 *
 * The cost, stated plainly: the FIRST message of a burst wins. Where the
 * channel restates with an ADDED target, this engine trades the earlier,
 * narrower version rather than the later, richer one. That is the price of
 * acting inside sixty seconds instead of waiting to see whether a better
 * version arrives.
 */
export function restatementKey(signal: ParsedSignal): string {
  const n = (v: number): string => v.toFixed(3);
  const canonical = [TELEGRAM_SPEC.symbol, signal.direction, n(signal.entry), n(signal.stopLoss)].join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** A previously recorded signal, as the duplicate check needs to see it. */
export interface PriorSignal {
  readonly sourceKey: string;
  readonly semanticKey: string;
  /** Absent on rows written before restatement detection existed. */
  readonly restatementKey?: string | null;
  readonly publishedAtMs: number;
  /**
   * Whether the engine is currently holding the earlier signal's order (taken
   * and still open). Only then is a repost a duplicate — not yet taken,
   * cancelled, expired, refused, or closed at TP/SL means the same signal
   * published again is a new signal. Operator rule. Absent is treated as
   * live, the safe direction.
   */
  readonly live?: boolean;
}

/**
 * Decides whether an incoming signal repeats one already recorded.
 *
 * Takes the candidate priors rather than querying, so the rule is a pure
 * function and every branch is testable without a database. The caller
 * supplies the durable answer; this decides what it means.
 */
export function evaluateDuplicate(
  candidate: { sourceKey: string; semanticKey: string; restatementKey?: string | null; publishedAtMs: number },
  priors: readonly PriorSignal[],
): DuplicateVerdict {
  const sameMessage = priors.find((p) => p.sourceKey === candidate.sourceKey);
  if (sameMessage) {
    return {
      duplicate: true,
      kind: 'EXACT_MESSAGE',
      detail:
        `Message ${candidate.sourceKey} has already been recorded. Whether this is a redelivered update, a ` +
        'reconnect replay or a restart replay, it is the same message and produces no second order.',
    };
  }

  // Content-based matches only count against a prior that is still alive.
  // The exact-message check above deliberately does NOT get this relaxation:
  // the same message id arriving again is a replay of that message, never
  // the channel sending the signal again.
  const livePriors = priors.filter((p) => p.live !== false);

  const repost = livePriors.find(
    (p) =>
      p.semanticKey === candidate.semanticKey &&
      Math.abs(candidate.publishedAtMs - p.publishedAtMs) <= TELEGRAM_SPEC.semanticDuplicateWindowMs,
  );
  if (repost) {
    const minutes = Math.round(Math.abs(candidate.publishedAtMs - repost.publishedAtMs) / 60_000);
    return {
      duplicate: true,
      kind: 'SEMANTIC_REPOST',
      detail:
        `The same effective trade was published ${minutes} minute(s) ago under message ${repost.sourceKey}, ` +
        `within the ${TELEGRAM_SPEC.semanticDuplicateWindowMs / 60_000}-minute repost window, and that order is ` +
        'still active. The signal is recorded and consumed; no additional positions are opened.',
    };
  }

  // --- The same trade restated with a different target list. Checked after
  // the exact-content test so a genuine repost still reports as one.
  if (candidate.restatementKey) {
    const restated = livePriors.find(
      (p) =>
        p.restatementKey != null &&
        p.restatementKey === candidate.restatementKey &&
        Math.abs(candidate.publishedAtMs - p.publishedAtMs) <= TELEGRAM_SPEC.semanticDuplicateWindowMs,
    );
    if (restated) {
      const seconds = Math.round(Math.abs(candidate.publishedAtMs - restated.publishedAtMs) / 1000);
      return {
        duplicate: true,
        kind: 'RESTATEMENT',
        detail:
          `The same trade - same direction, same entry, same stop - was already published ${seconds}s ago under ` +
          `message ${restated.sourceKey}, with a different target list. The source channel restates its signals ` +
          'within seconds of posting them; a restatement is the same instruction, not a second trade. Recorded ' +
          'and consumed; no additional positions are opened.',
      };
    }
  }

  return { duplicate: false, kind: null, detail: null };
}
