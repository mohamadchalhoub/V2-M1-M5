/**
 * Reconciling xauusd-sar-v1's records against broker reality.
 *
 * Two jobs:
 *
 * 1. **UNKNOWN resolution.** A submission whose broker answer was lost is
 *    resolved against a fresh, complete, connected broker snapshot. Broker
 *    truth is established two ways, never one:
 *      - POSITION PRESENCE is authoritative and immediate. Whether the
 *        ticket this attempt was closing (a REVERSAL) still appears in the
 *        live position list settles, with no propagation delay, whether that
 *        close actually happened.
 *      - Deals explain WHAT happened (a fill price, a close reason), but are
 *        never the sole basis for concluding a position is open or closed --
 *        a broker's own auto-close (TP/SL/backstop) does not reliably carry
 *        the original order's comment onto the closing deal (see the
 *        magic-vs-comment note below), so matching by comment alone would
 *        silently miss exactly the case that matters most: the position
 *        closed by something OTHER than the reversal this code sent.
 *
 *    See `resolveUnknown` for the full case matrix (A/B/C/D).
 *
 * 2. **Foreign exposure awareness.** Every position on this account, filtered
 *    by magic. `SAR_MAGIC` positions are this strategy's own — everything
 *    else (legacy RSI, Engine B, anything else) is reported for the dashboard
 *    and NEVER touched, adopted, relabelled or closed.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isOwnedBySar } from './ownership';
import {
  SAR_RECONCILE_MAX_SNAPSHOT_AGE_SECONDS,
  SAR_RECONCILE_MIN_AGE_SECONDS,
  SAR_RECONCILE_UNCLAIMED_GRACE_SECONDS,
  SAR_UNCLAIMED_REVERSAL_ALERT_THRESHOLD_SECONDS,
  sarOrderComment,
} from './safety-constants';
import { openInitialCycle, openReversalCycle, resolveUnknownAsFlat, type SarSessionState } from './state-machine';
import { sarCatastrophicBackstopMessage, sarDailyClosedMessage, sarReconciliationIncidentMessage, sarRecoveryRequiredMessage, sarReversalExecutionDelayMessage } from './notifications';
import { TelegramEngineNotificationService } from '../telegram-engine/notifications/notification.service';

export interface BrokerPositionLite {
  readonly ticket: string;
  readonly magicNumber: number | null;
  readonly comment: string | null;
}

export interface BrokerDealLite {
  readonly ticket: string;
  /** The POSITION this deal belongs to -- never the deal's own ticket. Null only for legacy callers that predate this field. */
  readonly positionId: string | null;
  readonly magicNumber: number | null;
  readonly comment: string | null;
  readonly entry: 'IN' | 'OUT' | 'INOUT' | 'OUT_BY';
  readonly price: number;
}

export interface SarReconcileInput {
  readonly accountId: string;
  readonly nowMs: number;
  readonly snapshotAtMs: number;
  readonly snapshotComplete: boolean;
  /** Whether the collector's MT5 terminal was actually connected when this snapshot was taken. */
  readonly mt5Connected: boolean;
  readonly positions: readonly BrokerPositionLite[];
  readonly deals: readonly BrokerDealLite[];
}

export interface SarReconcileOutcome {
  readonly resolved: boolean;
  readonly detail: string;
  readonly foreignSarMagicPositions: readonly string[];
}

