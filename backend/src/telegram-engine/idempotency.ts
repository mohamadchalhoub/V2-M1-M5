/**
 * How a Telegram leg is recognised at the broker.
 *
 * Engine A can ask "is there an open position with my magic number?" and get
 * a meaningful answer, because each of its magic numbers holds at most one
 * position. Engine B cannot: several legs of one signal share
 * `TELEGRAM_MAGIC` by design, and that is the whole point of them being
 * independent positions.
 *
 * So each leg carries a short tag into the MT5 order comment, and that tag is
 * what recovery matches on. After a crash between legs, it is the difference
 * between "leg 2 of this signal is already live at the broker" and "there is
 * a Telegram position here and I cannot tell which leg it is" — the second of
 * which would either duplicate a leg or orphan one.
 *
 * ## Why it is short
 *
 * MT5 truncates order comments (31 characters is the safe assumption, and
 * some brokers rewrite them entirely). A UUID does not fit. The tag is
 * therefore a prefix plus 12 hex characters derived from the leg's identity —
 * 48 bits, against a population of at most a few thousand legs, where a
 * collision is not a rounding error but a leg mistaken for another. Kept
 * inside a comment that still says what it is, so a human reading the
 * terminal's trade list can see which system opened a position.
 *
 * ## The comment is evidence, not authority
 *
 * A broker that strips or rewrites comments makes the tag unreadable. That is
 * handled where it matters — recovery falls back to treating an unmatched
 * Telegram-magic position as UNRESOLVED and refusing to trade, rather than
 * guessing which leg it belongs to. The tag makes the good case precise; it
 * never makes the bad case silent.
 */
import { createHash } from 'node:crypto';

/** Kept in sync with the collector, which parses it back off the comment. */
export const TELEGRAM_COMMENT_PREFIX = 'TG';

/**
 * A stable tag for one leg of one signal.
 *
 * Derived from the signal id and the leg index rather than random, so the
 * same leg recomputes to the same tag after a restart — which is what lets a
 * recovering process match a position it opened before it died.
 */
export function legIdempotencyTag(signalId: string, legIndex: number): string {
  const digest = createHash('sha256').update(`${signalId}:${legIndex}`).digest('hex').slice(0, 12);
  return `${TELEGRAM_COMMENT_PREFIX}${digest}`;
}

/**
 * The MT5 order comment for a leg: the tag plus the leg number, which is what
 * a human reading the terminal needs and costs three characters.
 */
export function legOrderComment(tag: string, legIndex: number): string {
  return `${tag}-L${legIndex}`;
}

/** Recovers a tag from a broker comment, or null if the broker mangled it. */
export function tagFromComment(comment: string | null | undefined): string | null {
  if (typeof comment !== 'string') return null;
  const match = comment.match(new RegExp(`\\b(${TELEGRAM_COMMENT_PREFIX}[0-9a-f]{12})\\b`));
  return match ? match[1] : null;
}
