/**
 * The order queue between the strategy and the collector.
 *
 * There is no separate queue table. The decision row **is** the queue: a row
 * at `PENDING` is an order waiting to be placed, and the collector's poll
 * claims it by moving it to `SENT`. That is deliberate — a separate queue
 * table would be a second place where an order can exist, and reconciling two
 * such places after a crash is exactly the class of problem this application
 * is built to avoid. One row, one lifecycle, one audit trail.
 *
 * ## Claiming is an UPDATE, not a SELECT
 *
 * `claimOldest` finds a candidate and then flips it with an `updateMany`
 * guarded on it still being `PENDING`. Two collectors polling at the same
 * instant both see the same candidate; only one update matches, and the loser
 * gets nothing rather than a duplicate order. A SELECT followed by an
 * unguarded UPDATE would place the same trade twice.
 *
 * ## Why the schedule is re-checked here
 *
 * Time passes between the strategy queueing an order and the collector
 * claiming it. The Friday cutoff, a scheduled pause or the kill switch may all
 * have arrived in that gap, and this row is already durable — so a claim that
 * is no longer allowed must explicitly CANCEL the row rather than skip it,
 * or it would sit at `PENDING` and be offered again on the next poll.
 *
 * The full pre-send check in `risk.ts` also compares the live quote against
 * the signal price. That belongs where a fresh quote is at hand; it has
 * already run before the row was queued, and it runs again in the collector
 * against the terminal's own tick. What is added here is the part that can
 * change purely with the passage of time.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient, type XauusdM1M5Decision } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { entriesBlockedByControls } from './controls';
import { M1M5OccupancyService } from './occupancy.service';
import { V2_MAX_SIGNAL_AGE_SECONDS } from './safety-constants';
import { evaluateClockSchedule } from './schedule';
import type { Timeframe } from './spec';

export interface ExecutionResultInput {
  readonly ok: boolean;
  readonly ticket: string | null;
  readonly filledPrice: number | null;
  readonly brokerStopLoss: number | null;
  readonly brokerTakeProfit: number | null;
  readonly errorMessage: string | null;
  /** True when the broker's answer was lost or ambiguous. Never FAILED. */
  readonly uncertain: boolean;
  /**
   * True when the COLLECTOR refused at its final check and never called the
   * broker. Distinct from FAILED, which means the broker refused: a not-sent
   * order provably opened nothing, so its slot is safe to free.
   */
  readonly notSent?: boolean;
  /** The execution timeline, as the collector measured it. See execution-latency.ts. */
  readonly executionEvaluatedAt?: Date | null;
  readonly submittedAt?: Date | null;
  readonly acknowledgedAt?: Date | null;
}

export type RecordedOutcome = 'FILLED' | 'FAILED' | 'UNKNOWN' | 'NOT_SENT' | 'IGNORED_UNCLAIMED';

@Injectable()
export class M1M5DecisionQueueService {
  private readonly logger = new Logger(M1M5DecisionQueueService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    private readonly occupancy: M1M5OccupancyService,
  ) {}

  /**
   * Claims the oldest queued order for this account, or returns null.
   *
   * Ordered by `observedAt` rather than `createdAt`: if two orders are ever
   * queued together, the one whose signal happened first is the one whose
   * price assumptions are closest to expiring.
   */
  async claimOldest(accountId: string, nowMs: number): Promise<XauusdM1M5Decision | null> {
    const candidate = await this.prisma.xauusdM1M5Decision.findFirst({
      where: { accountId, orderStatus: 'PENDING' },
      orderBy: { observedAt: 'asc' },
    });
    if (!candidate) return null;

    // Guarded update: the loser of a concurrent poll matches zero rows.
    const claimed = await this.prisma.xauusdM1M5Decision.updateMany({
      where: { id: candidate.id, orderStatus: 'PENDING' },
      data: { orderStatus: 'SENT' },
    });
    if (claimed.count === 0) return null;

    // --- Re-check what the passage of time can have changed. The row is
    // already claimed, so a refusal must cancel it, not merely decline it.
    const blockedByControls = entriesBlockedByControls();
    const clock = evaluateClockSchedule(nowMs);
    // Signal age too. With a one-second execution pass an order is normally
    // claimed within a second of being queued, but if the collector was down
    // it could otherwise be claimed minutes later -- and a stale intrabar
    // crossing is no longer the event the rules described (§9.2). The same
    // limit the pre-send check uses; the collector re-checks it at send.
    const signalAgeSeconds = (nowMs - candidate.observedAt.getTime()) / 1000;
    const tooOld =
      signalAgeSeconds > V2_MAX_SIGNAL_AGE_SECONDS
        ? `signal is ${signalAgeSeconds.toFixed(1)}s old, beyond the ${V2_MAX_SIGNAL_AGE_SECONDS}s limit`
        : null;
    const refusal = blockedByControls ?? tooOld ?? (clock.clockAllowsEntries ? null : clock.detail);
    if (refusal) {
      await this.cancelClaimed(candidate.id, `Cancelled at collector claim: ${refusal}`);
      this.logger.warn(`decision ${candidate.id}: cancelled at claim rather than sent -- ${refusal}`);
      return null;
    }

    return this.prisma.xauusdM1M5Decision.findUnique({ where: { id: candidate.id } });
  }

