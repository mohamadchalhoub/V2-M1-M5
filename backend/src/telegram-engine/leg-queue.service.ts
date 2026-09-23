/**
 * The queue between Engine B and the collector.
 *
 * As with Engine A, there is no separate queue table: a leg row at `PENDING`
 * IS an order waiting to be placed, and the collector's poll claims it. One
 * row, one lifecycle, one audit trail — a second place where an order can
 * exist is the thing that makes post-crash reconciliation impossible to
 * reason about.
 *
 * ## Claiming is an UPDATE guarded on the state, never a SELECT
 *
 * Two collector passes polling at the same instant see the same candidate
 * leg; only one `updateMany` matches, and the loser gets nothing rather than
 * a second order. A SELECT followed by an unguarded UPDATE places the same
 * trade twice, and for Engine B it would do so under a magic number that
 * legitimately holds several positions — so the duplicate would not even look
 * anomalous at the broker.
 *
 * ## Why the 60-second rule is enforced HERE as well
 *
 * The leg was marked PENDING when the engine decided to send it. Time then
 * passes: the collector's poll interval, the HTTP round trip, the MT5 lock.
 * Every one of those can push a leg past its lifetime after the engine's own
 * check passed. So the claim re-measures the age from the ORIGINAL
 * publication timestamp and CANCELS a leg that no longer qualifies rather
 * than skipping it — a skipped leg would sit at PENDING and be offered again
 * on the next poll, getting older each time.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { telegramEngineEnabled, telegramEntriesBlockedByControls } from './controls';
import { evaluateFreshness } from './freshness';
import { legOrderComment } from './idempotency';
import { TELEGRAM_SPEC } from './spec';
import { TelegramEngineNotificationService } from './notifications/notification.service';
import { protectionIncidentMessage, uncertainExecutionMessage } from './notifications/messages';

export interface ClaimableLeg {
  readonly legId: string;
  readonly signalId: string;
  readonly legIndex: number;
  readonly side: 'BUY' | 'SELL';
  readonly volume: number;
  readonly sourceEntry: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly magic: number;
  readonly symbol: string;
  readonly comment: string;
  readonly idempotencyTag: string;
  /** The ORIGINAL Telegram publication instant. The clock runs from here. */
  readonly publishedAt: string;
  readonly maxSignalAgeSeconds: number;
  /** The nearest target: the collector refuses if price has reached it. */
  readonly tp1: number;
}

export interface LegResultInput {
  readonly ok: boolean;
  readonly ticket: string | null;
  readonly filledPrice: number | null;
  readonly brokerStopLoss: number | null;
  readonly brokerTakeProfit: number | null;
  readonly errorMessage: string | null;
  /** The broker's answer was lost or ambiguous. Never flattened into FAILED. */
  readonly uncertain: boolean;
  /** The collector refused before calling the broker: provably opened nothing. */
  readonly notSent?: boolean;
  readonly submittedAt?: Date | null;
  readonly acknowledgedAt?: Date | null;
}

@Injectable()
export class TelegramLegQueueService {
  private readonly logger = new Logger(TelegramLegQueueService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    @Optional() private readonly notifier?: TelegramEngineNotificationService,
  ) {}

  /** Fire-and-forget: alerting is downstream of the record, never a gate. */
  private announce(eventType: string, dedupKey: string, text: string, audience: 'TRADING' | 'OPS' = 'TRADING'): void {
    void this.notifier?.notify(eventType, dedupKey, text, audience).catch(() => undefined);
  }

