/**
 * Telegram delivery for `xauusd-m1-m5-rsi-threshold-v2` (§13).
 *
 * Its OWN sender, its own credentials and its own dedup table, deliberately
 * not the neighbouring strategy's. Both bots trade the same symbol on the same
 * broker from the same machine; sharing delivery would put this strategy's
 * alerts in that one's channel, and sharing a dedup key space would let one
 * strategy's event silently suppress the other's alert about an entirely
 * different position.
 *
 * ## Notifying never blocks and never fails a caller
 *
 * Every caller invokes this AFTER the outcome is already durably recorded, and
 * ignores the result. A Telegram outage must never fail an order, roll back a
 * decision, or crash the observation loop. The cost of that choice is that a
 * failure has to be recoverable later rather than surfaced immediately, which
 * is what `retryPending` is for.
 *
 * ## A failed send is not final
 *
 * A row written FAILED and never looked at again means one transient network
 * blip permanently loses a trade alert. So attempts are counted, spaced out,
 * and eventually given up on — visibly, with the reason recorded.
 *
 * ## Nothing here approves a trade
 *
 * §8 forbids Telegram from approving trades, and this service is send-only: it
 * has no inbound webhook, no command handling and no way to read a reply. The
 * absence is the safeguard.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ReportDeliveryPort } from './reporting.service';

const UNIQUE_VIOLATION = 'P2002';

/** Which chats an event goes to. */
export type Audience = 'TRADING' | 'OPS';

export interface Recipient {
  readonly chatId: string;
  readonly label: string | null;
}

/**
 * Attempts before a row is abandoned, and how long to wait between them.
 *
 * Bounded on purpose: an unbounded retry against a revoked token would hammer
 * Telegram forever and bury the real alerts behind a permanently failing one.
 */
export const MAX_ATTEMPTS = 8;
export const RETRY_BACKOFF_MS = 30_000;

export interface TelegramConfig {
  readonly botToken: string | null;
  readonly tradingChatIds: readonly Recipient[];
  readonly opsChatIds: readonly Recipient[];
}

/**
 * Reads this strategy's OWN Telegram configuration.
 *
 * Prefixed variables, never the generic `TELEGRAM_*` ones, which belong to the
 * retained delivery layer this project inherited. Two systems reading one
 * variable is how a message ends up in the wrong channel.
 */
export function readTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  const parse = (raw: string | undefined): Recipient[] =>
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .map((entry) => {
        // "label:id" or a bare id. The label is for the operator reading a log
        // line; the id is what Telegram is given.
        const sep = entry.lastIndexOf(':');
        if (sep > 0) return { label: entry.slice(0, sep).trim(), chatId: entry.slice(sep + 1).trim() };
        return { label: null, chatId: entry };
      });

  return {
    botToken: env.XAUUSD_M1M5_TELEGRAM_BOT_TOKEN?.trim() || null,
    tradingChatIds: parse(env.XAUUSD_M1M5_TELEGRAM_TRADING_CHAT_IDS),
    opsChatIds: parse(env.XAUUSD_M1M5_TELEGRAM_OPS_CHAT_IDS),
  };
}

/** Removes the bot token from anything about to be stored or logged. */
export function redact(text: string, botToken: string | null): string {
  if (!botToken) return text;
  return text.split(botToken).join('<redacted-token>');
}

@Injectable()
export class M1M5TelegramService implements ReportDeliveryPort {
  private readonly logger = new Logger(M1M5TelegramService.name);

  private readonly config: TelegramConfig;
  private readonly fetchImpl: typeof fetch;

