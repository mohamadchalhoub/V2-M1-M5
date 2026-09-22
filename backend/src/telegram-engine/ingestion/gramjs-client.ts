/**
 * The production Telegram transport: GramJS (`telegram` on npm), an MTProto
 * client speaking Telegram's own protocol as a USER.
 *
 * ## Why a user session and not the notification bot
 *
 * A bot cannot read a public channel it does not administer. Telegram gives
 * bots messages from chats they are a member of with privacy mode off, or
 * from channels where they are an admin — and we administer neither
 * `@SFxauusd1` nor anything it posts to. A user account reading a public
 * channel is the only mechanism that works, which is why this needs an
 * MTProto login rather than a bot token.
 *
 * The existing notification bot is deliberately untouched: it sends V2's
 * alerts outbound and has no business holding a user authorization, and
 * mixing the two would put an account credential into the code path that
 * formats trade alerts.
 *
 * ## Why GramJS over TDLib
 *
 * `tdl`/TDLib is the other mature option and is excellent, but it is a native
 * C++ library: it needs a compiled binary matched to the image's libc, which
 * turns a one-line dependency into a build stage in a Dockerfile that
 * currently has none, and makes the backend image architecture-specific.
 * GramJS is pure TypeScript, installs as an ordinary dependency, ships its
 * own types, implements the update loop, reconnection and session
 * serialisation, and runs unchanged in the existing `node:20-alpine` image.
 * For one process subscribed to one public channel, TDLib's advantages —
 * local message database, multi-account, heavy media — are not advantages we
 * would use, and its cost is real.
 *
 * ## What this file does and does not do
 *
 * It owns the connection and nothing else. It does not parse, does not
 * decide, does not touch the database: it turns Telegram updates into
 * `TelegramSourceMessage` values and hands them on. That boundary is what
 * lets every rule downstream be tested with a hand-written object and a fake
 * clock, and it is why the channel guard is applied here at the edge rather
 * than trusted to a later stage.
 */
import { Logger } from '@nestjs/common';
import { Api, TelegramClient } from 'telegram';
import { NewMessage, type NewMessageEvent } from 'telegram/events';
import { EditedMessage, type EditedMessageEvent } from 'telegram/events/EditedMessage';
import { StringSession } from 'telegram/sessions';
import type { TelegramIngestionPort, TelegramSourceMessage } from '../ingestion.port';
import { checkSourceChannel, normaliseChannelId, type IncomingPeer } from './channel-guard';
import { readStoredSession } from './session-store';

export interface GramJsConfig {
  readonly apiId: number;
  readonly apiHash: string;
  readonly session: string;
  /** The resolved numeric id. Username text is never the authority. */
  readonly sourceChannelId: string | null;
  readonly sourceChannelUsername: string;
}

/** An edit of a message already seen, kept distinct from a new publication. */
export interface TelegramEditEvent {
  readonly message: TelegramSourceMessage;
  readonly editedAtMs: number | null;
}

export class GramJsIngestionAdapter implements TelegramIngestionPort {
  private readonly logger = new Logger(GramJsIngestionAdapter.name);
  private client: TelegramClient | null = null;
  private handler: ((message: TelegramSourceMessage) => Promise<void>) | null = null;
  private editHandler: ((event: TelegramEditEvent) => Promise<void>) | null = null;

  private lastUpdateAtMs: number | null = null;
  private lastSourceMessageAtMs: number | null = null;
  private lastSourceMessageId: string | null = null;
  private lastIngestionLatencyMs: number | null = null;
  private connected = false;

  constructor(private readonly config: GramJsConfig) {}

  onMessage(handler: (message: TelegramSourceMessage) => Promise<void>): void {
    this.handler = handler;
  }

  onEdit(handler: (event: TelegramEditEvent) => Promise<void>): void {
    this.editHandler = handler;
  }

  async start(): Promise<void> {
    if (this.client) return;

    const client = new TelegramClient(new StringSession(this.config.session), this.config.apiId, this.config.apiHash, {
      // GramJS reconnects on its own; these bound how long a silent
      // connection is tolerated before it does. A channel can genuinely be
      // quiet for hours, so liveness is judged by the connection rather than
      // by message arrival — a shorter retry here would reconnect constantly
      // on a quiet weekend for no reason.
      connectionRetries: Number.MAX_SAFE_INTEGER,
      retryDelay: 2_000,
      autoReconnect: true,
      // Telegram is the clock for signal age, so its time must not drift from
      // ours silently. GramJS tracks server time itself; this just keeps the
      // update loop from sitting on a dead socket.
      timeout: 20_000,
    });

    // Never logged at info: GramJS's own logger is chatty and prints request
    // payloads at debug, which for an MTProto client includes session-adjacent
    // material.
    client.setLogLevel('error' as never);

    await client.connect();
    const authorized = await client.isUserAuthorized();
    if (!authorized) {
      await client.disconnect();
      throw new Error(
        'The stored Telegram session is not authorized. Run `deploy/m1m5.sh telegram-auth` to sign in again.',
      );
    }

    client.addEventHandler((event: NewMessageEvent) => {
      void this.dispatch(event, false);
    }, new NewMessage({}));

    client.addEventHandler((event: EditedMessageEvent) => {
      void this.dispatch(event, true);
    }, new EditedMessage({}));

    this.client = client;
    this.connected = true;
    this.logger.log(
      `Telegram ingestion connected; watching channel ${this.config.sourceChannelId ?? '(unresolved)'} ` +
        `(@${this.config.sourceChannelUsername}).`,
    );
  }

  async stop(): Promise<void> {
    this.connected = false;
    const client = this.client;
    this.client = null;
    if (client) await client.disconnect().catch(() => undefined);
  }

