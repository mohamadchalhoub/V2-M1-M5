/**
 * Who receives gold/RSI notifications, parsed from validated configuration.
 *
 * Two environment variables feed this, and both are read so that adding a
 * recipient never silently removes the existing one:
 *
 *   GOLD_TELEGRAM_CHAT_ID   the owner's original single destination
 *   GOLD_TELEGRAM_CHAT_IDS  additional destinations, comma separated, each
 *                           either `id` or `Label:id`
 *
 * Duplicates across the two are collapsed by chat id, so listing the owner in
 * both does not produce two copies of every message.
 *
 * Nothing here contains a chat id or a token as a literal. Recipients are
 * configuration, not code, which is what keeps them out of the repository.
 */

export interface TelegramRecipient {
  /** The Telegram chat id, exactly as configured. Never rewritten or guessed. */
  chatId: string;
  /** Human label for audit records and operator-facing output. */
  label: string;
  /** Which variable this recipient came from, for diagnosing a misconfiguration. */
  source: 'GOLD_TELEGRAM_CHAT_ID' | 'GOLD_TELEGRAM_CHAT_IDS';
}

export interface RecipientParseResult {
  recipients: TelegramRecipient[];
  /** Entries that could not be used, with the reason. Never silently dropped. */
  problems: string[];
}

/**
 * A Telegram chat id is an integer, optionally negative for groups and
 * channels. Anything else is a configuration error and is reported rather
 * than passed to the API, because a malformed id would otherwise surface as
 * an opaque 400 at send time.
 */
const CHAT_ID_PATTERN = /^-?\d+$/;

export function parseRecipients(env: {
  GOLD_TELEGRAM_CHAT_ID?: string | null;
  GOLD_TELEGRAM_CHAT_IDS?: string | null;
}): RecipientParseResult {
  const recipients: TelegramRecipient[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  const add = (rawLabel: string, rawId: string, source: TelegramRecipient['source']) => {
    const chatId = rawId.trim();
    if (!chatId) return;
    if (!CHAT_ID_PATTERN.test(chatId)) {
      problems.push(`${source}: "${chatId}" is not a valid Telegram chat id (expected an integer) — skipped.`);
      return;
    }
    if (seen.has(chatId)) return; // already configured elsewhere; one copy only
    seen.add(chatId);
    recipients.push({ chatId, label: rawLabel.trim() || `chat ${chatId}`, source });
  };

  const single = (env.GOLD_TELEGRAM_CHAT_ID ?? '').trim();
  if (single) add('Owner', single, 'GOLD_TELEGRAM_CHAT_ID');

  const list = (env.GOLD_TELEGRAM_CHAT_IDS ?? '').trim();
  if (list) {
    for (const entry of list.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      // `Label:id` — split on the LAST colon so a label may contain one.
      const idx = trimmed.lastIndexOf(':');
      if (idx > 0) {
        add(trimmed.slice(0, idx), trimmed.slice(idx + 1), 'GOLD_TELEGRAM_CHAT_IDS');
      } else {
        add('', trimmed, 'GOLD_TELEGRAM_CHAT_IDS');
      }
    }
  }

  return { recipients, problems };
}

/**
 * Per-recipient deduplication key.
 *
 * The caller supplies one logical key per EVENT; the destination is appended
 * here. That is what lets a retry re-send only the recipient that failed
 * without duplicating one that already succeeded, and stops one recipient's
 * success from hiding another's failure.
 */
export function recipientDedupKey(eventDedupKey: string, chatId: string): string {
  return `${eventDedupKey}#chat:${chatId}`;
}
