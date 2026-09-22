/**
 * Protection remediation (§7): putting back a stop loss the broker did not keep.
 *
 * ## Why this is not paranoia
 *
 * A filled order is not proof that protection is attached. The broker confirms
 * a fill and can still report the position with no stop loss — a rejected
 * bracket, a level too close to market at the moment of execution, a partial
 * application. An unprotected gold position is the single most expensive state
 * this application can be in, and it is a state that looks completely normal
 * from the fill confirmation alone.
 *
 * So reconciliation re-reads what the broker actually holds, and anything
 * missing its levels comes here.
 *
 * ## The levels come from the decision, not from the market
 *
 * The stop is restored to where the ORIGINAL decision put it. Recomputing it
 * from the current price would quietly change the risk the trade was sized
 * for: a position 30 points underwater would have its stop moved 30 points
 * further away, turning a $5 risk into something else without anyone choosing
 * that.
 *
 * ## Accepted is not verified
 *
 * A broker accepting the modification is not proof the levels stuck. Nothing
 * here concludes the position is protected; the next reconciliation pass
 * re-reads it and queues another request if it still is not.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ProtectionIssue } from './reconciliation.service';
import { v2MagicForTimeframe } from './safety-constants';

export interface ProtectionResultInput {
  readonly accepted: boolean;
  readonly errorMessage: string | null;
}

@Injectable()
export class M1M5ProtectionService {
  private readonly logger = new Logger(M1M5ProtectionService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  /**
   * Queues remediation for everything reconciliation found unprotected.
   *
   * Returns how many were queued. A ticket with a request already in flight is
   * not queued again: reconciliation runs every cycle and would otherwise pile
   * up hundreds of identical repair requests for one position while the first
   * is still being sent.
   */
  async requestAll(accountId: string, issues: readonly ProtectionIssue[]): Promise<number> {
    let queued = 0;
    for (const issue of issues) {
      if (await this.request(accountId, issue)) queued += 1;
    }
    return queued;
  }

  private async request(accountId: string, issue: ProtectionIssue): Promise<boolean> {
    const inFlight = await this.prisma.xauusdM1M5ProtectionRequest.findFirst({
      where: { accountId, ticket: issue.ticket, status: { in: ['PENDING', 'SENT'] } },
    });
    if (inFlight) return false;

    // The decision that opened this position is where the levels come from.
    // Without it there is nothing to restore TO, and inventing levels from the
    // current price would be a different trade than the one risk approved.
    const decision = await this.prisma.xauusdM1M5Decision.findFirst({
      where: { accountId, ticket: BigInt(issue.ticket) },
      orderBy: { createdAt: 'desc' },
    });
    if (!decision?.stopLoss || !decision.takeProfit) {
      this.logger.error(
        `ticket ${issue.ticket} is missing ${issue.missing} but no decision records its intended levels. ` +
          'Remediation cannot run; this position needs manual attention.',
      );
      return false;
    }

    await this.prisma.xauusdM1M5ProtectionRequest.create({
      data: {
        accountId,
        ticket: issue.ticket,
        timeframe: issue.timeframe,
        magicNumber: decision.magicNumber ?? v2MagicForTimeframe(issue.timeframe),
        stopLoss: decision.stopLoss,
        takeProfit: decision.takeProfit,
        missing: issue.missing,
      },
    });
    this.logger.error(
      `PROTECTION REMEDIATION queued for ${issue.timeframe} ticket ${issue.ticket}: ${issue.missing} missing. ` +
        `Restoring SL ${decision.stopLoss} / TP ${decision.takeProfit} from the decision that opened it.`,
    );
    return true;
  }

  /** Claims the oldest queued repair. Guarded, as every claim here is. */
  async claimOldest(accountId: string) {
    const candidate = await this.prisma.xauusdM1M5ProtectionRequest.findFirst({
      where: { accountId, status: 'PENDING' },
      orderBy: { requestedAt: 'asc' },
    });
    if (!candidate) return null;

    const claimed = await this.prisma.xauusdM1M5ProtectionRequest.updateMany({
      where: { id: candidate.id, status: 'PENDING' },
      data: { status: 'SENT', claimedAt: new Date() },
    });
    if (claimed.count === 0) return null;

    return this.prisma.xauusdM1M5ProtectionRequest.findUnique({ where: { id: candidate.id } });
  }

  /** Records whether the broker accepted the modification. Not verification. */
  async recordResult(requestId: string, result: ProtectionResultInput): Promise<void> {
    await this.prisma.xauusdM1M5ProtectionRequest.update({
      where: { id: requestId },
      data: {
        status: result.accepted ? 'ACCEPTED' : 'FAILED',
        completedAt: new Date(),
        errorMessage: result.errorMessage,
      },
    });
  }
}
