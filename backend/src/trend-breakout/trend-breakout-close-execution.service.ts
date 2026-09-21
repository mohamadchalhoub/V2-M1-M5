import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TrendBreakoutInstrumentId } from './instrument-config';
import { TrendBreakoutSlotLockService } from './slot-lock.service';

export interface TrendBreakoutCloseResult {
  ok: boolean;
  dealTicket?: number | null;
  closedPrice?: number | null;
  errorMessage?: string | null;
}

/**
 * Near-port of `../gold-execution/gold-close-execution.service.ts`,
 * parameterized by instrument. Backend half of the request/reconciliation
 * path symmetric to the open-order poll: `TrendBreakoutExecutionController`
 * (open) claims PENDING `TrendBreakoutDecision` rows via
 * `TrendBreakoutDecisionLoggerService.claimOldestPendingOrder`; this claims
 * PENDING `TrendBreakoutCloseRequest` rows the same way. Scoped to ONE
 * account + ONE instrument + ONE specific position ticket per request —
 * never "close whatever is open."
 *
 * Confirmed close is the ONLY path that releases the instrument's slot
 * lock (§3's exclusivity guard) — creating or claiming a close request
 * never releases it, only a collector-reported, broker-confirmed success
 * does (`recordResult` with `ok: true`).
 */
@Injectable()
export class TrendBreakoutCloseExecutionService {
  private readonly logger = new Logger(TrendBreakoutCloseExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly slotLock: TrendBreakoutSlotLockService,
  ) {}

  /**
   * Reads side/volume from the live `Position` row — NEVER from a request
   * body (the plan's own "never trust position side/volume from a request
   * body" rule) — the caller (the dashboard controller) is responsible for
   * having already looked up and validated that `Position` row belongs to
   * this account/instrument/ticket before calling this.
   */
  async requestClose(params: {
    accountId: string;
    instrument: TrendBreakoutInstrumentId;
    brokerSymbol: string;
    positionTicket: string;
    side: 'BUY' | 'SELL';
    volume: number;
  }): Promise<{ request: { id: string; status: string }; duplicate: boolean }> {
    const existing = await this.prisma.trendBreakoutCloseRequest.findFirst({
      where: { accountId: params.accountId, instrument: params.instrument, positionTicket: params.positionTicket, status: { in: ['PENDING', 'SENT'] } },
      orderBy: { requestedAt: 'desc' },
    });
    if (existing) {
      return { request: { id: existing.id, status: existing.status }, duplicate: true };
    }

    const row = await this.prisma.trendBreakoutCloseRequest.create({
      data: {
        accountId: params.accountId,
        instrument: params.instrument,
        symbol: params.brokerSymbol,
        positionTicket: params.positionTicket,
        side: params.side,
        volume: params.volume,
      },
    });
    return { request: { id: row.id, status: row.status }, duplicate: false };
  }

  /** Atomic PENDING -> SENT claim — same race protection as `TrendBreakoutDecisionLoggerService.claimOldestPendingOrder`, scoped to this instrument's own close requests. */
  async claimOldestPendingRequest(accountId: string, instrument: TrendBreakoutInstrumentId) {
    const candidate = await this.prisma.trendBreakoutCloseRequest.findFirst({
      where: { accountId, instrument, status: 'PENDING' },
      orderBy: { requestedAt: 'asc' },
    });
    if (!candidate) return null;

    const claimed = await this.prisma.trendBreakoutCloseRequest.updateMany({
      where: { id: candidate.id, status: 'PENDING' },
      data: { status: 'SENT', sentAt: new Date() },
    });
    if (claimed.count === 0) return null; // lost the race to another poll

    return candidate;
  }

  /**
   * The ONLY path that ever sets CLOSED and releases the slot — always
   * driven by a collector-reported, broker-confirmed result. On failure,
   * the request is marked FAILED but the slot lock is deliberately left in
   * place (the position may still be open) — never released on a failed or
   * ambiguous close.
   */
  async recordResult(requestId: string, result: TrendBreakoutCloseResult): Promise<void> {
    const request = await this.prisma.trendBreakoutCloseRequest.update({
      where: { id: requestId },
      data: {
        status: result.ok ? 'CLOSED' : 'FAILED',
        resultDealTicket: result.dealTicket ?? null,
        resultClosedPrice: result.closedPrice ?? null,
        resultError: result.errorMessage ?? null,
        closedAt: result.ok ? new Date() : null,
      },
    });
    this.logger.log(`trend-breakout close request ${requestId} (${request.instrument}): ${result.ok ? 'CLOSED (broker-confirmed)' : 'FAILED'}${result.errorMessage ? ` — ${result.errorMessage}` : ''}`);

    if (result.ok) {
      // Confirmed close — release the slot now, so a new entry for this
      // instrument can be evaluated again. Deliberately best-effort against
      // a lock that may already be gone (e.g. released by a prior reconciliation
      // path) — release() itself will throw on a missing row, so this is
      // guarded rather than left to crash the collector's report call.
      try {
        await this.slotLock.release(request.accountId, request.instrument as TrendBreakoutInstrumentId);
      } catch (err) {
        this.logger.warn(`trend-breakout close request ${requestId}: slot release failed (may already be released) — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
