/**
 * What an operator can see about Engine B.
 *
 * Presented as its own section with its own route, and every row labelled
 * `TELEGRAM` — never merged into Engine A's M1/M5 view. The two engines hold
 * positions in one account, and an operator looking at a list of open gold
 * trades needs to know which system will manage each one, because that
 * decides who closes it and on what rule.
 *
 * ## What is deliberately absent
 *
 * The API hash, the phone number in unmasked form, any login code, the 2FA
 * password and the session string. `session-store.ts` is the only code that
 * touches those, and the only thing it will say about them is whether a
 * session exists and whether its file permissions are right. There is no code
 * path from this controller to that material, which is a stronger guarantee
 * than remembering not to include it.
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardTokenGuard } from '../auth/dashboard-token.guard';
import {
  configuredMaxAdverseEntryDeviationUsd,
  getTelegramExecutionMode,
  globalKillSwitchState,
  telegramEngineEnabled,
  telegramKillSwitchState,
} from './controls';
import { summariseSession } from './ingestion/session-store';
import { TELEGRAM_MAGIC } from './safety-constants';
import { TELEGRAM_ENGINE_VERSION, TELEGRAM_SPEC } from './spec';

@Controller('xauusd-m1m5/telegram-engine')
@UseGuards(DashboardTokenGuard)
export class TelegramDashboardController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  @Get('status')
  async status(@Query('accountId') queryAccountId?: string) {
    // Single-account deployment: if the caller does not supply one (the
    // dashboard page does not track a separate account concept), resolve
    // the same account xauusd-m1m5's own dashboard uses. Without this,
    // reconciliation and signal history silently defaulted to "no account",
    // which reported a real recoveryComplete as false.
    const accountId =
      queryAccountId ?? (await this.prisma.tradingAccount.findFirst({ orderBy: { createdAt: 'asc' } }))?.id ?? undefined;
    const session = summariseSession();
    const recon = accountId
      ? await this.prisma.telegramReconciliationState.findUnique({ where: { accountId } })
      : null;

    const lastIngested = await this.prisma.telegramIngestedMessage.findFirst({
      orderBy: { receivedAt: 'desc' },
    });

    // The telegram-ingest process's own push/poll liveness. Read from the
    // database because that process is a SEPARATE container from this one —
    // see TelegramIngestionHealth's schema comment for why a live in-memory
    // read is not possible here.
    const ingestionHealth = accountId
      ? await this.prisma.telegramIngestionHealth.findUnique({ where: { accountId } })
      : null;

    const recentSignals = await this.prisma.telegramSignal.findMany({
      where: accountId ? { accountId } : {},
      orderBy: { publishedAt: 'desc' },
      take: 20,
      include: { legs: { orderBy: { legIndex: 'asc' } } },
    });

    const legStats = await this.prisma.telegramSignalLeg.groupBy({
      by: ['orderStatus'],
      _count: { _all: true },
      where: accountId ? { signal: { accountId } } : {},
    });

    // Wins and losses are counted only from legs whose closure was
    // established from complete broker evidence. A leg that is merely absent
    // from a snapshot contributes to neither, which is why "unresolved" is
    // reported rather than folded into one of them.
    const closed = await this.prisma.telegramSignalLeg.findMany({
      where: { closureComplete: true, realizedPl: { not: null }, ...(accountId ? { signal: { accountId } } : {}) },
      select: { realizedPl: true },
    });
    const wins = closed.filter((l) => Number(l.realizedPl) > 0).length;
    const losses = closed.filter((l) => Number(l.realizedPl) < 0).length;
    const breakeven = closed.filter((l) => Number(l.realizedPl) === 0).length;

    return {
      engine: {
        // Named so no dashboard reader can mistake which engine a row is
        // about. Engine A is reported by its own controller as M1/M5.
        label: 'TELEGRAM',
        version: TELEGRAM_ENGINE_VERSION,
        magicNumber: TELEGRAM_MAGIC,
        sourceChannel: `@${TELEGRAM_SPEC.sourceChannelUsername}`,
        executionMode: getTelegramExecutionMode(),
        engineEnabled: telegramEngineEnabled(),
        // Engine B's entry rules, stated so the dashboard is self-describing.
        rules: {
          lotsPerTakeProfit: TELEGRAM_SPEC.lotsPerTakeProfit,
          maxSignalAgeSeconds: TELEGRAM_SPEC.maxSignalAgeMs / 1000,
          maxAdverseEntryDeviationUsd: configuredMaxAdverseEntryDeviationUsd(),
          semanticDuplicateWindowMinutes: TELEGRAM_SPEC.semanticDuplicateWindowMs / 60_000,
          schedule:
            'No time-of-day pause. The RSI engine’s 14:00–19:00 and 23:30–01:00 Beirut pauses and its ' +
            'Friday cutoff apply to the RSI engine only.',
        },
        killSwitches: {
          telegram: telegramKillSwitchState().active,
          global: globalKillSwitchState().active,
        },
      },
      ingestion: {
        telegramAuthorized: session.present,
        sourceChannelResolved: session.sourceChannelId !== null,
        sourceChannel: session.sourceChannelTitle,
        sourceChannelId: session.sourceChannelId,
        account: session.accountLabel,
        authorizedAt: session.authorizedAtMs ? new Date(session.authorizedAtMs).toISOString() : null,
        sessionPermissionsOk: session.permissionsOk,
        lastSourceMessageAt: lastIngested?.receivedAt.toISOString() ?? null,
        lastSourceMessageId: lastIngested?.messageId ?? null,
        lastIngestionLatencyMs: lastIngested?.publicationToIngestionMs ?? null,
      },
      // The telegram-ingest process's own reported liveness, as of its last
      // heartbeat write. `updatedAt` is the staleness signal: a snapshot that
      // stopped being refreshed looks, on its own, identical to one still
      // being refreshed with nothing new to report — always show it next to
      // the other fields here, never let the row's mere existence imply
      // "current".
      ingestionHealth: {
        present: ingestionHealth !== null,
        authorized: ingestionHealth?.authorized ?? null,
        connected: ingestionHealth?.connected ?? null,
        pushLastUpdateAt: ingestionHealth?.pushLastUpdateAt?.toISOString() ?? null,
        pollLastAt: ingestionHealth?.pollLastAt?.toISOString() ?? null,
        pollLastError: ingestionHealth?.pollLastError ?? null,
        updatedAt: ingestionHealth?.updatedAt?.toISOString() ?? null,
      },
      // The single most recent message the source channel published,
      // WHETHER OR NOT it became a trading signal — distinct from `signals`
      // below, which lists only structured trade records. This is what lets
      // an operator see "the channel is alive and the parser correctly
      // ignored that" without it polluting the trading history.
      lastMessage: lastIngested
        ? {
            messageId: lastIngested.messageId,
            publishedAt: lastIngested.publishedAt.toISOString(),
            receivedAt: lastIngested.receivedAt.toISOString(),
            publicationToIngestionMs: lastIngested.publicationToIngestionMs,
            classification: lastIngested.classification,
            // The parser's own ParseRefusal code (parser.ts) — null when the
            // message WAS a valid signal, or when it predates this column.
            refusalReason: lastIngested.refusalReason,
            deliveryPath: lastIngested.deliveryPath,
            textPreview: lastIngested.textPreview,
          }
        : null,
      reconciliation: {
        recoveryComplete: recon?.recoveryComplete ?? false,
        lastCompletedAt: recon?.lastCompletedAt?.toISOString() ?? null,
        brokerSnapshotAt: recon?.brokerSnapshotAt?.toISOString() ?? null,
        unresolvedLegs: recon?.unresolvedLegs ?? null,
        detail: recon?.detail ?? 'No reconciliation pass has run. Engine B cannot execute until one has.',
      },
      results: {
        wins,
        losses,
        breakeven,
        legsByStatus: Object.fromEntries(legStats.map((s) => [s.orderStatus, s._count._all])),
      },
      signals: recentSignals.map((signal) => ({
        id: signal.id,
        messageId: signal.messageId,
        direction: signal.direction,
        sourceEntry: signal.entry === null ? null : Number(signal.entry),
        stopLoss: signal.stopLoss === null ? null : Number(signal.stopLoss),
        takeProfits: signal.takeProfits.map((tp) => Number(tp)),
        tp1: signal.tp1 === null ? null : Number(signal.tp1),
        tp1Touched: signal.tp1Touched,
        tp1TouchedAt: signal.tp1TouchedAt?.toISOString() ?? null,
        tp1TouchPrice: signal.tp1TouchPrice === null ? null : Number(signal.tp1TouchPrice),
        publishedAt: signal.publishedAt.toISOString(),
        receivedAt: signal.receivedAt.toISOString(),
        ageAtDecisionMs: signal.publicationToDecisionMs,
        latency: {
          publicationToIngestionMs: signal.publicationToIngestionMs,
          ingestionToParseMs: signal.ingestionToParseMs,
          parseToDecisionMs: signal.parseToDecisionMs,
          publicationToDecisionMs: signal.publicationToDecisionMs,
        },
        outcome: signal.outcome,
        detail: signal.detail,
        executablePrice: signal.executablePrice === null ? null : Number(signal.executablePrice),
        // Signed: negative means the market was BETTER than published, which
        // is accepted rather than refused.
        deviationUsd: signal.deviationUsd === null ? null : Number(signal.deviationUsd),
        favourableEntry: signal.favourableEntry,
        // The fingerprint that makes a repost under a new message id
        // recognisable as the same trade.
        fingerprint: signal.semanticKey,
        parserVersion: signal.parserVersion,
        editVersion: signal.editVersion,
        lastEditedAt: signal.lastEditedAt?.toISOString() ?? null,
        legs: signal.legs.map((leg) => ({
          legIndex: leg.legIndex,
          volumeLots: Number(leg.volumeLots),
          takeProfit: Number(leg.takeProfit),
          stopLoss: Number(leg.stopLoss),
          status: leg.orderStatus,
          skipReason: leg.skipReason,
          ticket: leg.ticket === null ? null : String(leg.ticket),
          fillPrice: leg.fillPrice === null ? null : Number(leg.fillPrice),
          ageAtSubmissionMs: leg.ageAtSubmissionMs,
          publicationToSubmissionMs: leg.publicationToSubmissionMs,
          submissionToBrokerAckMs: leg.submissionToBrokerAckMs,
          protectionIncident: leg.protectionIncident,
          closureComplete: leg.closureComplete,
          realizedPl: leg.realizedPl === null ? null : Number(leg.realizedPl),
        })),
      })),
    };
  }

  /**
   * The raw ingestion log: what the channel published and how fast it
   * arrived, including messages that were not trade instructions.
   *
   * This is what SHADOW validation is read from — it is the only place that
   * shows the parser correctly ignoring ordinary conversation, which a table
   * of signals by definition cannot.
   */
  @Get('ingestion-log')
  async ingestionLog(@Query('limit') limit?: string) {
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = await this.prisma.telegramIngestedMessage.findMany({
      orderBy: { receivedAt: 'desc' },
      take,
    });
    return {
      messages: rows.map((row) => ({
        messageId: row.messageId,
        publishedAt: row.publishedAt.toISOString(),
        receivedAt: row.receivedAt.toISOString(),
        publicationToIngestionMs: row.publicationToIngestionMs,
        classification: row.classification,
        isEdit: row.isEdit,
        textPreview: row.textPreview,
      })),
    };
  }
}
