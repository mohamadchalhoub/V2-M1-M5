import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { redactToken } from '../common/redact';
import { parseRecipients, recipientDedupKey, TelegramRecipient } from './gold-telegram-recipients';

interface TelegramSendMessageResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
  error_code?: number;
}

const SEND_MESSAGE_TIMEOUT_MS = 20_000;

export interface TelegramDeliveryResult {
  recipient: TelegramRecipient;
  /** ALREADY_SENT means a prior attempt succeeded and was not repeated. */
  status: 'SENT' | 'ALREADY_SENT' | 'FAILED';
  messageId: number | null;
  error: string | null;
}

export interface TelegramDeliveryReport {
  eventType: string;
  dedupKey: string;
  results: TelegramDeliveryResult[];
  /** Configuration problems encountered while resolving the audience. */
  problems: string[];
}

/**
 * Gold execution's OWN, fully isolated Telegram notification path — task
 * requirement: "an isolated gold notification path... using its OWN bot
 * token/chat ID read directly from config (NOT the shared
 * TELEGRAM_TRADING_CHAT_IDS/OPS lists)". Deliberately does NOT depend on
 * `TelegramBotClient`/`TELEGRAM_CONFIG` (those are validated at startup
 * against the shared legacy bot/chat-id lists — see telegram.config.ts —
 * and this path must keep working, or fail, entirely independently of that
 * config) nor on the shared `TELEGRAM_DELIVERY_QUEUE` BullMQ pipeline
 * (Alert/AlertDelivery is a different, EURUSD/legacy-shaped concept). Calls
 * the Bot API directly with plain factual template strings — no AI
 * narration, ever.
 *
 * Durable dedup + delivery-result persistence: one row per notification
 * attempt in `GoldTelegramNotification`, keyed by a caller-supplied
 * `dedupKey` (`@unique` in the schema) — same "unique key closes the
 * duplicate-send race" posture as `AlertDelivery.alertId @unique` and
 * `deliveryJobId()` (jobs.constants.ts). A second call with the same
 * dedupKey is a guaranteed no-op (checked first, and the DB unique
 * constraint is the actual backstop against a race). `messageId`/`status`/
 * `lastError` are persisted the same way `AlertDelivery`/`AiAnalysis`
 * persist `telegramMessageIds`/`status`/`lastError` — kept in Postgres, not
 * memory, so a restart never loses the delivery record.
 */
/** Spacing between retry attempts for one row — a blocked endpoint must not be hammered. */
const RETRY_MIN_INTERVAL_MS = 60_000;
/** Beyond this, a late alert is noise rather than news, and is abandoned. */
const RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Total attempts per row before giving up, so retries cannot run forever. */
const RETRY_MAX_ATTEMPTS = 30;
/** Rows handled per sweep, so one cycle cannot stall on a long backlog. */
const RETRY_BATCH = 10;

