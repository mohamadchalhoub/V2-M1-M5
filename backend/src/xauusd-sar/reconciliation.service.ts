/**
 * Reconciling xauusd-sar-v1's records against broker reality.
 *
 * Two jobs:
 *
 * 1. **UNKNOWN resolution.** A submission whose broker answer was lost is
 *    matched against the broker's own positions/deals by the idempotency tag
 *    carried in the order comment (same mechanism Engine B's legs use). Found
 *    -> the fill is real, open the cycle. Absent from a COMPLETE snapshot for
 *    long enough -> it never reached the broker, revert to the pre-attempt
 *    state. An INCOMPLETE snapshot resolves nothing, in either direction.
 *
 * 2. **Foreign exposure awareness.** Every position on this account, filtered
 *    by magic. `SAR_MAGIC` positions are this strategy's own — everything
 *    else (legacy RSI, Engine B, anything else) is reported for the dashboard
 *    and NEVER touched.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isOwnedBySar } from './ownership';
import { SAR_UNKNOWN_ESCALATION_SECONDS } from './safety-constants';
import { openInitialCycle, openReversalCycle, type SarSessionState } from './state-machine';
import { sarReconciliationIncidentMessage } from './notifications';
import { TelegramEngineNotificationService } from '../telegram-engine/notifications/notification.service';

export interface BrokerPositionLite {
  readonly ticket: string;
  readonly magicNumber: number | null;
  readonly comment: string | null;
}

export interface BrokerDealLite {
  readonly ticket: string;
  readonly magicNumber: number | null;
  readonly comment: string | null;
  readonly entry: 'IN' | 'OUT' | 'INOUT' | 'OUT_BY';
  readonly price: number;
}

export interface SarReconcileInput {
  readonly accountId: string;
  readonly nowMs: number;
  readonly snapshotComplete: boolean;
  readonly positions: readonly BrokerPositionLite[];
  readonly deals: readonly BrokerDealLite[];
}

export interface SarReconcileOutcome {
  readonly resolved: boolean;
  readonly detail: string;
  readonly foreignSarMagicPositions: readonly string[];
}

@Injectable()
export class SarReconciliationService {
  private readonly logger = new Logger(SarReconciliationService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    private readonly notifier: TelegramEngineNotificationService,
  ) {}

  async reconcile(input: SarReconcileInput): Promise<SarReconcileOutcome> {
    const row = await this.prisma.xauusdSarSession.findUnique({ where: { accountId: input.accountId } });
    if (!row || row.state !== 'REVERSAL_UNKNOWN') {
      return this.reportForeignExposureOnly(input);
    }

    const pending = await this.prisma.xauusdSarOrderAttempt.findFirst({
      where: { accountId: input.accountId, status: { in: ['PENDING', 'SENT'] } },
      orderBy: { requestedAt: 'desc' },
    });
    if (!pending) {
      return { resolved: false, detail: 'session is UNKNOWN but no pending order attempt exists — needs an operator.', foreignSarMagicPositions: [] };
    }

    // Match by the idempotency tag carried in the order comment.
    const matchedDeal = input.deals.find((d) => d.comment === pending.idempotencyTag && d.entry !== 'OUT');
    if (matchedDeal) {
      const cycleId = pending.cycleId;
      const session: SarSessionState = {
        sessionDate: row.sessionDate,
        state: row.state,
        sessionReference: row.sessionReference ? Number(row.sessionReference) : null,
        initialBuyTrigger: row.initialBuyTrigger ? Number(row.initialBuyTrigger) : null,
        initialSellTrigger: row.initialSellTrigger ? Number(row.initialSellTrigger) : null,
        referenceCapturedAtMs: row.referenceCapturedAt?.getTime() ?? null,
        cycleId: row.cycleId,
        direction: row.direction,
        entryFillPrice: row.entryFillPrice ? Number(row.entryFillPrice) : null,
        extremeSinceEntry: row.extremeSinceEntry ? Number(row.extremeSinceEntry) : null,
        reversalLevel: row.reversalLevel ? Number(row.reversalLevel) : null,
        brokerTicket: row.brokerTicket,
      };
      const opened =
        pending.kind === 'INITIAL'
          ? openInitialCycle(session, pending.direction, matchedDeal.price, cycleId, matchedDeal.ticket)
          : openReversalCycle(session, pending.direction, matchedDeal.price, cycleId, matchedDeal.ticket);
      await this.prisma.$transaction([
        this.prisma.xauusdSarSession.update({
          where: { accountId: input.accountId },
          data: {
            state: opened.state,
            direction: opened.direction,
            entryFillPrice: opened.entryFillPrice,
            extremeSinceEntry: opened.extremeSinceEntry,
            reversalLevel: opened.reversalLevel,
            brokerTicket: opened.brokerTicket,
            unknownSince: null,
          },
        }),
        this.prisma.xauusdSarOrderAttempt.update({
          where: { id: pending.id },
          data: { status: 'FILLED', ticket: matchedDeal.ticket, fillPrice: matchedDeal.price, resolvedAt: new Date(input.nowMs) },
        }),
      ]);
      this.logger.warn(`xauusd-sar: UNKNOWN resolved as FILLED (${matchedDeal.ticket}) by idempotency tag ${pending.idempotencyTag}.`);
      return { resolved: true, detail: `resolved FILLED via deal ${matchedDeal.ticket}`, foreignSarMagicPositions: [] };
    }

    if (!input.snapshotComplete) {
      return { resolved: false, detail: 'snapshot incomplete; absence is not evidence.', foreignSarMagicPositions: [] };
    }

    const ageSeconds = (input.nowMs - pending.requestedAt.getTime()) / 1000;
    if (ageSeconds < SAR_UNKNOWN_ESCALATION_SECONDS) {
      return { resolved: false, detail: `not yet old enough to conclude absence (${ageSeconds.toFixed(0)}s).`, foreignSarMagicPositions: [] };
    }

    // A COMPLETE snapshot, long enough after the attempt, with no matching
    // deal anywhere: the order never reached the broker. Revert to the state
    // before the attempt.
    const priorState = row.cycleId === null ? 'WAIT_INITIAL_DIRECTION' : row.direction === 'BUY' ? 'ACTIVE_BUY' : 'ACTIVE_SELL';
    await this.prisma.$transaction([
      this.prisma.xauusdSarSession.update({ where: { accountId: input.accountId }, data: { state: priorState, unknownSince: null } }),
      this.prisma.xauusdSarOrderAttempt.update({ where: { id: pending.id }, data: { status: 'FAILED', failureReason: 'not found in a complete broker snapshot after the escalation window', resolvedAt: new Date(input.nowMs) } }),
    ]);
    void this.notifier.notify(
      'SAR_RECONCILIATION_INCIDENT',
      `sar:reconciliation-incident:${input.accountId}:${pending.id}`,
      sarReconciliationIncidentMessage({ detail: `attempt ${pending.idempotencyTag} never reached the broker; reverted to ${priorState}.` }),
      'OPS',
    );
    return { resolved: true, detail: `resolved as never-sent; reverted to ${priorState}`, foreignSarMagicPositions: [] };
  }

  private async reportForeignExposureOnly(input: SarReconcileInput): Promise<SarReconcileOutcome> {
    const foreign = input.positions.filter((p) => !isOwnedBySar(p.magicNumber));
    return { resolved: false, detail: 'no UNKNOWN to resolve.', foreignSarMagicPositions: foreign.map((p) => p.ticket) };
  }
}
