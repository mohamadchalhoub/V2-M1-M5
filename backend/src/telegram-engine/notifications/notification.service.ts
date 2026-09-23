/**
 * Engine B's outgoing alerts.
 *
 * Structurally the same design as Engine A's sender, for the same reasons,
 * and deliberately not a shared instance of it:
 *
 * - **Notifying never blocks and never fails a caller.** Every call site
 *   invokes this AFTER the outcome is already durably recorded, and ignores
 *   the result. A Telegram outage must never fail an order, roll back a
 *   decision or crash ingestion.
 * - **A failed send is not final.** Attempts are counted, spaced and
 *   eventually abandoned visibly, so one network blip does not silently lose
 *   a trade alert.
 * - **The dedup key is the guarantee.** The unique constraint decides whether
 *   something has already been sent; checking first and inserting after is a
 *   race that duplicates an alert when two workers report one event.
 *
 * ## What is shared with Engine A, and what is not
 *
 * Shared: the bot token and the chat ids, by default. The operator wants both
 * engines' alerts in the same place, and requiring a second bot to be
 * provisioned before Engine B could speak would be a configuration burden
 * with no safety benefit.
 *
 * Not shared: the dedup table. Engine A's own schema explains why, and it
 * applies with more force here — two engines trading one symbol on one
 * account will produce similar-looking keys, and a collision would mean one
 * engine's event silently suppressing the other's alert about a different
 * position.
 *
 * ## Send-only
 *
 * There is no inbound webhook, no command handling and no way to read a
 * reply. Telegram cannot approve, cancel or modify a trade, and the absence
 * of any inbound path is what guarantees that rather than a rule saying so.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const UNIQUE_VIOLATION = 'P2002';

export type Audience = 'TRADING' | 'OPS';

export interface Recipient {
  readonly chatId: string;
  readonly label: string | null;
}

/** Bounded on purpose: unbounded retry against a revoked token would hammer
 * Telegram forever and bury real alerts behind a permanently failing one. */
export const MAX_ATTEMPTS = 8;
export const RETRY_BACKOFF_MS = 30_000;

export interface TelegramEngineNotifyConfig {
  readonly botToken: string | null;
  readonly tradingChatIds: readonly Recipient[];
  readonly opsChatIds: readonly Recipient[];
}

function parseRecipients(raw: string | undefined): Recipient[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      // "label:id" or a bare id.
      const sep = entry.lastIndexOf(':');
      if (sep > 0) return { label: entry.slice(0, sep).trim(), chatId: entry.slice(sep + 1).trim() };
      return { label: null, chatId: entry };
    });
}

/**
 * Engine B's own variables first, the existing ones as a fallback.
 *
 * The fallback is what makes this deployable without touching the VPS
 * configuration: the operator already has a working bot and recipient list,
 * and Engine B uses them unless someone deliberately points it elsewhere.
 */
export function readNotifyConfig(env: NodeJS.ProcessEnv = process.env): TelegramEngineNotifyConfig {
  return {
    botToken:
      env.TELEGRAM_ENGINE_NOTIFY_BOT_TOKEN?.trim() || env.XAUUSD_M1M5_TELEGRAM_BOT_TOKEN?.trim() || null,
    tradingChatIds: parseRecipients(
      env.TELEGRAM_ENGINE_NOTIFY_TRADING_CHAT_IDS ?? env.XAUUSD_M1M5_TELEGRAM_TRADING_CHAT_IDS,
    ),
    opsChatIds: parseRecipients(
      env.TELEGRAM_ENGINE_NOTIFY_OPS_CHAT_IDS ?? env.XAUUSD_M1M5_TELEGRAM_OPS_CHAT_IDS,
    ),
  };
}

/** Removes the bot token from anything about to be stored or logged. */
export function redact(text: string, botToken: string | null): string {
  if (!botToken) return text;
  return text.split(botToken).join('<redacted-token>');
}

@Injectable()
export class TelegramEngineNotificationService {
  private readonly logger = new Logger(TelegramEngineNotificationService.name);

  private readonly config: TelegramEngineNotifyConfig;
  private readonly fetchImpl: typeof fetch;