  /**
   * The edge. Every update lands here, the receipt instant is taken FIRST,
   * and the channel guard runs before anything else looks at the text.
   */
  private async dispatch(event: NewMessageEvent | EditedMessageEvent, isEdit: boolean): Promise<void> {
    // Taken before any async work, including the peer lookup below: this is
    // the ingestion timestamp the latency figures are measured against, and
    // anything done first would be counted as network delay that never
    // happened.
    const receivedAtMs = Date.now();
    this.lastUpdateAtMs = receivedAtMs;

    try {
      const message = event.message;
      if (!message) return;

      const peer = this.describePeer(event);
      const check = checkSourceChannel(peer, this.config.sourceChannelId);
      if (!check.accepted) {
        // Deliberately debug, not warn: this account sees every chat it is in,
        // so on a normal day the overwhelming majority of updates are
        // legitimately not ours, and warning on each would bury real problems.
        this.logger.debug(`ignored update: ${check.detail}`);
        return;
      }

      // Telegram reports publication in whole seconds since the epoch, in UTC.
      const publishedAtMs = typeof message.date === 'number' ? message.date * 1000 : null;

      const source: TelegramSourceMessage = {
        channelId: peer.channelId ?? this.config.sourceChannelId ?? '',
        channelUsername: peer.username ?? this.config.sourceChannelUsername,
        messageId: String(message.id),
        text: typeof message.message === 'string' ? message.message : null,
        publishedAtMs,
        receivedAtMs,
      };

      this.lastSourceMessageAtMs = receivedAtMs;
      this.lastSourceMessageId = source.messageId;
      this.lastIngestionLatencyMs = publishedAtMs === null ? null : Math.max(0, receivedAtMs - publishedAtMs);

      if (isEdit) {
        const editedAtMs =
          typeof (message as Api.Message).editDate === 'number' ? (message as Api.Message).editDate! * 1000 : null;
        await this.editHandler?.({ message: source, editedAtMs });
        return;
      }
      await this.handler?.(source);
    } catch (err) {
      // An exception here must never take the connection down: a single
      // malformed update is not a reason to stop receiving the next one, and
      // a crashed ingestion process would be indistinguishable from a quiet
      // channel until someone noticed.
      this.logger.error(`ingestion dispatch failed: ${(err as Error).message}`);
    }
  }

  /**
   * Extracts the peer identity from an update.
   *
   * Reads the id from the message's own peer rather than from a chat object
   * fetched later, because the fetch is a second round trip that can answer
   * about a different chat if the id is ambiguous — and the whole point of
   * this check is that it cannot be talked out of.
   */
  private describePeer(event: NewMessageEvent | EditedMessageEvent): IncomingPeer {
    const message = event.message;
    const peerId = message?.peerId;
    const isChannel = peerId instanceof Api.PeerChannel;
    const channelId = isChannel ? normaliseChannelId(String(peerId.channelId)) : null;

    let username: string | null = null;
    try {
      const chat = event.chat as { username?: string } | undefined;
      username = typeof chat?.username === 'string' ? chat.username : null;
    } catch {
      username = null;
    }
    return { channelId, username, isChannel };
  }

  /** Safe liveness fields. Nothing here can carry credential material. */
  health(): {
    connected: boolean;
    lastUpdateAtMs: number | null;
    lastSourceMessageAtMs: number | null;
    lastSourceMessageId: string | null;
    ingestionLatencyMs: number | null;
  } {
    return {
      connected: this.connected && (this.client?.connected ?? false),
      lastUpdateAtMs: this.lastUpdateAtMs,
      lastSourceMessageAtMs: this.lastSourceMessageAtMs,
      lastSourceMessageId: this.lastSourceMessageId,
      ingestionLatencyMs: this.lastIngestionLatencyMs,
    };
  }
}

/**
 * Builds the adapter from the environment, refusing rather than starting
 * half-configured.
 *
 * Every failure here is a refusal to start ingestion at all. A process that
 * connects but cannot verify the source channel would look healthy while
 * accepting messages from anywhere, which is the one failure mode that could
 * put a stranger's text into an order.
 */
export function buildGramJsAdapterFromEnv(): GramJsIngestionAdapter {
  const apiId = Number((process.env.TELEGRAM_INGEST_API_ID ?? '').trim());
  const apiHash = (process.env.TELEGRAM_INGEST_API_HASH ?? '').trim();
  const username = (process.env.TELEGRAM_INGEST_SOURCE_CHANNEL ?? 'SFxauusd1').trim().replace(/^@/, '');

  if (!Number.isFinite(apiId) || apiId <= 0) {
    throw new Error('TELEGRAM_INGEST_API_ID is not configured.');
  }
  if (apiHash.length === 0) {
    // The value is never echoed, here or anywhere else.
    throw new Error('TELEGRAM_INGEST_API_HASH is not configured.');
  }

  const stored = readStoredSession();
  if (!stored) {
    throw new Error(
      'No Telegram session is stored. Run `deploy/m1m5.sh telegram-auth` once to sign in; the session then ' +
        'survives restarts and redeploys.',
    );
  }

  // The env var is an override for an operator who knows the id; otherwise
  // the id resolved at authentication is used. Neither path falls back to
  // matching on the username.
  const configuredId = (process.env.TELEGRAM_INGEST_SOURCE_CHANNEL_ID ?? '').trim() || stored.sourceChannelId;

  return new GramJsIngestionAdapter({
    apiId,
    apiHash,
    session: stored.session,
    sourceChannelId: configuredId ? normaliseChannelId(configuredId) : null,
    sourceChannelUsername: username,
  });
}