  /**
   * The config and fetch are `@Optional()` injection points with defaults
   * applied in the body, NOT TypeScript default parameters.
   *
   * Nest resolves constructor arguments by their emitted design:type, and an
   * interface erases to `Object` — a token nothing provides. A default
   * parameter value does not help, because Nest never gets as far as calling
   * the constructor: it fails during dependency resolution, at application
   * boot, with "can't resolve dependencies of M1M5TelegramService". That is a
   * restart loop on the API container, not a test-only problem.
   *
   * `@Optional()` makes Nest pass `undefined` for a token nothing provides,
   * and the fallbacks below then apply. Constructing this directly with
   * `new` — which the scheduler and the tests both do — keeps working
   * unchanged.
   */
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    @Optional() @Inject('M1M5_TELEGRAM_CONFIG') config?: TelegramConfig,
    @Optional() @Inject('M1M5_TELEGRAM_FETCH') fetchImpl?: typeof fetch,
  ) {
    this.config = config ?? readTelegramConfig();
    // Bound to globalThis: an unbound `fetch` reference throws "Illegal
    // invocation" when called as a method on this instance.
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
  }

  /** `ReportDeliveryPort`: the 24h performance report goes to the trading chats. */
  async send(text: string): Promise<void> {
    await this.notify('PERFORMANCE_REPORT', `report:${Date.now()}`, text, 'TRADING');
  }

  /**
   * Records and delivers one event, fanned out to every recipient.
   *
   * Never throws. Callers invoke it fire-and-forget after the fact, so an
   * exception here would surface at an unrelated await and could roll back
   * something that already happened.
   */
  async notify(eventType: string, dedupKey: string, text: string, audience: Audience = 'TRADING'): Promise<void> {
    try {
      const recipients = audience === 'OPS' ? this.config.opsChatIds : this.config.tradingChatIds;
      if (!this.config.botToken || recipients.length === 0) {
        this.logger.warn(`telegram not configured; ${eventType} not delivered: ${text.slice(0, 120)}`);
        return;
      }
      for (const recipient of recipients) {
        await this.deliverOne(eventType, `${dedupKey}#chat:${recipient.chatId}`, text, recipient);
      }
    } catch (err) {
      this.logger.error(`telegram notify failed for ${eventType}: ${(err as Error).message}`);
    }
  }

  private async deliverOne(eventType: string, dedupKey: string, text: string, recipient: Recipient): Promise<void> {
    // The unique constraint IS the deduplication. Checking first and inserting
    // after is a race that duplicates an alert when two workers report the
    // same closure at once.
    try {
      await this.prisma.xauusdM1M5TelegramNotification.create({
        data: { dedupKey, chatId: recipient.chatId, recipientLabel: recipient.label, eventType, text },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
        return; // already recorded, and already sent or queued for retry
      }
      throw err;
    }
    await this.attemptSend(dedupKey);
  }

  /** One send attempt for an existing row, recording whatever happened. */
  private async attemptSend(dedupKey: string): Promise<void> {
    const row = await this.prisma.xauusdM1M5TelegramNotification.findUnique({ where: { dedupKey } });
    if (!row || row.status === 'SENT') return;

    try {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${this.config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: row.chatId, text: row.text, disable_web_page_preview: true }),
      });
      const body = (await response.json()) as { ok?: boolean; result?: { message_id?: number }; description?: string };
      if (!response.ok || body.ok !== true) {
        throw new Error(body.description ?? `HTTP ${response.status}`);
      }
      await this.prisma.xauusdM1M5TelegramNotification.update({
        where: { dedupKey },
        data: {
          status: 'SENT',
          messageId: body.result?.message_id ?? null,
          sentAt: new Date(),
          attempts: { increment: 1 },
          lastAttemptAt: new Date(),
          lastError: null,
        },
      });
      this.logger.log(`telegram: sent ${row.eventType} to ${row.recipientLabel ?? row.chatId}`);
    } catch (err) {
      const attempts = row.attempts + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      await this.prisma.xauusdM1M5TelegramNotification.update({
        where: { dedupKey },
        data: {
          // Stays PENDING while retries remain, so the sweep will find it.
          status: exhausted ? 'FAILED' : 'PENDING',
          attempts,
          lastAttemptAt: new Date(),
          lastError: redact((err as Error).message, this.config.botToken).slice(0, 500),
        },
      });
      const message = `telegram: ${row.eventType} to ${row.recipientLabel ?? row.chatId} failed (attempt ${attempts}/${MAX_ATTEMPTS})`;
      if (exhausted) this.logger.error(`${message} -- GIVING UP, this alert will not be delivered`);
      else this.logger.warn(message);
    }
  }

  /**
   * Re-sends anything still pending whose backoff has elapsed.
   *
   * Called from the observation loop. This is the half that makes a transient
   * failure recoverable rather than permanent, and without it the retry
   * columns would just be a record of how the alert was lost.
   */
  async retryPending(nowMs: number): Promise<number> {
    if (!this.config.botToken) return 0;
    const due = await this.prisma.xauusdM1M5TelegramNotification.findMany({
      where: {
        status: 'PENDING',
        attempts: { gt: 0, lt: MAX_ATTEMPTS },
        lastAttemptAt: { lt: new Date(nowMs - RETRY_BACKOFF_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    for (const row of due) {
      await this.attemptSend(row.dedupKey);
    }
    return due.length;
  }
}
