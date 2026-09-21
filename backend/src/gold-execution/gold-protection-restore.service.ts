import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GOLD_SYMBOL, GOLD_TP_SL_POINTS } from './gold-safety-constants';

export interface GoldProtectionRestoreResult {
  ok: boolean;
  errorMessage?: string | null;
}

/**
 * Task item 3, corrected a second time — the agreed policy is exactly ONE
 * restoration attempt, THEN verify actual broker protection via
 * reconciliation (the next real snapshot cycle), THEN close if still
 * unprotected. An earlier round of this session built a 3-attempt,
 * poll-cycle-backoff retry chain — that is a DIFFERENT policy than what was
 * agreed, not a refinement of it, and has been removed. This service now
 * only ever creates ONE `GoldProtectionRestoreRequest` per incident and
 * never queues a second attempt itself.
 *
 * "Ambiguous/uncertain broker responses handled through reconciliation, not
 * blind retries": this service deliberately does NOT branch the
 * close-fallback decision on the collector's own reported `ok`/error for
 * the modify attempt — that response only proves what the ONE order_send
 * call returned, not what the position's actual current SL/TP is. The real
 * decision (restored vs. still needs closing) is made by
 * `GoldProtectionMonitorService.checkOne` on the NEXT snapshot cycle,
 * reading the position's actual broker-reported `stopLoss`/`takeProfit` —
 * genuine reconciliation against live state, not a re-attempt driven by
 * this response alone.
 */
@Injectable()
export class GoldProtectionRestoreService {
  private readonly logger = new Logger(GoldProtectionRestoreService.name);

  constructor(private readonly prisma: PrismaService) {}

  async requestRestore(params: {
    accountId: string;
    positionTicket: string;
    side: 'BUY' | 'SELL';
    entryPrice: number;
    goldPointSize: number;
    /**
     * The protective distance, in USD of gold price, that THIS position's
     * owning strategy manages it at. Defaults to the retired H4 strategy's
     * $10 so an existing caller keeps its exact previous behaviour.
     *
     * Passing it explicitly is what lets one restore path serve two
     * strategies without ever changing an old position's protection to the
     * new strategy's $5 — which the migration spec (§10) forbids.
     */
    protectionUsd?: number;
  }): Promise<{ id: string }> {
    const { stopLoss, takeProfit } = computeFrozenProtection(params.side, params.entryPrice, params.goldPointSize, params.protectionUsd);
    const row = await this.prisma.goldProtectionRestoreRequest.create({
      data: {
        accountId: params.accountId,
        symbol: GOLD_SYMBOL,
        positionTicket: params.positionTicket,
        side: params.side,
        stopLoss,
        takeProfit,
        attemptNumber: 1,
        maxAttempts: 1,
      },
    });
    return { id: row.id };
  }

  async claimOldestPendingRequest(accountId: string) {
    const candidate = await this.prisma.goldProtectionRestoreRequest.findFirst({
      where: { accountId, status: 'PENDING' },
      orderBy: { requestedAt: 'asc' },
    });
    if (!candidate) return null;

    const claimed = await this.prisma.goldProtectionRestoreRequest.updateMany({
      where: { id: candidate.id, status: 'PENDING' },
      data: { status: 'SENT', sentAt: new Date() },
    });
    if (claimed.count === 0) return null;

    return candidate;
  }

  /**
   * Records the ONE attempt's outcome and stops — never queues another
   * attempt, never itself decides to close. Whether the position actually
   * ends up protected is determined separately, by reconciliation against
   * real broker data on the next snapshot cycle
   * (`GoldProtectionMonitorService.checkOne`).
   */
  async recordResult(requestId: string, result: GoldProtectionRestoreResult): Promise<void> {
    const request = await this.prisma.goldProtectionRestoreRequest.findUnique({ where: { id: requestId } });
    if (!request) {
      this.logger.error(`recordResult: no GoldProtectionRestoreRequest found for id=${requestId}`);
      return;
    }

    if (result.ok) {
      await this.prisma.goldProtectionRestoreRequest.update({
        where: { id: requestId },
        data: { status: 'RESTORED', restoredAt: new Date() },
      });
      this.logger.log(`gold protection restore ${requestId}: broker reported success (still subject to reconciliation on the next snapshot cycle)`);
    } else {
      await this.prisma.goldProtectionRestoreRequest.update({
        where: { id: requestId },
        data: { status: 'FAILED', resultError: result.errorMessage ?? null },
      });
      this.logger.warn(`gold protection restore ${requestId}: broker reported failure/ambiguous result (${result.errorMessage ?? 'no detail'}) — no retry queued; reconciliation on the next snapshot cycle will decide whether to close`);
    }
  }
}

/** Same formula as gold-execution-coordinator.service.ts's own bracket pricing — frozen distance, never a different one. */
export function computeFrozenProtection(
  side: 'BUY' | 'SELL',
  entryPrice: number,
  goldPointSize: number,
  /** USD price distance; defaults to the retired H4 strategy's $10. */
  protectionUsd?: number,
): { stopLoss: number; takeProfit: number } {
  const offset = protectionUsd !== undefined ? protectionUsd : GOLD_TP_SL_POINTS * goldPointSize;
  return side === 'BUY'
    ? { stopLoss: entryPrice - offset, takeProfit: entryPrice + offset }
    : { stopLoss: entryPrice + offset, takeProfit: entryPrice - offset };
}
