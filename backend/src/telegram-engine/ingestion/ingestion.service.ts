/**
 * The runtime path: a message published on `@SFxauusd1` becomes an execution
 * decision, in one pass.
 *
 *   Telegram update
 *     -> receipt instant captured at the edge (gramjs-client.ts)
 *     -> channel identity verified (channel-guard.ts)
 *     -> raw ingestion recorded
 *     -> parser
 *     -> duplicate / freshness / availability / TP1 / legs (execution.service)
 *     -> MT5
 *
 * ## Event-driven, with a short poll as a safety net
 *
 * GramJS delivers updates as Telegram pushes them, and this handler runs
 * primarily on that delivery — a genuinely event-driven path costs nothing
 * of the 60-second budget waiting. But push delivery for a channel has been
 * observed, in production, to silently stall (connected: true, zero events,
 * indefinitely) — see gramjs-client.ts's pollOnce() for the incident this
 * traces back to. So the adapter also polls the channel every few seconds as
 * a fallback; a message delivered by both paths is consumed once, via the
 * durable duplicate key. This handler itself does not know or care which
 * path a message arrived by — both call the same `handleMessage`.
 *
 * ## Why every accepted message is recorded, not just the signals
 *
 * The raw ingestion log answers questions the signal table cannot: whether
 * the channel is alive during a quiet spell, what the real publication-to-
 * receipt latency looks like, and whether the parser is ignoring things it
 * should have read. It is also what SHADOW validation is judged from. It is
 * deliberately a preview rather than the full text — this is a liveness log,
 * not a mirror of someone else's channel.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { M1M5Mt5SnapshotService } from '../../xauusd-m1m5/mt5-snapshot.service';
import { buildTelegramExecutionContext } from '../execution-context';
import { TelegramEngineExecutionService } from '../execution.service';
import type { TelegramSourceMessage } from '../ingestion.port';
import { parseTelegramSignal } from '../parser';
import { GramJsIngestionAdapter, buildGramJsAdapterFromEnv, type TelegramEditEvent } from './gramjs-client';
import { summariseSession } from './session-store';

const TEXT_PREVIEW_LIMIT = 400;

@Injectable()
export class TelegramIngestionService {
  private readonly logger = new Logger(TelegramIngestionService.name);
  private adapter: GramJsIngestionAdapter | null = null;
  private accountId: string | null = null;
  private expectedLoginId: string | null = null;
  private startedAtMs: number | null = null;
  private lastError: string | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    private readonly snapshots: M1M5Mt5SnapshotService,
    private readonly execution: TelegramEngineExecutionService,
  ) {}

  /**
   * Starts ingestion for one account.
   *
   * Called by the dedicated ingestion process, never from the API's boot
   * path: importing a module must not sign into Telegram, for the same
   * reason importing Engine A's module must not start trading.
   */
  async start(accountId: string, expectedLoginId: string | null): Promise<void> {
    this.accountId = accountId;
    this.expectedLoginId = expectedLoginId;

    const adapter = buildGramJsAdapterFromEnv();
    adapter.onMessage((message) => this.handleMessage(message));
    adapter.onEdit((event) => this.handleEdit(event));
    await adapter.start();

    this.adapter = adapter;
    this.startedAtMs = Date.now();
    this.lastError = null;
  }

  async stop(): Promise<void> {
    await this.adapter?.stop();
    this.adapter = null;
  }

  /**
   * One message, start to finish.
   *
   * Every failure path here is caught and logged rather than thrown: an
   * exception escaping this handler would propagate into GramJS's update
   * loop, and a single malformed message must not stop the next one arriving.
   */
  async handleMessage(message: TelegramSourceMessage): Promise<void> {
    const accountId = this.accountId;
    if (!accountId) return;

    try {
      const parsed = parseTelegramSignal(message.text);
      await this.recordIngestedMessage(
        message,
        parsed.signal ? 'PARSED_SIGNAL' : 'NOT_A_SIGNAL',
        false,
        parsed.signal ? null : parsed.refusal,
      );

      if (!parsed.signal) {
        // Ordinary channel traffic. Recorded above for liveness and for
        // SHADOW review, and deliberately not carried further.
        this.logger.debug(`message ${message.messageId} is not a trade instruction: ${parsed.refusal}`);
        return;
      }

      const { context, gaps } = await buildTelegramExecutionContext({
        prisma: this.prisma,
        snapshots: this.snapshots,
        accountId,
        nowMs: Date.now(),
        expectedLoginId: this.expectedLoginId,
      });
      if (gaps.length > 0) {
        // Not fatal: the gates below refuse on precisely these, and refusing
        // there records the refusal against the signal where an operator will
        // look for it. Logged so the same information is in the process log.
        this.logger.warn(`telegram context gaps: ${gaps.join('; ')}`);
      }

      const result = await this.execution.process(message, context);
      this.logger.log(
        `telegram signal ${message.messageId}: ${result.outcome} (${result.legsSubmitted} leg(s) submitted) - ${result.detail}`,
      );
    } catch (err) {
      this.lastError = (err as Error).message;
      this.logger.error(`failed to process telegram message ${message.messageId}: ${this.lastError}`);
    }
  }

  /**
   * An edit of a message.
   *
   * Two cases, and the difference matters:
   *
   * - The engine never traded this message (it was chat, or it was refused).
   *   The edit is reparsed and, if it is now a valid fresh signal, it goes
   *   through the normal path — its own message id makes it a distinct row,
   *   and the 60-second clock still runs from the ORIGINAL publication, so an
   *   edit made minutes later cannot revive a dead signal.
   *
   * - The engine already acted on it. Then nothing is duplicated, reversed,
   *   modified or closed. The positions exist at the broker with the levels
   *   that were published at the time; silently moving a stop because someone
   *   edited a Telegram message afterwards is not something this engine will
   *   do on its own. The edit is recorded and surfaced for a human.
   */
  async handleEdit(event: TelegramEditEvent): Promise<void> {
    const accountId = this.accountId;
    if (!accountId) return;
    const { message } = event;

    try {
      await this.recordIngestedMessage(message, 'EDIT', true);

      const existing = await this.prisma.telegramSignal.findFirst({
        where: { accountId, channelId: message.channelId, messageId: message.messageId },
        include: { legs: true },
      });

      const alreadyActedOn =
        existing !== null && existing.legs.some((leg) => leg.orderStatus !== 'NONE' && leg.orderStatus !== 'SKIPPED');

      if (existing) {
        const history = Array.isArray(existing.editHistory) ? (existing.editHistory as unknown[]) : [];
        await this.prisma.telegramSignal.update({
          where: { id: existing.id },
          data: {
            editVersion: existing.editVersion + 1,
            lastEditedAt: new Date(event.editedAtMs ?? message.receivedAtMs),
            editHistory: [
              ...history,
              {
                at: new Date(event.editedAtMs ?? message.receivedAtMs).toISOString(),
                text: (message.text ?? '').slice(0, TEXT_PREVIEW_LIMIT),
                actedOn: alreadyActedOn,
              },
            ] as never,
          },
        });
      }

      if (alreadyActedOn) {
        this.logger.warn(
          `telegram message ${message.messageId} was EDITED after this engine acted on it. Positions are left ` +
            'exactly as submitted: no leg is duplicated, reversed, modified or closed because of an edit.',
        );
        return;
      }

      // Not acted on yet, so the edit is simply the current version of a
      // message we have not traded. Run it through the normal path; the
      // duplicate keys decide whether it is genuinely new.
      await this.handleMessage(message);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.logger.error(`failed to process telegram edit ${message.messageId}: ${this.lastError}`);
    }
  }

  private async recordIngestedMessage(
    message: TelegramSourceMessage,
    classification: string,
    isEdit: boolean,
    refusalReason: string | null = null,
  ): Promise<void> {
    const publishedAt = message.publishedAtMs === null ? new Date(message.receivedAtMs) : new Date(message.publishedAtMs);
    try {
      await this.prisma.telegramIngestedMessage.create({
        data: {
          channelId: message.channelId,
          messageId: message.messageId,
          publishedAt,
          receivedAt: new Date(message.receivedAtMs),
          publicationToIngestionMs:
            message.publishedAtMs === null ? null : Math.max(0, Math.round(message.receivedAtMs - message.publishedAtMs)),
          textPreview: (message.text ?? '').slice(0, TEXT_PREVIEW_LIMIT),
          classification,
          refusalReason,
          // Set only on the FIRST successful insert for this message: the
          // unique constraint below is what makes this durably "first
          // delivery", the same mechanism that already protects the trading
          // path from a redelivered update producing a second position.
          deliveryPath: message.deliveryPath ?? null,
          isEdit,
        },
      });
    } catch {
      // A redelivered update hits the unique key. That is the normal,
      // expected outcome of a reconnect replay and is not worth a log line:
      // the ingestion log records what arrived, once.
    }
  }

  /**
   * Writes a snapshot of this process's own push/poll liveness to the
   * database, so the api process serving the dashboard — a SEPARATE
   * container, with no access to this process's memory — can show it.
   *
   * Called on the same cadence as the existing heartbeat log line (see
   * telegram-ingest.ts), deliberately not on a new timer of its own: this is
   * observability riding the schedule that already exists, not a second
   * monitoring system.
   */
  async persistHealthSnapshot(accountId: string): Promise<void> {
    const session = summariseSession();
    const adapter = this.adapter?.health();
    try {
      await this.prisma.telegramIngestionHealth.upsert({
        where: { accountId },
        create: {
          accountId,
          authorized: session.present,
          connected: adapter?.connected ?? false,
          pushLastUpdateAt: adapter?.lastUpdateAtMs ? new Date(adapter.lastUpdateAtMs) : null,
          pollLastAt: adapter?.lastPollAtMs ? new Date(adapter.lastPollAtMs) : null,
          pollLastError: adapter?.lastPollError ?? null,
        },
        update: {
          authorized: session.present,
          connected: adapter?.connected ?? false,
          pushLastUpdateAt: adapter?.lastUpdateAtMs ? new Date(adapter.lastUpdateAtMs) : null,
          pollLastAt: adapter?.lastPollAtMs ? new Date(adapter.lastPollAtMs) : null,
          pollLastError: adapter?.lastPollError ?? null,
        },
      });
    } catch (err) {
      // Never fatal: a failure to WRITE observability data must not stop
      // ingestion itself, which is the whole reason this is a best-effort
      // snapshot rather than something the trading path depends on.
      this.logger.warn(`could not persist ingestion health snapshot: ${(err as Error).message}`);
    }
  }

  /**
   * Safe health fields. Nothing here can carry the API hash, the phone
   * number, a login code, a 2FA password or the session string — see
   * `session-store.ts`, which is the only thing that touches those and
   * exposes none of them.
   */
  health(): Record<string, unknown> {
    const session = summariseSession();
    const adapter = this.adapter?.health();
    return {
      telegramAuthorized: session.present,
      telegramConnected: adapter?.connected ?? false,
      sourceChannelResolved: session.sourceChannelId !== null,
      sourceChannelAccessible: adapter?.connected === true && session.sourceChannelId !== null,
      sourceChannel: session.sourceChannelTitle,
      sourceChannelId: session.sourceChannelId,
      sessionPermissionsOk: session.permissionsOk,
      authorizedAt: session.authorizedAtMs ? new Date(session.authorizedAtMs).toISOString() : null,
      account: session.accountLabel,
      startedAt: this.startedAtMs ? new Date(this.startedAtMs).toISOString() : null,
      lastUpdateAt: adapter?.lastUpdateAtMs ? new Date(adapter.lastUpdateAtMs).toISOString() : null,
      lastSourceMessageAt: adapter?.lastSourceMessageAtMs
        ? new Date(adapter.lastSourceMessageAtMs).toISOString()
        : null,
      lastSourceMessageId: adapter?.lastSourceMessageId ?? null,
      ingestionLatencyMs: adapter?.ingestionLatencyMs ?? null,
      // The poll fallback's own liveness, reported separately from the push
      // fields above -- see gramjs-client.ts pollOnce() for why this exists:
      // push delivery can silently stall while reporting connected: true.
      lastPollAt: adapter?.lastPollAtMs ? new Date(adapter.lastPollAtMs).toISOString() : null,
      lastPollError: adapter?.lastPollError ?? null,
      lastError: this.lastError,
    };
  }
}
