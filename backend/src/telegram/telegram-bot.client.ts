import { Inject, Injectable } from '@nestjs/common';
import { redactToken } from '../common/redact';
import { TELEGRAM_CONFIG, TelegramConfig } from './telegram.config';
import { TelegramPermanentError, TelegramTransientError } from './telegram.errors';

interface TelegramSendMessageResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
  error_code?: number;
}

/**
 * The only Telegram-specific HTTP code in the system. Uses Node's global
 * `fetch` — no HTTP library dependency, easy to mock in tests
 * (`vi.spyOn(globalThis, 'fetch')`), no live bot required for automated
 * tests (PHASE5_DELIVERY_SPEC.md §13).
 */
// Neither call must hang indefinitely if Telegram (or the network path to
// it) is unreachable — a stuck fetch would otherwise occupy a delivery
// worker slot, or stall a health-check tick, for as long as the underlying
// TCP/DNS stack takes to give up on its own. Reliability pass — both
// widened after a real live failure this session (a genuine
// "network error calling Telegram: ... aborted due to timeout" at the old
// 10s limit, alongside a run of getMe health-check flaps at the old 5s
// limit) — Telegram's own API is typically sub-second, so these exist to
// absorb transient network stalls on this end, not because the API itself
// is usually slow.
const SEND_MESSAGE_TIMEOUT_MS = 20_000;
const CONNECTIVITY_CHECK_TIMEOUT_MS = 8_000;

@Injectable()
export class TelegramBotClient {
  constructor(@Inject(TELEGRAM_CONFIG) private readonly config: TelegramConfig) {}

  /** Returns the Telegram message id on success. Throws TelegramTransientError or TelegramPermanentError otherwise — never leaks the bot token in either. */
  async sendMessage(chatId: string, text: string): Promise<number> {
    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(SEND_MESSAGE_TIMEOUT_MS),
      });
    } catch (err) {
      // Never include `url` (it embeds the bot token) in the thrown message —
      // redactToken is defense-in-depth in case a wrapped error's own message
      // ever echoed it back.
      const message = err instanceof Error ? err.message : String(err);
      throw new TelegramTransientError(`network error calling Telegram: ${redactToken(message, this.config.botToken)}`);
    }

    const body = (await response.json().catch(() => ({ ok: false }))) as TelegramSendMessageResponse;

    if (response.status === 400 || response.status === 403) {
      throw new TelegramPermanentError(
        `Telegram ${response.status}: ${redactToken(describeBody(body), this.config.botToken)}`,
      );
    }
    if (!response.ok || !body.ok || body.result === undefined) {
      throw new TelegramTransientError(
        `Telegram ${response.status}: ${redactToken(describeBody(body), this.config.botToken)}`,
      );
    }

    return body.result.message_id;
  }

  /**
   * Phase 7 (HEALTH_SPEC.md) — a lightweight reachability check for the
   * TELEGRAM health component: calls Bot API's `getMe`, which sends no
   * message and costs nothing. Returns true/false rather than throwing —
   * the health checker's own contract (health-checks.ts) is "never throw,
   * always answer OK/DEGRADED/DOWN."
   */
  async checkConnectivity(): Promise<boolean> {
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.config.botToken}/getMe`, {
        signal: AbortSignal.timeout(CONNECTIVITY_CHECK_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

function describeBody(body: TelegramSendMessageResponse): string {
  return (body.description ?? JSON.stringify(body)).slice(0, 300);
}