  /**
   * Claims the oldest sendable leg for this account, or returns null.
   *
   * Legs are offered oldest-first WITHIN a signal (by leg index), which keeps
   * a multi-target signal's legs in published order — so if the lifetime
   * expires mid-group it is the far target that is dropped, not an arbitrary
   * one.
   */
  async claimNext(accountId: string, nowMs: number): Promise<ClaimableLeg | null> {
    // The engine's own switch and the kill switches are re-read here, not
    // inherited from whatever they were when the leg was queued. An operator
    // who hits the kill switch expects the order in flight to stop, and this
    // is the last place that can still honour it.
    const blocked = telegramEntriesBlockedByControls();
    if (blocked !== null) {
      await this.cancelAllPending(accountId, `TELEGRAM_CONTROL_BLOCKED: ${blocked}`);
      return null;
    }
    if (!telegramEngineEnabled()) {
      await this.cancelAllPending(accountId, 'TELEGRAM_ENGINE_DISABLED');
      return null;
    }

    const candidates = await this.prisma.telegramSignalLeg.findMany({
      where: { orderStatus: 'PENDING', claimedAt: null, signal: { accountId } },
      orderBy: [{ signal: { publishedAt: 'asc' } }, { legIndex: 'asc' }],
      include: { signal: true },
      take: 10,
    });

    for (const leg of candidates) {
      const signal = leg.signal;

      // --- The hard lifetime, re-measured from publication at the moment of
      // the claim. A leg that has aged out is CANCELLED, not skipped.
      const freshness = evaluateFreshness(signal.publishedAt.getTime(), nowMs);
      if (!freshness.fresh) {
        await this.cancelLeg(leg.id, 'TELEGRAM_SIGNAL_EXPIRED', Math.round(freshness.ageMs));
        continue;
      }

      // --- The signal may have been spent while this leg waited: price
      // reached the first target between the engine's decision and now. The
      // latch is authoritative and is checked again here, because this is the
      // last point before the order leaves the application.
      if (signal.tp1Touched) {
        await this.cancelLeg(leg.id, 'TELEGRAM_TP1_ALREADY_REACHED', Math.round(freshness.ageMs));
        continue;
      }

      // Claim it. Guarded on the row still being unclaimed and PENDING, so a
      // second concurrent poll cannot also take it.
      const claimed = await this.prisma.telegramSignalLeg.updateMany({
        where: { id: leg.id, orderStatus: 'PENDING', claimedAt: null },
        data: { claimedAt: new Date(nowMs) },
      });
      if (claimed.count === 0) continue;

      return {
        legId: leg.id,
        signalId: leg.signalId,
        legIndex: leg.legIndex,
        side: leg.direction,
        volume: Number(leg.volumeLots),
        sourceEntry: Number(leg.sourceEntry),
        // The SOURCE levels, exactly as published. The collector attaches
        // these absolute prices and never recomputes a distance from them:
        // this is a copy engine, and the published stop IS the trade.
        stopLoss: Number(leg.stopLoss),
        takeProfit: Number(leg.takeProfit),
        magic: leg.magicNumber,
        symbol: signal.symbol,
        comment: legOrderComment(leg.idempotencyTag, leg.legIndex),
        idempotencyTag: leg.idempotencyTag,
        publishedAt: signal.publishedAt.toISOString(),
        maxSignalAgeSeconds: TELEGRAM_SPEC.maxSignalAgeMs / 1000,
        tp1: signal.tp1 === null ? Number(leg.takeProfit) : Number(signal.tp1),
      };
    }
    return null;
  }

  /**
   * Records what the broker actually did.
   *
   * The three outcomes are never collapsed:
   *
   *   notSent    refused before the broker was called. Provably opened
   *              nothing, so the leg is closed out as SKIPPED.
   *   uncertain  the call happened, or may have, and the answer was lost. It
   *              MAY be a live position, so it is UNKNOWN and the group stays
   *              held until reconciliation sees broker state.
   *   ok / not   the broker answered.
   */
  async recordResult(legId: string, input: LegResultInput): Promise<string> {
    const leg = await this.prisma.telegramSignalLeg.findUnique({ where: { id: legId }, include: { signal: true } });
    if (!leg) return 'UNKNOWN_LEG';

    const status = input.notSent ? 'SKIPPED' : input.uncertain ? 'UNKNOWN' : input.ok ? 'FILLED' : 'FAILED';

    const submittedAt = input.submittedAt ?? leg.submittedAt;
    const acknowledgedAt = input.acknowledgedAt ?? null;

    await this.prisma.telegramSignalLeg.update({
      where: { id: legId },
      data: {
        orderStatus: status,
        ticket: input.ticket ? BigInt(input.ticket) : leg.ticket,
        fillPrice: input.filledPrice ?? leg.fillPrice,
        brokerStopLoss: input.brokerStopLoss ?? leg.brokerStopLoss,
        brokerTakeProfit: input.brokerTakeProfit ?? leg.brokerTakeProfit,
        failureReason: input.errorMessage ?? leg.failureReason,
        skipReason: input.notSent ? (input.errorMessage ?? 'refused at the collector final check') : leg.skipReason,
        submittedAt,
        acknowledgedAt,
        submissionToBrokerAckMs:
          submittedAt && acknowledgedAt ? Math.max(0, acknowledgedAt.getTime() - submittedAt.getTime()) : leg.submissionToBrokerAckMs,
        filledAt: status === 'FILLED' ? (acknowledgedAt ?? new Date()) : leg.filledAt,
        // Protection is VERIFIED, not assumed. A fill whose broker-side SL/TP
        // came back absent or wrong is a protection incident and is recorded
        // as one rather than as a clean trade.
        ...this.protectionFields(status, leg, input),
      },
    });

    if (status === 'FILLED') {
      this.logger.log(`telegram leg ${leg.legIndex} of ${leg.signalId} FILLED, ticket ${input.ticket}`);
      // A fill whose protection could not be verified is an incident, and is
      // announced as one rather than folded into the execution summary where
      // it would read as an ordinary successful trade.
      const fields = this.protectionFields(status, leg, input) as { protectionIncident?: string | null };
      if (fields.protectionIncident) {
        this.announce(
          'PROTECTION_INCIDENT',
          `telegram:protection:${leg.id}`,
          protectionIncidentMessage({
            messageId: leg.signal.messageId,
            legIndex: leg.legIndex,
            ticket: input.ticket,
            detail: fields.protectionIncident,
          }),
          'OPS',
        );
      }
    } else if (status === 'UNKNOWN') {
      this.logger.error(
        `telegram leg ${leg.legIndex} of ${leg.signalId} is UNKNOWN: the broker may hold this position. ` +
          'Reconciliation must resolve it; the signal group stays held until it does.',
      );
      this.announce(
        'EXECUTION_UNKNOWN',
        `telegram:unknown:${leg.id}`,
        uncertainExecutionMessage({
          messageId: leg.signal.messageId,
          legIndex: leg.legIndex,
          detail: input.errorMessage ?? 'The broker response was lost or ambiguous.',
        }),
        'OPS',
      );
    }

    await this.releaseGroupIfSettled(leg.signal.accountId, leg.signalId);
    return status;
  }