  /**
   * Cancels a claimed row that must not be sent after all, and frees its slot.
   *
   * Releasing here is safe precisely because this path is reached only BEFORE
   * the collector has touched the broker. Nothing was sent, so nothing can be
   * open, so a second entry on this timeframe is legitimate.
   */
  async cancelClaimed(decisionId: string, reason: string): Promise<void> {
    const row = await this.prisma.xauusdM1M5Decision.update({
      where: { id: decisionId },
      data: { orderStatus: 'NONE', approved: false, skipReason: reason, sentAt: null },
    });
    if (row.accountId) {
      await this.occupancy.releaseUnsent(row.accountId, row.timeframe as Timeframe, decisionId);
    }
  }

  /** The stored row, for narration that must quote what RISK approved. */
  async findDecision(decisionId: string) {
    return this.prisma.xauusdM1M5Decision.findUnique({ where: { id: decisionId } });
  }

  /**
   * Records what the broker actually did, and moves the slot to match.
   *
   * The three outcomes are genuinely different and are never collapsed:
   *
   *   FILLED  — broker-confirmed. The slot holds a real position.
   *   UNKNOWN — the answer was lost. It MAY be a real position, so the slot
   *             stays held until reconciliation sees broker state. This is the
   *             case a two-valued "ok" flag cannot express, which is why the
   *             collector sends `uncertain` separately from `ok`.
   *   FAILED  — broker-confirmed refusal. Only here is releasing the slot safe.
   */
  async recordResult(decisionId: string, result: ExecutionResultInput): Promise<RecordedOutcome> {
    const existing = await this.prisma.xauusdM1M5Decision.findUnique({ where: { id: decisionId } });
    if (!existing || existing.orderStatus !== 'SENT') {
      // A result for a row nobody claimed, or one already resolved. Recording
      // it would overwrite a settled outcome with a replayed one.
      this.logger.warn(
        `decision ${decisionId}: execution result ignored -- row is ` +
          `${existing ? existing.orderStatus : 'missing'}, not SENT.`,
      );
      return 'IGNORED_UNCLAIMED';
    }

    // Refused by the collector before the broker was ever called. The only
    // outcome besides a broker-confirmed refusal that provably opened nothing,
    // so the slot is released and the row cancelled -- not marked FAILED,
    // which would claim the broker said no.
    if (result.notSent && !result.uncertain) {
      await this.prisma.xauusdM1M5Decision.update({
        where: { id: decisionId },
        data: { executionEvaluatedAt: result.executionEvaluatedAt ?? null },
      });
      await this.cancelClaimed(decisionId, `Not sent at the collector's final check: ${result.errorMessage ?? 'no reason given'}`);
      return 'NOT_SENT';
    }

    const status: 'FILLED' | 'FAILED' | 'UNKNOWN' = result.uncertain ? 'UNKNOWN' : result.ok ? 'FILLED' : 'FAILED';

    await this.prisma.xauusdM1M5Decision.update({
      where: { id: decisionId },
      data: {
        orderStatus: status,
        ticket: result.ticket ? BigInt(result.ticket) : null,
        fillPrice: result.filledPrice,
        brokerStopLoss: result.brokerStopLoss,
        brokerTakeProfit: result.brokerTakeProfit,
        executionEvaluatedAt: result.executionEvaluatedAt ?? null,
        submittedAt: result.submittedAt ?? null,
        acknowledgedAt: result.acknowledgedAt ?? null,
        // The broker's acknowledgement when the collector measured it, rather
        // than whenever this report happened to arrive.
        filledAt: status === 'FILLED' ? (result.acknowledgedAt ?? new Date()) : null,
        failureReason: result.errorMessage,
      },
    });

    const accountId = existing.accountId;
    const timeframe = existing.timeframe as Timeframe;
    if (accountId) {
      if (status === 'FAILED') {
        await this.occupancy.releaseUnsent(accountId, timeframe, decisionId);
      } else {
        await this.occupancy.advance(accountId, timeframe, status);
      }
    }

    return status;
  }
}