@Injectable()
export class GoldTelegramService {
  private readonly logger = new Logger(GoldTelegramService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Sends `text` once per `dedupKey`. Returns silently (logging only) on
   * any failure — a Telegram outage must never throw back into, or block,
   * the trading-path code calling this (fills/closures/rejections must
   * still be recorded even if the notification itself cannot go out).
   */
  /**
   * Sends `text` once per recipient per `dedupKey`.
   *
   * Fans out to every configured recipient and tracks each independently: one
   * recipient failing never prevents or hides another succeeding, and a retry
   * re-sends only the recipients whose own row is not already SENT.
   *
   * Never throws. A Telegram outage must not propagate into the trading path,
   * which has already durably recorded whatever this is reporting.
   */
  async notify(eventType: string, dedupKey: string, text: string): Promise<TelegramDeliveryReport> {
    const botToken = this.config.get<string>('GOLD_TELEGRAM_BOT_TOKEN')?.trim();
    const { recipients, problems } = this.resolveRecipients();

    for (const problem of problems) {
      this.logger.error(`gold telegram configuration: ${problem}`);
    }

    if (!botToken || recipients.length === 0) {
      const reason = !botToken
        ? 'GOLD_TELEGRAM_BOT_TOKEN not configured'
        : 'no valid recipient configured (GOLD_TELEGRAM_CHAT_ID / GOLD_TELEGRAM_CHAT_IDS)';
      this.logger.error(`gold telegram: cannot send ${eventType} (dedupKey=${dedupKey}) — ${reason}`);
      // Recorded against the logical key so the failure is durable even when
      // there is no recipient to attribute it to.
      await this.upsertResult(dedupKey, null, null, eventType, text, { status: 'FAILED', lastError: reason });
      return { eventType, dedupKey, results: [], problems: [...problems, reason] };
    }

    const results: TelegramDeliveryResult[] = [];
    for (const recipient of recipients) {
      const key = recipientDedupKey(dedupKey, recipient.chatId);
      const existing = await this.prisma.goldTelegramNotification.findUnique({ where: { dedupKey: key } });
      if (existing && existing.status === 'SENT') {
        this.logger.debug(`gold telegram: ${key} already sent (message ${existing.messageId}) — skipping`);
        results.push({ recipient, status: 'ALREADY_SENT', messageId: existing.messageId ?? null, error: null });
        continue;
      }

      try {
        const messageId = await this.sendMessage(botToken, recipient.chatId, text);
        await this.upsertResult(key, recipient.chatId, recipient.label, eventType, text, {
          status: 'SENT',
          messageId,
          sentAt: new Date(),
        });
        this.logger.log(`gold telegram: sent ${eventType} to ${recipient.label} (message_id=${messageId})`);
        results.push({ recipient, status: 'SENT', messageId, error: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.upsertResult(key, recipient.chatId, recipient.label, eventType, text, {
          status: 'FAILED',
          lastError: message.slice(0, 500),
        });
        this.logger.error(`gold telegram: failed to send ${eventType} to ${recipient.label}: ${message}`);
        results.push({ recipient, status: 'FAILED', messageId: null, error: message });
      }
    }

    return { eventType, dedupKey, results, problems };
  }

  /**
   * Re-sends notifications that failed earlier and are still worth sending.
   *
   * Without this a failed send was final. The row was written FAILED and
   * nothing ever looked at it again, so a transient network problem lost a
   * trade alert permanently. That happened live on 2026-09-21: both round
   * trips produced SIGNAL_QUEUED and FILL_CONFIRMED notifications, every one
   * failed with "network error calling Telegram: fetch failed" while
   * api.telegram.org was unreachable from the host, and none was ever
   * delivered. The operator found out by noticing the silence.
   *
   * Deliberate bounds:
   *
   * - Attempts are spaced by `RETRY_MIN_INTERVAL_MS`, so a caller that runs
   *   every second does not hammer a blocked endpoint.
   * - Rows older than `RETRY_MAX_AGE_MS` are abandoned. A day-old fill alert
   *   arriving now is noise, not news.
   * - `RETRY_MAX_ATTEMPTS` bounds the total effort per row.
   * - Deduplication is untouched: each row is one recipient, and a row that
   *   reached SENT is never selected, so nobody receives a duplicate.
   *
   * The text is prefixed to say the delivery was delayed. The original body
   * carries the event's own timestamps, so a late alert states plainly both
   * when it happened and that it is late.
   */
  async retryFailed(now: Date = new Date()): Promise<{ attempted: number; sent: number; gaveUp: number }> {
    const botToken = this.config.get<string>('GOLD_TELEGRAM_BOT_TOKEN');
    if (!botToken) return { attempted: 0, sent: 0, gaveUp: 0 };

    const due = await this.prisma.goldTelegramNotification.findMany({
      where: {
        status: 'FAILED',
        chatId: { not: null },
        createdAt: { gte: new Date(now.getTime() - RETRY_MAX_AGE_MS) },
        attempts: { lt: RETRY_MAX_ATTEMPTS },
        OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: new Date(now.getTime() - RETRY_MIN_INTERVAL_MS) } }],
      },
      orderBy: { createdAt: 'asc' },
      take: RETRY_BATCH,
    });
    if (due.length === 0) return { attempted: 0, sent: 0, gaveUp: 0 };

    let sent = 0;
    let gaveUp = 0;
    for (const row of due) {
      const delayedSeconds = Math.round((now.getTime() - row.createdAt.getTime()) / 1000);
      const text =
        `DELAYED DELIVERY — this alert could not be sent when it happened ` +
        `(${delayedSeconds}s ago) and is being delivered now.

${row.text}`;
      try {
        const messageId = await this.sendMessage(botToken, row.chatId!, text);
        await this.prisma.goldTelegramNotification.update({
          where: { id: row.id },
          data: { status: 'SENT', messageId, sentAt: now, attempts: row.attempts + 1, lastAttemptAt: now, lastError: null },
        });
        this.logger.log(`gold telegram: delivered ${row.eventType} on retry ${row.attempts + 1} (message_id=${messageId}, delayed ${delayedSeconds}s)`);
        sent += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const attempts = row.attempts + 1;
        await this.prisma.goldTelegramNotification.update({
          where: { id: row.id },
          data: { attempts, lastAttemptAt: now, lastError: message.slice(0, 500) },
        });
        if (attempts >= RETRY_MAX_ATTEMPTS) {
          gaveUp += 1;
          this.logger.error(`gold telegram: giving up on ${row.eventType} (${row.dedupKey}) after ${attempts} attempts — ${message}`);
        }
      }
    }
    return { attempted: due.length, sent, gaveUp };
  }

