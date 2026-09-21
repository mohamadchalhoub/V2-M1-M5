import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GOLD_SYMBOL } from './gold-safety-constants';

export interface GoldCloseResult {
  ok: boolean;
  dealTicket?: number | null;
  closedPrice?: number | null;
  errorMessage?: string | null;
}

/**
 * Task item 2 — "finish actual close-position execution." Backend half of
 * the request/reconciliation path symmetric to the existing open-order
 * poll: `GoldExecutionController` (open) claims PENDING AutonomousDecision
 * rows; this claims PENDING `GoldCloseRequest` rows the same way. Scoped to
 * ONE gold DEMO account + ONE specific position ticket per request — never
 * "close whatever is open." "closed" is set ONLY by `recordResult` when the
 * collector reports a broker-confirmed success (executor.py's
 * `close_position`, which itself only returns ok=true after a real MT5
 * `order_send()` success) — creating or claiming a request never marks
 * anything closed.
 */
@Injectable()
export class GoldCloseExecutionService {
  private readonly logger = new Logger(GoldCloseExecutionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the existing active (PENDING/SENT) request for this position if
   * one already exists (duplicate-request handling — the caller should
   * treat this as "already requested," not create a second one), otherwise
   * creates and returns a new PENDING request.
   */
  async requestClose(params: {
    accountId: string;
    positionTicket: string;
    side: 'BUY' | 'SELL';
    volume: number;
  }): Promise<{ request: { id: string; status: string }; duplicate: boolean }> {
    const existing = await this.prisma.goldCloseRequest.findFirst({
      where: { accountId: params.accountId, positionTicket: params.positionTicket, status: { in: ['PENDING', 'SENT'] } },
      orderBy: { requestedAt: 'desc' },
    });
    if (existing) {
      return { request: { id: existing.id, status: existing.status }, duplicate: true };
    }

    const row = await this.prisma.goldCloseRequest.create({
      data: {
        accountId: params.accountId,
        symbol: GOLD_SYMBOL,
        positionTicket: params.positionTicket,
        side: params.side,
        volume: params.volume,
      },
    });
    return { request: { id: row.id, status: row.status }, duplicate: false };
  }

  /** Atomic PENDING -> SENT claim — same race protection as `AutonomousDecisionLoggerService.claimOldestPendingOrder`. */
  async claimOldestPendingRequest(accountId: string) {
    const candidate = await this.prisma.goldCloseRequest.findFirst({
      where: { accountId, status: 'PENDING' },
      orderBy: { requestedAt: 'asc' },
    });
    if (!candidate) return null;

    const claimed = await this.prisma.goldCloseRequest.updateMany({
      where: { id: candidate.id, status: 'PENDING' },
      data: { status: 'SENT', sentAt: new Date() },
    });
    if (claimed.count === 0) return null; // lost the race to another poll

    return candidate;
  }

  /** The ONLY path that ever sets CLOSED — always driven by a collector-reported, broker-confirmed result. */
  async recordResult(requestId: string, result: GoldCloseResult): Promise<void> {
    await this.prisma.goldCloseRequest.update({
      where: { id: requestId },
      data: {
        status: result.ok ? 'CLOSED' : 'FAILED',
        resultDealTicket: result.dealTicket ?? null,
        resultClosedPrice: result.closedPrice ?? null,
        resultError: result.errorMessage ?? null,
        closedAt: result.ok ? new Date() : null,
      },
    });
    this.logger.log(`gold close request ${requestId}: ${result.ok ? 'CLOSED (broker-confirmed)' : 'FAILED'}${result.errorMessage ? ` — ${result.errorMessage}` : ''}`);
  }
}