  /**
   * `@Optional()` injection points with defaults applied in the body, not
   * TypeScript default parameters: Nest resolves constructor arguments by
   * emitted design:type, an interface erases to `Object`, and a token nothing
   * provides fails during dependency resolution at boot — a restart loop on
   * the container, not a test-only problem.
   */
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    @Optional() @Inject('TELEGRAM_ENGINE_NOTIFY_CONFIG') config?: TelegramEngineNotifyConfig,
    @Optional() @Inject('TELEGRAM_ENGINE_NOTIFY_FETCH') fetchImpl?: typeof fetch,
  ) {
    this.config = config ?? readNotifyConfig();
    // Bound to globalThis: an unbound `fetch` throws "Illegal invocation".
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
  }

  /**
   * Records and delivers one event. Never throws.
   *
   * Callers invoke it fire-and-forget after the fact, so an exception here
   * would surface at an unrelated await and could roll back something that
   * has already happened at the broker.
   */
  async notify(eventType: string, dedupKey: string, text: string, audience: Audience = 'TRADING'): Promise<void> {
    try {
      const recipients = audience === 'OPS' ? this.config.opsChatIds : this.config.tradingChatIds;
      if (!this.config.botToken || recipients.length === 0) {
        this.logger.warn(`telegram engine: not configured; ${eventType} not delivered: ${text.slice(0, 120)}`);
        return;
      }
      for (const recipient of recipients) {
        await this.deliverOne(eventType, `${dedupKey}#chat:${recipient.chatId}`, text, recipient);
      }
    } catch (err) {
      this.logger.error(`telegram engine notify failed for ${eventType}: ${(err as Error).message}`);
    }
  }

  private async deliverOne(eventType: string, dedupKey: string, text: string, recipient: Recipient): Promise<void> {
    try {
      await this.prisma.telegramEngineNotification.create({
        data: {
          dedupKey,
          chatId: recipient.chatId,
          recipientLabel: recipient.label,
          eventType,
          text: redact(text, this.config.botToken),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
        return; // already recorded, and already sent or queued for retry
      }
      throw err;
    }
    await this.attemptSend(dedupKey);
  }

  private async attemptSend(dedupKey: string): Promise<void> {
    const row = await this.prisma.telegramEngineNotification.findUnique({ where: { dedupKey } });
    if (!row || row.status === 'SENT' || row.status === 'ABANDONED') return;

    try {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${this.config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: row.chatId, text: row.text, disable_web_page_preview: true }),
      });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: { message_id?: number }; description?: string };

      if (response.ok && payload.ok) {
        await this.prisma.telegramEngineNotification.update({
          where: { dedupKey },
          data: {
            status: 'SENT',
            sentAt: new Date(),
            messageId: payload.result?.message_id ?? null,
            attempts: row.attempts + 1,
            lastAttemptAt: new Date(),
            lastError: null,
          },
        });
        return;
      }
      await this.recordFailure(dedupKey, row.attempts + 1, payload.description ?? `HTTP ${response.status}`);
    } catch (err) {
      await this.recordFailure(dedupKey, row.attempts + 1, (err as Error).message);
    }
  }

  private async recordFailure(dedupKey: string, attempts: number, reason: string): Promise<void> {
    const abandoned = attempts >= MAX_ATTEMPTS;
    await this.prisma.telegramEngineNotification.update({
      where: { dedupKey },
      data: {
        status: abandoned ? 'ABANDONED' : 'FAILED',
        attempts,
        lastAttemptAt: new Date(),
        // Telegram echoes the token back inside the URL on some errors.
        lastError: redact(reason, this.config.botToken).slice(0, 500),
      },
    });
    if (abandoned) {
      this.logger.error(`telegram engine alert ABANDONED after ${attempts} attempts: ${reason}`);
    }
  }

  /**
   * Retries alerts that failed earlier. Called on a slow cadence by the
   * ingestion process.
   *
   * Without this, a row written FAILED and never looked at again means one
   * transient blip permanently loses a trade alert.
   */
  async retryPending(nowMs: number = Date.now()): Promise<number> {
    const due = await this.prisma.telegramEngineNotification.findMany({
      where: {
        status: 'FAILED',
        attempts: { lt: MAX_ATTEMPTS },
        OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: new Date(nowMs - RETRY_BACKOFF_MS) } }],
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