  /** Counts for the dashboard, so a silent delivery outage is VISIBLE. */
  async deliveryHealth(now: Date = new Date()): Promise<{
    failedPending: number;
    gaveUp: number;
    oldestFailedAgeSeconds: number | null;
    lastError: string | null;
  }> {
    const cutoff = new Date(now.getTime() - RETRY_MAX_AGE_MS);
    const [pending, gaveUp, oldest] = await Promise.all([
      this.prisma.goldTelegramNotification.count({ where: { status: 'FAILED', createdAt: { gte: cutoff }, attempts: { lt: RETRY_MAX_ATTEMPTS } } }),
      this.prisma.goldTelegramNotification.count({ where: { status: 'FAILED', attempts: { gte: RETRY_MAX_ATTEMPTS } } }),
      this.prisma.goldTelegramNotification.findFirst({
        where: { status: 'FAILED', createdAt: { gte: cutoff } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true, lastError: true },
      }),
    ]);
    return {
      failedPending: pending,
      gaveUp,
      oldestFailedAgeSeconds: oldest ? Math.round((now.getTime() - oldest.createdAt.getTime()) / 1000) : null,
      lastError: oldest?.lastError ?? null,
    };
  }

  /** The configured audience, as parsed. Exposed so status output can show it. */
  resolveRecipients(): { recipients: TelegramRecipient[]; problems: string[] } {
    return parseRecipients({
      GOLD_TELEGRAM_CHAT_ID: this.config.get<string>('GOLD_TELEGRAM_CHAT_ID'),
      GOLD_TELEGRAM_CHAT_IDS: this.config.get<string>('GOLD_TELEGRAM_CHAT_IDS'),
    });
  }

  /**
   * Confirms a destination exists and that this bot can address it, via
   * Telegram's own `getChat`, BEFORE anything is sent to it.
   *
   * This is what makes "verify the destination through Telegram metadata"
   * real: a chat the bot has never been started by returns a specific error
   * here rather than silently swallowing every future notification.
   */
  async verifyRecipient(recipient: TelegramRecipient): Promise<{ ok: boolean; detail: string; chatType?: string; title?: string }> {
    const botToken = this.config.get<string>('GOLD_TELEGRAM_BOT_TOKEN')?.trim();
    if (!botToken) return { ok: false, detail: 'GOLD_TELEGRAM_BOT_TOKEN not configured' };
    try {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/getChat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: recipient.chatId }),
        signal: AbortSignal.timeout(SEND_MESSAGE_TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => ({ ok: false }))) as {
        ok: boolean;
        description?: string;
        result?: { type?: string; title?: string; username?: string; first_name?: string };
      };
      if (!response.ok || !body.ok) {
        return {
          ok: false,
          detail: redactToken((body.description ?? `HTTP ${response.status}`).slice(0, 300), botToken),
        };
      }
      const r = body.result ?? {};
      const who = r.title ?? [r.first_name, r.username ? `@${r.username}` : null].filter(Boolean).join(' ') ?? '';
      return { ok: true, detail: `chat exists (type=${r.type ?? 'unknown'}${who ? `, ${who}` : ''})`, chatType: r.type, title: who };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: redactToken(message, botToken ?? '') };
    }
  }

  /** Confirms the bot token itself resolves, via `getMe`. */
  async verifyBot(): Promise<{ ok: boolean; detail: string }> {
    const botToken = this.config.get<string>('GOLD_TELEGRAM_BOT_TOKEN')?.trim();
    if (!botToken) return { ok: false, detail: 'GOLD_TELEGRAM_BOT_TOKEN not configured' };
    try {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
        signal: AbortSignal.timeout(SEND_MESSAGE_TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => ({ ok: false }))) as {
        ok: boolean;
        description?: string;
        result?: { username?: string; first_name?: string };
      };
      if (!response.ok || !body.ok) {
        return { ok: false, detail: redactToken((body.description ?? `HTTP ${response.status}`).slice(0, 300), botToken) };
      }
      return { ok: true, detail: `bot @${body.result?.username ?? 'unknown'} (${body.result?.first_name ?? ''})`.trim() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: redactToken(message, botToken ?? '') };
    }
  }

  private async sendMessage(botToken: string, chatId: string, text: string): Promise<number> {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(SEND_MESSAGE_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`network error calling Telegram: ${redactToken(message, botToken)}`);
    }

    const body = (await response.json().catch(() => ({ ok: false }))) as TelegramSendMessageResponse;
    if (!response.ok || !body.ok || body.result === undefined) {
      throw new Error(`Telegram ${response.status}: ${redactToken((body.description ?? JSON.stringify(body)).slice(0, 300), botToken)}`);
    }
    return body.result.message_id;
  }

  private async upsertResult(
    dedupKey: string,
    chatId: string | null,
    recipientLabel: string | null,
    eventType: string,
    text: string,
    result: { status: 'SENT' | 'FAILED'; messageId?: number; lastError?: string; sentAt?: Date },
  ): Promise<void> {
    await this.prisma.goldTelegramNotification.upsert({
      where: { dedupKey },
      create: {
        dedupKey,
        chatId,
        recipientLabel,
        eventType,
        text,
        status: result.status,
        messageId: result.messageId ?? null,
        lastError: result.lastError ?? null,
        sentAt: result.sentAt ?? null,
      },
      update: {
        chatId,
        recipientLabel,
        status: result.status,
        messageId: result.messageId ?? null,
        lastError: result.lastError ?? null,
        sentAt: result.sentAt ?? null,
      },
    });
  }
}