  /**
   * Whether the fill is actually protected at the broker.
   *
   * A filled entry with no verifiable stop is the worst state this engine can
   * be in — an open position with unbounded loss — so it is named explicitly
   * rather than left to be inferred from two null columns.
   */
  private protectionFields(status: string, leg: { stopLoss: unknown; takeProfit: unknown }, input: LegResultInput) {
    if (status !== 'FILLED') return {};
    const expectedSl = Number(leg.stopLoss);
    const expectedTp = Number(leg.takeProfit);
    const sl = input.brokerStopLoss;
    const tp = input.brokerTakeProfit;

    if (sl === null || tp === null) {
      return {
        protectionIncident:
          'The broker did not report a stop loss and take profit for this filled leg, so protection could not be ' +
          'verified. This is NOT a clean trade: the position may be unprotected and needs an operator.',
      };
    }
    // One tick of tolerance: brokers round protective levels to their own
    // tick size, and that adjustment is not a missing stop.
    const tolerance = 0.05;
    if (Math.abs(sl - expectedSl) > tolerance || Math.abs(tp - expectedTp) > tolerance) {
      return {
        protectionVerifiedAt: new Date(),
        protectionIncident:
          `Broker protection (SL ${sl}, TP ${tp}) does not match the published levels (SL ${expectedSl}, ` +
          `TP ${expectedTp}). The levels were NOT widened by this engine; an operator should establish why.`,
      };
    }
    return { protectionVerifiedAt: new Date(), protectionIncident: null };
  }

  /**
   * Releases the signal group once no leg can still become a position.
   *
   * PENDING and UNKNOWN both keep it held: the first may still be sent, the
   * second may already be live. Only when every leg is FILLED, FAILED or
   * SKIPPED is the outcome settled — and a FILLED leg keeps the group held
   * too, because the group represents an active Telegram trade.
   */
  private async releaseGroupIfSettled(accountId: string | null, signalId: string): Promise<void> {
    if (!accountId) return;
    const live = await this.prisma.telegramSignalLeg.count({
      where: { signalId, orderStatus: { in: ['PENDING', 'UNKNOWN', 'FILLED'] } },
    });
    if (live > 0) return;
    await this.prisma.telegramSignalGroupLock.deleteMany({ where: { accountId, signalId } });
  }

  private async cancelLeg(legId: string, reason: string, ageMs: number): Promise<void> {
    await this.prisma.telegramSignalLeg.updateMany({
      where: { id: legId, orderStatus: 'PENDING' },
      data: { orderStatus: 'SKIPPED', skipReason: reason, ageAtSubmissionMs: ageMs, publicationToSubmissionMs: ageMs },
    });
    this.logger.warn(`telegram leg ${legId} cancelled at claim time: ${reason}`);
  }

  private async cancelAllPending(accountId: string, reason: string): Promise<void> {
    const cancelled = await this.prisma.telegramSignalLeg.updateMany({
      where: { orderStatus: 'PENDING', signal: { accountId } },
      data: { orderStatus: 'SKIPPED', skipReason: reason },
    });
    if (cancelled.count > 0) {
      this.logger.warn(`cancelled ${cancelled.count} pending telegram leg(s): ${reason}`);
    }
  }
}