function toSessionState(row: {
  sessionDate: string;
  state: string;
  sessionReference: unknown;
  initialBuyTrigger: unknown;
  initialSellTrigger: unknown;
  referenceCapturedAt: Date | null;
  cycleId: string | null;
  direction: 'BUY' | 'SELL' | null;
  entryFillPrice: unknown;
  extremeSinceEntry: unknown;
  reversalLevel: unknown;
  brokerTicket: string | null;
}): SarSessionState {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    sessionDate: row.sessionDate,
    state: row.state as SarSessionState['state'],
    sessionReference: num(row.sessionReference),
    initialBuyTrigger: num(row.initialBuyTrigger),
    initialSellTrigger: num(row.initialSellTrigger),
    referenceCapturedAtMs: row.referenceCapturedAt?.getTime() ?? null,
    cycleId: row.cycleId,
    direction: row.direction,
    entryFillPrice: num(row.entryFillPrice),
    extremeSinceEntry: num(row.extremeSinceEntry),
    reversalLevel: num(row.reversalLevel),
    brokerTicket: row.brokerTicket,
  };
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
    if (row && row.state === 'DAILY_CLOSE_PENDING_CONFIRMATION') {
      return this.confirmDailyCloseFlat(input, row);
    }
    if (!row || row.state !== 'REVERSAL_UNKNOWN') {
      return this.detectOrphanAndReport(input, row);
    }

    const pending = await this.prisma.xauusdSarOrderAttempt.findFirst({
      where: { accountId: input.accountId, status: { in: ['PENDING', 'SENT'] } },
      orderBy: { requestedAt: 'desc' },
    });
    if (!pending) {
      return { resolved: false, detail: 'session is UNKNOWN but no pending order attempt exists — needs an operator.', foreignSarMagicPositions: [] };
    }

    // Freshness/authority gate, unconditional. A stale, incomplete, or
    // disconnected snapshot is never used to resolve an UNKNOWN — this
    // guards every case below, not just one branch of it.
    const ageSeconds = (input.nowMs - input.snapshotAtMs) / 1000;
    if (!input.snapshotComplete) {
      return { resolved: false, detail: 'snapshot incomplete; cannot reconcile.', foreignSarMagicPositions: [] };
    }
    if (!input.mt5Connected) {
      return { resolved: false, detail: 'collector reports MT5 disconnected; snapshot is not authoritative.', foreignSarMagicPositions: [] };
    }
    if (ageSeconds < 0 || ageSeconds > SAR_RECONCILE_MAX_SNAPSHOT_AGE_SECONDS) {
      return { resolved: false, detail: `snapshot is ${ageSeconds.toFixed(1)}s old (or from the future); too stale to use.`, foreignSarMagicPositions: [] };
    }

    const sarPositions = input.positions.filter((p) => isOwnedBySar(p.magicNumber));
    const foreign = input.positions.filter((p) => !isOwnedBySar(p.magicNumber));

    // A second position under this strategy's own magic is a data defect
    // this code has never seen and must never guess through — it would mean
    // either a duplicate submission slipped past the idempotency guard, or a
    // ticket was misattributed. Refuse and demand a human look.
    if (sarPositions.length > 1) {
      const detail = `${sarPositions.length} positions carry SAR's own magic (${sarPositions.map((p) => p.ticket).join(', ')}); refusing to guess which is real.`;
      this.escalate(input.accountId, pending.id, detail);
      return { resolved: false, detail, foreignSarMagicPositions: foreign.map((p) => p.ticket) };
    }

    const closingTicket = pending.kind === 'REVERSAL' || pending.kind === 'FLATTEN' ? row.brokerTicket : null;
    const oldStillOpen = closingTicket !== null && sarPositions.some((p) => p.ticket === closingTicket);

    const expectedComment = sarOrderComment(pending.idempotencyTag);
    const newFillDeal = input.deals.find(
      (d) => d.comment === expectedComment && (d.entry === 'IN' || d.entry === 'INOUT') && isOwnedBySar(d.magicNumber) && d.positionId,
    );
    const oldExitDeal = closingTicket
      ? input.deals.find(
          (d) => d.positionId === closingTicket && (d.entry === 'OUT' || d.entry === 'OUT_BY' || d.entry === 'INOUT') && isOwnedBySar(d.magicNumber),
        )
      : undefined;

    // Case D: contradictory. The old ticket is confirmed both still open
    // AND a brand new fill also landed under this attempt's own tag. Two
    // real positions cannot both be true here for a single-position
    // strategy — never guess which broker fact is stale.
    if (oldStillOpen && newFillDeal) {
      const detail = `contradictory: ${closingTicket} is still open AND a new fill (${newFillDeal.positionId}) matches this attempt's tag.`;
      this.escalate(input.accountId, pending.id, detail);
      return { resolved: false, detail, foreignSarMagicPositions: foreign.map((p) => p.ticket) };
    }

    const session = toSessionState(row);

    // Case B: the new leg is confirmed filled (by idempotency tag, which
    // every order this code submits carries), regardless of whether the old
    // ticket's own closing deal was found — a lost acknowledgement on our
    // side does not mean the broker didn't act.
    if (newFillDeal) {
      const newTicket = newFillDeal.positionId!;
      const opened =
        pending.kind === 'INITIAL'
          ? openInitialCycle(session, pending.direction, newFillDeal.price, pending.cycleId, newTicket)
          : openReversalCycle(session, pending.direction, newFillDeal.price, pending.cycleId, newTicket);

      const writes: Prisma.PrismaPromise<unknown>[] = [
        this.prisma.xauusdSarSession.update({
          where: { accountId: input.accountId },
          data: {
            state: opened.state,
            cycleId: opened.cycleId,
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
          data: { status: 'FILLED', ticket: newTicket, fillPrice: newFillDeal.price, resolvedAt: new Date(input.nowMs) },
        }),
        this.prisma.xauusdSarCycle.create({
          data: {
            accountId: input.accountId,
            cycleId: pending.cycleId,
            direction: pending.direction,
            entryTicket: newTicket,
            entryFillPrice: newFillDeal.price,
            entryAt: new Date(input.nowMs),
          },
        }),
      ];
      if (closingTicket) {
        writes.push(
          this.prisma.xauusdSarCycle.updateMany({
            where: { accountId: input.accountId, entryTicket: closingTicket, exitAt: null },
            data: {
              exitTicket: closingTicket,
              exitFillPrice: oldExitDeal?.price ?? null,
              exitAt: new Date(input.nowMs),
              exitReason: 'RECONCILED_REVERSAL',
            },
          }),
        );
      }
      await this.prisma.$transaction(writes);
      this.logger.warn(`xauusd-sar: UNKNOWN resolved as FILLED (${newTicket}) by idempotency tag ${pending.idempotencyTag} (case B).`);
      return { resolved: true, detail: `resolved FILLED via reconciled deal, new ticket ${newTicket}`, foreignSarMagicPositions: foreign.map((p) => p.ticket) };
    }

    // Fix 4 (2026-09-25 incident repair): the age check is now anchored
    // differently depending on whether the collector has even CLAIMED this
    // attempt yet -- "never claimed" (claimedAt === null) means the
    // collector's own pending-order poll hasn't tried at all, which is a
    // materially weaker signal than "claimed and the close didn't
    // complete." Confirmed production incident, 2026-09-24: a REVERSAL sat
    // unclaimed for its entire ~9.5s life (the collector's MT5 lock was
    // held by unrelated observation work the whole time) and reconciliation
    // concluded FAILED using the OLD requestedAt-anchored 10s gate --
    // killing a reversal that had never even had its first execution
    // attempt. This is not "increase an arbitrary timeout": it is anchoring
    // the SAME 10s fair-chance window to when the collector actually
    // started trying (claimedAt), and giving a genuinely different,
    // distinctly-reasoned grace period (SAR_RECONCILE_UNCLAIMED_GRACE_SECONDS,
    // anchored to requestedAt) to the case where it hasn't tried yet.
    const hasFairOpportunityElapsed = (() => {
      if (pending.claimedAt !== null) {
        const claimedAgeSeconds = (input.nowMs - pending.claimedAt.getTime()) / 1000;
        return claimedAgeSeconds >= SAR_RECONCILE_MIN_AGE_SECONDS;
      }
      const requestAgeSeconds = (input.nowMs - pending.requestedAt.getTime()) / 1000;
      return requestAgeSeconds >= SAR_RECONCILE_UNCLAIMED_GRACE_SECONDS;
    })();
    const ageDetail = pending.claimedAt !== null
      ? `claimed ${((input.nowMs - pending.claimedAt.getTime()) / 1000).toFixed(1)}s ago`
      : `still unclaimed, requested ${((input.nowMs - pending.requestedAt.getTime()) / 1000).toFixed(1)}s ago`;

    // Observability only (2026-09-25 hardening pass, requirement 2): fires
    // once per attempt (deduplicated durably on the attempt id, never on a
    // per-pass key) once a REVERSAL has sat unclaimed for an abnormal
    // duration. Purely informational -- computed and dispatched BEFORE any
    // decision below, and does not itself gate, delay, or alter anything
    // that follows. `.catch()` guarantees a delivery failure can never
    // affect reconciliation's own outcome.
    if (pending.kind === 'REVERSAL' && pending.claimedAt === null) {
      const unclaimedAgeSeconds = (input.nowMs - pending.requestedAt.getTime()) / 1000;
      if (unclaimedAgeSeconds >= SAR_UNCLAIMED_REVERSAL_ALERT_THRESHOLD_SECONDS) {
        void this.notifier.notify(
          'SAR_EXECUTION_DELAY',
          `sar:reversal-execution-delay:${pending.id}`,
          sarReversalExecutionDelayMessage({ attemptId: pending.id, ageSeconds: unclaimedAgeSeconds }),
          'OPS',
        ).catch(() => undefined);
      }
    }

    // Case A: this was a REVERSAL, its own new fill was not found, but the
    // ticket it was trying to close is confirmed STILL open. The close (and
    // therefore the whole reversal) never completed -- resume managing the
    // existing position exactly as before the attempt, unchanged.
    //
    // Without this gate, reconciliation could observe "still open" and
    // revert the session the instant a reversal was claimed -- before the
    // collector's own poll ever had a chance to attempt the close at all
    // (claimed case), or before it had even been claimed at all (unclaimed
    // case). Confirmed live, 2026-09-24: attempts resolved as Case A in as
    // little as 148ms (claimed case) and via a blind requestedAt-only gate
    // while never claimed at all (the second incident this fix closes),
    // producing FAILED attempts the collector's own logs never even show
    // because reconciliation killed them first.
    if (oldStillOpen && !hasFairOpportunityElapsed) {
      return {
        resolved: false,
        detail: `${closingTicket} still open; attempt ${ageDetail} -- giving the collector's own execution poll a fair chance before concluding anything.`,
        foreignSarMagicPositions: foreign.map((p) => p.ticket),
      };
    }

    if (oldStillOpen) {
      await this.prisma.$transaction([
        this.prisma.xauusdSarSession.update({
          where: { accountId: input.accountId },
          data: { state: row.direction === 'BUY' ? 'ACTIVE_BUY' : 'ACTIVE_SELL', unknownSince: null },
        }),
        this.prisma.xauusdSarOrderAttempt.update({
          where: { id: pending.id },
          data: { status: 'FAILED', failureReason: 'reconciled: closing ticket is still open at the broker; reversal never completed', resolvedAt: new Date(input.nowMs) },
        }),
      ]);
      this.logger.warn(`xauusd-sar: UNKNOWN resolved — ${closingTicket} still open, resuming management (case A).`);
      return { resolved: true, detail: `resolved: ${closingTicket} still open, resumed`, foreignSarMagicPositions: foreign.map((p) => p.ticket) };
    }

    // Below this point: no new fill was found under this attempt's tag, and
    // (for a REVERSAL) the old ticket is confirmed gone. Absence is only
    // conclusive once the attempt has had the same claimed/unclaimed-aware
    // fair opportunity as Case A above.
    if (!hasFairOpportunityElapsed) {
      return { resolved: false, detail: `attempt ${ageDetail}; too soon to conclude absence.`, foreignSarMagicPositions: foreign.map((p) => p.ticket) };
    }

    if (closingTicket) {
      // Case C: the old position is gone and no new one appeared under our
      // tag — flat. Use the old ticket's own exit deal for the record when
      // the broker has one; its absence (deal history not yet visible, or
      // outside the lookback window) does not change the one broker fact
      // that IS unambiguous here — the account is flat — so the cycle is
      // still closed, only its exit price is left unrecorded rather than
      // guessed.
      const closedCycle = await this.prisma.xauusdSarCycle.findFirst({
        where: { accountId: input.accountId, entryTicket: closingTicket, exitAt: null },
      });
      // A FLATTEN's own ticket confirmed gone means the daily close is
      // genuinely done -- DAILY_CLOSED, not WAIT_INITIAL_DIRECTION (which
      // would let a fresh session start same-day, defeating "no new
      // exposure after close"). This is independent broker verification
      // (the position list, checked above), same standard
      // confirmDailyCloseFlat() applies for the more common QUEUED path.
      const resumed = pending.kind === 'FLATTEN' ? { ...resolveUnknownAsFlat(session), state: 'DAILY_CLOSED' as const } : resolveUnknownAsFlat(session);
      const attemptStatus = pending.kind === 'FLATTEN' ? 'FILLED' : 'FAILED';
      await this.prisma.$transaction([
        this.prisma.xauusdSarSession.update({
          where: { accountId: input.accountId },
          data: {
            state: resumed.state,
            cycleId: null,
            direction: null,
            entryFillPrice: null,
            extremeSinceEntry: null,
            reversalLevel: null,
            brokerTicket: null,
            unknownSince: null,
          },
        }),
        this.prisma.xauusdSarOrderAttempt.update({
          where: { id: pending.id },
          data: {
            status: attemptStatus,
            ticket: pending.kind === 'FLATTEN' ? closingTicket : undefined,
            fillPrice: pending.kind === 'FLATTEN' ? oldExitDeal?.price ?? null : undefined,
            failureReason:
              pending.kind === 'FLATTEN'
                ? null
                : oldExitDeal
                  ? `reconciled: ${closingTicket} closed at ${oldExitDeal.price} (broker deal, not this attempt's own reversal), no new position opened`
                  : `reconciled: ${closingTicket} is gone from the broker's position list, but no matching exit deal was found in the lookback window; exit price left unrecorded`,
            resolvedAt: new Date(input.nowMs),
          },
        }),
        ...(closedCycle
          ? [
              this.prisma.xauusdSarCycle.update({
                where: { id: closedCycle.id },
                data: {
                  exitTicket: closingTicket,
                  exitFillPrice: oldExitDeal?.price ?? null,
                  exitAt: new Date(input.nowMs),
                  exitReason: oldExitDeal ? 'RECONCILED_BROKER_CLOSE' : 'RECONCILED_UNCONFIRMED_EXIT',
                },
              }),
            ]
          : []),
      ]);
      if (!oldExitDeal) {
        void this.notifier.notify(
          'SAR_RECONCILIATION_INCIDENT',
          `sar:reconciliation-unconfirmed-exit:${input.accountId}:${pending.id}`,
          sarReconciliationIncidentMessage({ detail: `${closingTicket} closed with no matching deal found; exit price unrecorded, review manually.` }),
          'OPS',
        );
      } else if (!oldExitDeal.comment?.startsWith('sar-') && closedCycle) {
        // A SAR position carries exactly one bracket -- the wide
        // catastrophic $10 backstop -- and never any other SL/TP. An OUT
        // deal whose comment does NOT carry our own "sar-" order-comment
        // prefix (the broker's own auto-close comment, e.g. "[sl ...]" or
        // "[tp ...]") can therefore only mean that backstop fired, which
        // means the real $0.50 reversal pipeline failed to act for as long
        // as it took price to travel the full $10 -- a strategy execution
        // failure, never an ordinary SAR trade.
        await this.recordCatastrophicIncident(input.accountId, closedCycle, oldExitDeal, row, input.nowMs);
      }
      if (pending.kind === 'FLATTEN') {
        void this.notifier.notify(
          'SAR_EVENT',
          `sar:daily-closed:${input.accountId}:${row.sessionDate}`,
          sarDailyClosedMessage({ sessionDate: row.sessionDate }),
          'TRADING',
        ).catch(() => undefined);
        this.logger.warn(`xauusd-sar: daily close CONFIRMED FLAT via reconciliation (${closingTicket} gone) — DAILY_CLOSED.`);
        return { resolved: true, detail: `daily close confirmed flat; ${closingTicket} confirmed gone; DAILY_CLOSED`, foreignSarMagicPositions: foreign.map((p) => p.ticket) };
      }
      this.logger.warn(`xauusd-sar: UNKNOWN resolved as FLAT (${closingTicket} gone) (case C).`);
      return { resolved: true, detail: `resolved as flat; ${closingTicket} confirmed gone`, foreignSarMagicPositions: foreign.map((p) => p.ticket) };
    }

    // Case: an INITIAL attempt with no fill found anywhere and no old
    // position to worry about — it never reached the broker.
    await this.prisma.$transaction([
      this.prisma.xauusdSarSession.update({ where: { accountId: input.accountId }, data: { state: 'WAIT_INITIAL_DIRECTION', unknownSince: null } }),
      this.prisma.xauusdSarOrderAttempt.update({
        where: { id: pending.id },
        data: { status: 'FAILED', failureReason: 'reconciled: not found in a complete broker snapshot; never reached the broker', resolvedAt: new Date(input.nowMs) },
      }),
    ]);
    this.logger.warn(`xauusd-sar: UNKNOWN resolved as never-sent (${pending.idempotencyTag}).`);
    return { resolved: true, detail: 'resolved as never-sent; reverted to WAIT_INITIAL_DIRECTION', foreignSarMagicPositions: foreign.map((p) => p.ticket) };
  }

  /**
   * Durable record + high-severity alert for a confirmed catastrophic-
   * backstop closure. `thresholdWasPreviouslyCrossed` is computed directly
   * from the exit price against the LAST KNOWN reversal level -- never
   * inferred from timing alone -- so the record is honest about whether
   * this was a stalled pipeline (the common case) or a genuine gap event.
   */
  private async recordCatastrophicIncident(
    accountId: string,
    closedCycle: { id: string; cycleId: string; direction: 'BUY' | 'SELL'; entryTicket: string; entryFillPrice: Prisma.Decimal; entryAt: Date },
    exitDeal: BrokerDealLite,
    sessionRow: {
      extremeSinceEntry: Prisma.Decimal | null;
      reversalLevel: Prisma.Decimal | null;
      lastEvaluatedAt: Date | null;
    },
    nowMs: number,
  ): Promise<void> {
    const entryFillPrice = Number(closedCycle.entryFillPrice);
    const reversalLevel = sessionRow.reversalLevel ? Number(sessionRow.reversalLevel) : null;
    const thresholdWasPreviouslyCrossed =
      reversalLevel === null
        ? false
        : closedCycle.direction === 'BUY'
          ? exitDeal.price <= reversalLevel
          : exitDeal.price >= reversalLevel;
    const volumeAttempt = await this.prisma.xauusdSarOrderAttempt.findFirst({
      where: { accountId, ticket: closedCycle.entryTicket },
      select: { volume: true },
    });

    await this.prisma.xauusdSarCatastrophicIncident.create({
      data: {
        accountId,
        cycleId: closedCycle.cycleId,
        direction: closedCycle.direction,
        entryTicket: closedCycle.entryTicket,
        entryFillPrice,
        entryAt: closedCycle.entryAt,
        exitFillPrice: exitDeal.price,
        exitAt: new Date(nowMs),
        lastKnownExtreme: sessionRow.extremeSinceEntry,
        lastKnownReversalLevel: sessionRow.reversalLevel,
        lastEvaluatedAt: sessionRow.lastEvaluatedAt,
        thresholdWasPreviouslyCrossed,
        adverseDistanceUsd: Math.abs(exitDeal.price - entryFillPrice),
        volumeLots: volumeAttempt?.volume ?? null,
      },
    });

    this.logger.error(
      `xauusd-sar: CATASTROPHIC BACKSTOP ACTIVATED — ${closedCycle.entryTicket} ${closedCycle.direction}, entry ${entryFillPrice}, exit ${exitDeal.price}.`,
    );
    void this.notifier.notify(
      'SAR_CATASTROPHIC_BACKSTOP',
      `sar:catastrophic-backstop:${accountId}:${closedCycle.cycleId}`,
      sarCatastrophicBackstopMessage({
        ticket: closedCycle.entryTicket,
        cycleId: closedCycle.cycleId,
        direction: closedCycle.direction,
        entryFillPrice,
        exitFillPrice: exitDeal.price,
        adverseDistanceUsd: Math.abs(exitDeal.price - entryFillPrice),
        lastKnownExtreme: sessionRow.extremeSinceEntry ? Number(sessionRow.extremeSinceEntry) : null,
        lastKnownReversalLevel: reversalLevel,
        lastEvaluatedAt: sessionRow.lastEvaluatedAt?.toISOString() ?? null,
        thresholdWasPreviouslyCrossed,
        volumeLots: volumeAttempt ? Number(volumeAttempt.volume) : null,
      }),
      'OPS',
    );
  }

  /**
   * 2026-09-25 hardening pass, requirement 1: a FLATTEN's own close-order
   * acknowledgment (FILLED) is NOT sufficient on its own to declare the
   * day closed. The session sits in DAILY_CLOSE_PENDING_CONFIRMATION,
   * still carrying the ticket that was closed, until THIS method
   * independently confirms — from a fresh, complete, connected broker
   * snapshot — that zero SAR-magic positions remain. Only then does it
   * transition to DAILY_CLOSED and clear ownership fields.
   *
   * Three fail-closed outcomes, all leaving the session exactly where it
   * was (never guessing flat, never silently clearing ownership):
   *   - snapshot incomplete/disconnected/stale: defer, try again next pass.
   *   - the SAME ticket that was closed is still in the broker's SAR-magic
   *     position list: the close may not have actually taken (or the
   *     snapshot simply hasn't caught up yet) -- defer, do NOT escalate to
   *     RECOVERY_REQUIRED merely for this, since it is not yet
   *     contradictory (a slightly stale snapshot showing the pre-close
   *     state is expected, not alarming, on the very next pass or two).
   *   - a DIFFERENT/unexpected SAR-magic position exists: genuinely
   *     contradictory -- this cannot be explained by snapshot staleness
   *     alone, so it goes to RECOVERY_REQUIRED rather than being guessed
   *     through.
   */
  private async confirmDailyCloseFlat(
    input: SarReconcileInput,
    row: { sessionDate: string; brokerTicket: string | null },
  ): Promise<SarReconcileOutcome> {
    const foreign = input.positions.filter((p) => !isOwnedBySar(p.magicNumber));

    if (!input.snapshotComplete || !input.mt5Connected) {
      return {
        resolved: false,
        detail: 'daily close: snapshot incomplete or MT5 disconnected; cannot confirm flat yet.',
        foreignSarMagicPositions: foreign.map((p) => p.ticket),
      };
    }
    const ageSeconds = (input.nowMs - input.snapshotAtMs) / 1000;
    if (ageSeconds < 0 || ageSeconds > SAR_RECONCILE_MAX_SNAPSHOT_AGE_SECONDS) {
      return {
        resolved: false,
        detail: `daily close: snapshot is ${ageSeconds.toFixed(1)}s old (or from the future); too stale to confirm flat.`,
        foreignSarMagicPositions: foreign.map((p) => p.ticket),
      };
    }

    const sarPositions = input.positions.filter((p) => isOwnedBySar(p.magicNumber));

    if (sarPositions.length === 0) {
      await this.prisma.xauusdSarSession.update({
        where: { accountId: input.accountId },
        data: {
          state: 'DAILY_CLOSED',
          cycleId: null, direction: null, entryFillPrice: null,
          extremeSinceEntry: null, reversalLevel: null, brokerTicket: null, unknownSince: null,
        },
      });
      void this.notifier.notify(
        'SAR_EVENT',
        `sar:daily-closed:${input.accountId}:${row.sessionDate}`,
        sarDailyClosedMessage({ sessionDate: row.sessionDate }),
        'TRADING',
      ).catch(() => undefined);
      this.logger.warn('xauusd-sar: daily close CONFIRMED FLAT (zero SAR-magic positions) — DAILY_CLOSED.');
      return { resolved: true, detail: 'daily close confirmed flat; DAILY_CLOSED', foreignSarMagicPositions: foreign.map((p) => p.ticket) };
    }

    if (sarPositions.some((p) => p.ticket === row.brokerTicket)) {
      return {
        resolved: false,
        detail: `daily close: broker still shows the closed ticket ${row.brokerTicket}; not yet confirmed flat, deferring.`,
        foreignSarMagicPositions: foreign.map((p) => p.ticket),
      };
    }

    // A different/unexpected SAR-magic position -- cannot be explained by
    // ordinary snapshot lag. Never guessed through.
    const detail = `daily close: contradictory SAR-magic position(s) [${sarPositions.map((p) => p.ticket).join(', ')}] found after closing ${row.brokerTicket} -- ownership cannot be trusted.`;
    await this.prisma.xauusdSarSession.update({
      where: { accountId: input.accountId },
      data: { state: 'RECOVERY_REQUIRED', unknownSince: null },
    });
    this.logger.error(`xauusd-sar: RECOVERY_REQUIRED — ${detail}`);
    void this.notifier.notify(
      'SAR_RECOVERY_REQUIRED',
      `sar:recovery-required:${input.accountId}`,
      sarRecoveryRequiredMessage({ detail }),
      'OPS',
    ).catch(() => undefined);
    return { resolved: false, detail, foreignSarMagicPositions: foreign.map((p) => p.ticket) };
  }

  private escalate(accountId: string, attemptId: string, detail: string): void {
    void this.notifier.notify(
      'SAR_RECONCILIATION_INCIDENT',
      `sar:reconciliation-contradiction:${accountId}:${attemptId}`,
      sarReconciliationIncidentMessage({ detail }),
      'OPS',
    );
  }

  /**
   * Orphan/mismatch detection (Fix 2, 2026-09-25 incident repair): runs on
   * every reconcile pass where the session ISN'T mid-resolution
   * (REVERSAL_UNKNOWN, handled separately above). Confirmed production gap
   * this closes: an orphaned SAR-magic broker position was previously
   * invisible here, because `sarPositions` (magic-262610220 positions) were
   * only ever reported as "foreign" when they did NOT carry SAR's own
   * magic -- a genuinely-SAR-owned-magic position the session doesn't know
   * about was simply never inspected while state was e.g.
   * WAIT_INITIAL_DIRECTION.
   *
   * Two mismatch shapes, both routed to RECOVERY_REQUIRED (never guessed
   * through, never auto-adopted):
   *   - session believes it owns nothing (a WAIT_ state or DAILY_CLOSED,
   *     no brokerTicket) but a SAR-magic position exists at the broker --
   *     an orphan.
   *   - session believes it owns ticket X (ACTIVE_BUY/ACTIVE_SELL) but the
   *     broker's SAR-magic position list does not contain X -- ownership
   *     no longer matches broker truth.
   *
   * Only acts on a snapshot that is itself trustworthy (complete + MT5
   * connected) -- an incomplete/disconnected snapshot proves nothing and
   * must never trigger a state transition, per the same authority
   * discipline every other branch in this file already follows.
   */
  private async detectOrphanAndReport(
    input: SarReconcileInput,
    row: { state: string; brokerTicket: string | null } | null,
  ): Promise<SarReconcileOutcome> {
    const sarPositions = input.positions.filter((p) => isOwnedBySar(p.magicNumber));
    const foreign = input.positions.filter((p) => !isOwnedBySar(p.magicNumber));

    if (row && row.state !== 'RECOVERY_REQUIRED' && input.snapshotComplete && input.mt5Connected) {
      const ownsAPosition = row.state === 'ACTIVE_BUY' || row.state === 'ACTIVE_SELL';
      const mismatch = ownsAPosition
        ? !sarPositions.some((p) => p.ticket === row.brokerTicket)
        : sarPositions.length > 0;

      if (mismatch) {
        const detail = ownsAPosition
          ? `session expected open ticket ${row.brokerTicket}, broker's SAR-magic positions are [${sarPositions.map((p) => p.ticket).join(', ')}] — ownership mismatch`
          : `session believes it owns no position (state ${row.state}), but broker shows SAR-magic position(s) [${sarPositions.map((p) => p.ticket).join(', ')}] — orphaned position`;
        await this.prisma.xauusdSarSession.update({
          where: { accountId: input.accountId },
          data: { state: 'RECOVERY_REQUIRED', unknownSince: null },
        });
        this.logger.error(`xauusd-sar: RECOVERY_REQUIRED — ${detail}`);
        void this.notifier.notify(
          'SAR_RECOVERY_REQUIRED',
          `sar:recovery-required:${input.accountId}`,
          sarRecoveryRequiredMessage({ detail }),
          'OPS',
        );
        return { resolved: false, detail, foreignSarMagicPositions: foreign.map((p) => p.ticket) };
      }
    }

    return { resolved: false, detail: 'no UNKNOWN to resolve.', foreignSarMagicPositions: foreign.map((p) => p.ticket) };
  }
}
