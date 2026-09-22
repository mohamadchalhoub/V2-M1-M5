/**
 * The gate that decides whether a Telegram message is allowed anywhere near
 * the trading pipeline.
 *
 * ## Why the username is not enough
 *
 * `@SFxauusd1` is a label the channel's owner can change, that another
 * channel can later claim, and that arrives on an update as text this process
 * did not verify. The authoritative identity is the numeric peer id, resolved
 * ONCE against Telegram at authentication time and then compared on every
 * single message.
 *
 * Everything else the authenticated account can see — private chats, groups,
 * Saved Messages, the notification bot's own conversation, every other
 * channel it happens to be subscribed to — is a source of text that looks
 * exactly like a trade signal if someone wants it to. The account is a normal
 * user account and anybody can message it. So the rule is an allowlist of
 * exactly one id, and the default for everything else is refusal, not
 * inspection.
 *
 * This is deliberately a pure function over already-extracted fields, so the
 * decision can be tested exhaustively without a Telegram connection, and so
 * the adapter cannot accidentally grow a second, laxer path to the parser.
 */

export type ChannelVerdict =
  | 'ACCEPTED'
  | 'WRONG_CHANNEL'
  | 'NOT_A_CHANNEL'
  | 'SOURCE_NOT_CONFIGURED';

export interface ChannelCheck {
  readonly verdict: ChannelVerdict;
  readonly accepted: boolean;
  readonly detail: string;
}

export interface IncomingPeer {
  /** The numeric peer id as the transport reports it, normalised to a string. */
  readonly channelId: string | null;
  /** Username without '@', when the transport supplies one. Never trusted alone. */
  readonly username: string | null;
  /** True when the message came from a broadcast channel rather than a chat. */
  readonly isChannel: boolean;
}

/**
 * @param configuredChannelId the id resolved at authentication. Absent means
 *   ingestion is not configured, and NOTHING is accepted — an unconfigured
 *   source must never fall back to matching on username text.
 */
export function checkSourceChannel(peer: IncomingPeer, configuredChannelId: string | null): ChannelCheck {
  const refuse = (verdict: ChannelVerdict, detail: string): ChannelCheck => ({
    verdict,
    accepted: false,
    detail,
  });

  if (!configuredChannelId) {
    return refuse(
      'SOURCE_NOT_CONFIGURED',
      'No source channel id has been resolved. Ingestion accepts nothing until authentication has resolved the ' +
        'channel, because matching on username text alone is exactly the check this exists to replace.',
    );
  }
  if (!peer.isChannel) {
    return refuse(
      'NOT_A_CHANNEL',
      'The message did not come from a broadcast channel. Private chats, groups and Saved Messages never enter ' +
        'the trading pipeline: this account is reachable by anyone, and a direct message is not a signal.',
    );
  }
  if (peer.channelId === null) {
    return refuse(
      'WRONG_CHANNEL',
      'The update carried no resolvable channel id, so it cannot be shown to come from the source. Refused.',
    );
  }
  if (normaliseChannelId(peer.channelId) !== normaliseChannelId(configuredChannelId)) {
    return refuse(
      'WRONG_CHANNEL',
      `Message came from channel ${peer.channelId}` +
        (peer.username ? ` (@${peer.username})` : '') +
        `, not the configured source ${configuredChannelId}.`,
    );
  }
  return {
    verdict: 'ACCEPTED',
    accepted: true,
    detail: `Message is from the configured source channel ${configuredChannelId}.`,
  };
}

/**
 * Normalises the several shapes Telegram's own id conventions produce for one
 * channel.
 *
 * MTProto reports a bare channel id (`1234567890`) while the Bot API and most
 * human-facing tooling use the `-100`-prefixed form (`-1001234567890`). They
 * denote the same channel, and an operator copying an id from either place
 * must not silently end up with a guard that never matches — which would fail
 * safe (nothing trades) but would look like the channel had gone quiet.
 */
export function normaliseChannelId(raw: string): string {
  const trimmed = raw.trim();
  const withoutPrefix = trimmed.startsWith('-100') ? trimmed.slice(4) : trimmed.replace(/^-/, '');
  return withoutPrefix;
}

/** The `-100` form, for display and for operator instructions. */
export function displayChannelId(raw: string): string {
  return `-100${normaliseChannelId(raw)}`;
}
