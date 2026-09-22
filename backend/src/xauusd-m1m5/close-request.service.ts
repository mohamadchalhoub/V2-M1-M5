/**
 * The close queue, and the `LiquidationBrokerPort` built on it.
 *
 * Same shape as the entry queue and for the same reason: the backend cannot
 * reach MetaTrader directly, so a close is a durable row the collector claims
 * and reports back on.
 *
 * ## Accepted is not closed
 *
 * `close()` returns `accepted` when the request is QUEUED, and the collector
 * later records whether the broker accepted it. Neither is closure. §9.3 is
 * explicit that a submitted close request proves nothing, and
 * `M1M5LiquidationService` accordingly establishes completion by re-querying
 * the broker and finding zero owned exposure — never by counting what it sent.
 * This file exists to make the sending possible; it makes no claim about the
 * result.
 *
 * ## Why a duplicate request is suppressed
 *
 * The liquidation service runs repeatedly between the Friday cutoff and the
 * deadline, and it re-plans from a fresh snapshot each pass. A position that
 * has not closed yet will therefore be planned again on the next pass, seconds
 * later. Without suppression that queues a second close for a position that
 * already has one in flight — and on a hedging account a duplicate close can
 * open an opposing position rather than doing nothing.
 *
 * So a ticket with a request already PENDING or SENT is not queued again. A
 * ticket whose request FAILED is, because a refused close that left the
 * position open must be retried.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { buildLiquidationItems } from './broker-snapshot';
import type { LiquidationBrokerPort } from './liquidation.service';
import type { BrokerItem, LiquidationTarget } from './liquidation';
import type { Timeframe } from './spec';

export interface CloseResultInput {
  readonly accepted: boolean;
  readonly errorMessage: string | null;
}

@Injectable()
export class M1M5CloseRequestService {
  private readonly logger = new Logger(M1M5CloseRequestService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  /** Queues a close, or reports that one is already in flight for this ticket. */
  async request(
    accountId: string,
    target: LiquidationTarget,
    reason: string,
  ): Promise<{ queued: boolean; detail: string }> {
    const inFlight = await this.prisma.xauusdM1M5CloseRequest.findFirst({
      where: { accountId, ticket: target.ticket, status: { in: ['PENDING', 'SENT'] } },
    });
    if (inFlight) {
      return { queued: false, detail: `a close request for ticket ${target.ticket} is already ${inFlight.status}` };
    }

    await this.prisma.xauusdM1M5CloseRequest.create({
      data: {
        accountId,
        ticket: target.ticket,
        kind: target.kind,
        magicNumber: target.magicNumber,
        timeframe: target.timeframe,
        volume: target.volume,
        reason,
      },
    });
    this.logger.warn(`close queued for ticket ${target.ticket} (${target.timeframe}, magic ${target.magicNumber}): ${reason}`);
    return { queued: true, detail: `close queued for ticket ${target.ticket}` };
  }

  /**
   * Claims the oldest queued close, or returns null.
   *
   * Guarded update, exactly as the entry queue does it: two collectors polling
   * together must not both send a close for the same ticket.
   */
  async claimOldest(accountId: string) {
    const candidate = await this.prisma.xauusdM1M5CloseRequest.findFirst({
      where: { accountId, status: 'PENDING' },
      orderBy: { requestedAt: 'asc' },
    });
    if (!candidate) return null;

    const claimed = await this.prisma.xauusdM1M5CloseRequest.updateMany({
      where: { id: candidate.id, status: 'PENDING' },
      data: { status: 'SENT', claimedAt: new Date() },
    });
    if (claimed.count === 0) return null;

    return this.prisma.xauusdM1M5CloseRequest.findUnique({ where: { id: candidate.id } });
  }

  /** Records what the broker said. Acceptance, not closure. */
  async recordResult(requestId: string, result: CloseResultInput): Promise<void> {
    await this.prisma.xauusdM1M5CloseRequest.update({
      where: { id: requestId },
      data: {
        status: result.accepted ? 'ACCEPTED' : 'FAILED',
        completedAt: new Date(),
        errorMessage: result.errorMessage,
      },
    });
  }
}

/**
 * The `LiquidationBrokerPort` the scheduler runs against.
 *
 * Bound to one account, because `LiquidationBrokerPort` has no account
 * parameter — the liquidation service is written against "the broker", and
 * this application trades exactly one account. Binding it here rather than
 * widening that interface keeps the service unable to reach an account it was
 * not pointed at.
 */
export class M1M5QueueingLiquidationBroker implements LiquidationBrokerPort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly closeRequests: M1M5CloseRequestService,
    private readonly accountId: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Null when the stored data is too stale for absence to mean absence. */
  async snapshot(): Promise<readonly BrokerItem[] | null> {
    return buildLiquidationItems(this.prisma, this.accountId, this.now());
  }

  async close(target: LiquidationTarget): Promise<{ accepted: boolean; error?: string }> {
    const result = await this.closeRequests.request(this.accountId, target, 'FRIDAY_LIQUIDATION');
    // A suppressed duplicate is reported as accepted: a close IS in flight for
    // this ticket, which is what the caller is asking about. Reporting it as a
    // failure would drive the retry/escalation path over a request that is
    // already doing exactly what was wanted.
    return { accepted: true, error: result.queued ? undefined : result.detail };
  }

  async cancel(target: LiquidationTarget): Promise<{ accepted: boolean; error?: string }> {
    // This strategy places market orders only, so it never has a pending order
    // to cancel. The path is implemented rather than left throwing, because a
    // planner that ever did hand one over must not crash the liquidation run.
    const result = await this.closeRequests.request(this.accountId, target, 'FRIDAY_LIQUIDATION_CANCEL');
    return { accepted: true, error: result.queued ? undefined : result.detail };
  }
}

/** Narrowing helper for the stored enum, kept next to its only consumer. */
export function timeframeOf(value: string): Timeframe {
  return value === 'M5' ? 'M5' : 'M1';
}
