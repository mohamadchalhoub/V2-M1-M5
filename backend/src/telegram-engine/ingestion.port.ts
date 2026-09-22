/**
 * The boundary between "a Telegram client" and "a trading engine".
 *
 * Everything downstream of this file is pure domain logic that can be tested
 * with a hand-written message object and a fake clock. Nothing downstream
 * knows whether the message arrived over MTProto, over a bot API, from a
 * replayed backlog or from a test — which is what makes the 60-second
 * lifetime and the duplicate rules testable at all.
 *
 * ## publishedAtMs is not receivedAtMs
 *
 * The adapter MUST supply the message's own publication timestamp, as
 * Telegram reports it, and must not substitute the local receipt time when it
 * is missing. A signal whose publication time is unknown cannot have its
 * lifetime measured, and the engine refuses it — see `TelegramSourceMessage`.
 * Substituting receipt time would make every replayed message look brand new
 * and defeat the rule entirely.
 *
 * ## Channel identity
 *
 * `channelUsername` is compared against the configured source. An adapter
 * that cannot establish which channel a message came from must leave it null,
 * and the engine will discard the message rather than assume.
 */

export interface TelegramSourceMessage {
  /** Stable numeric/string channel id from the transport. */
  readonly channelId: string;
  /** Channel @username WITHOUT the leading @, or null if unknown. */
  readonly channelUsername: string | null;
  readonly messageId: string;
  readonly text: string | null;
  /**
   * The ORIGINAL publication instant as Telegram reports it, UTC ms. Null
   * when the transport could not supply one, which blocks: a signal whose age
   * cannot be measured cannot be shown to be within its lifetime.
   */
  readonly publishedAtMs: number | null;
  /** When this process received it, UTC ms. Never used for the lifetime. */
  readonly receivedAtMs: number;
}

/**
 * A transport that yields messages. Implemented in production by an MTProto
 * or bot-API adapter; implemented in tests by an array.
 */
export interface TelegramIngestionPort {
  /**
   * Called once per received message. Implementations must deliver at-least
   * once and may redeliver after a reconnect — the engine's durable duplicate
   * keys are what make that safe, so an adapter need not (and must not) try
   * to guarantee exactly-once itself.
   */
  onMessage(handler: (message: TelegramSourceMessage) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
