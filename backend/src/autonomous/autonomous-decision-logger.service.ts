import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AutonomousRuleDecision, SYMBOL } from './autonomous-rule-engine.service';
import { AutonomousAiEvaluationResult } from './autonomous-ai-decision.service';
import { RiskManagerVerdict } from './risk-manager';

/**
 * Plan §10's audit requirement: every decision — including HOLD — is
 * written, with the full inputs it was based on, so the causal chain can be
 * reconstructed later without guesswork.
 */
@Injectable()
export class AutonomousDecisionLoggerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Rules-only path (Phase 2/3, no AI involved at all) — unchanged from before Phase 4. */
  async log(decision: AutonomousRuleDecision, inputSnapshot: unknown): Promise<{ id: string }> {
    const row = await this.prisma.autonomousDecision.create({
      data: {
        symbol: decision.symbol,
        action: decision.action,
        source: 'RULES_ONLY',
        entryPrice: decision.entryPrice,
        stopLoss: decision.stopLoss,
        takeProfit: decision.takeProfit,
        levelUsed: decision.levelUsed,
        referenceWeekStart: decision.referenceWeekStart,
        reasoning: decision.reasoning,
        inputSnapshot: inputSnapshot as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return row;
  }

  /**
   * Phase 4/6 path — always source=AI_ASSISTED, even when the mechanical
   * engine's own decision was HOLD (the AI was never invoked in that case,
   * §13.1's "confirm/veto, never originate" design), so a reader can always
   * tell from `source` alone whether this row went through the AI layer at
   * all. The FINAL logged action/entry/SL/TP reflect the AI's validated
   * decision ONLY when the risk manager also approved it — an AI
   * confirmation the risk manager then rejects logs as a HOLD with
   * `riskManagerApproved=false`, never as if the trade had gone through.
   * `riskManager` is null when there was no confirmed trade for it to even
   * check (mechanical HOLD, AI veto, or AI-response rejection).
   */
  async logAiAssisted(
    mechanicalDecision: AutonomousRuleDecision,
    ai: AutonomousAiEvaluationResult,
    riskManager: RiskManagerVerdict | null,
    accountId: string | null,
    inputSnapshot: unknown,
  ): Promise<{ id: string }> {
    const aiConfirmedTrade = ai.aiDecision !== null && (ai.aiDecision.action === 'OPEN_BUY' || ai.aiDecision.action === 'OPEN_SELL');
    const finalTradeApproved = aiConfirmedTrade && (riskManager?.approved ?? false);

    const reasoning = finalTradeApproved
      ? ai.aiDecision!.reasoning
      : aiConfirmedTrade
        ? `Risk manager rejected the AI-confirmed trade: ${riskManager?.rejectionReason}. AI's own reasoning was: ${ai.aiDecision!.reasoning}`
        : ai.aiRejected
          ? `AI response rejected by validation: ${ai.aiRejectionReason}. Mechanical candidate was: ${mechanicalDecision.reasoning}`
          : ai.aiDecision
            ? `AI vetoed the mechanical candidate: ${ai.aiDecision.reasoning}`
            : mechanicalDecision.reasoning; // AI never invoked — mechanical engine itself said HOLD.

    const row = await this.prisma.autonomousDecision.create({
      data: {
        accountId,
        symbol: SYMBOL,
        action: finalTradeApproved ? ai.aiDecision!.action : 'HOLD',
        source: 'AI_ASSISTED',
        entryPrice: finalTradeApproved ? ai.aiDecision!.entryPrice : null,
        stopLoss: finalTradeApproved ? ai.aiDecision!.stopLoss : null,
        takeProfit: finalTradeApproved ? ai.aiDecision!.takeProfit : null,
        levelUsed: mechanicalDecision.levelUsed,
        referenceWeekStart: mechanicalDecision.referenceWeekStart,
        reasoning,
        inputSnapshot: inputSnapshot as Prisma.InputJsonValue,
        aiProvider: ai.aiProvider,
        aiModel: ai.aiModel,
        aiRawResponse: (ai.aiRawResponse ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        aiRejected: ai.aiRejected,
        aiRejectionReason: ai.aiRejectionReason,
        riskManagerApproved: aiConfirmedTrade ? (riskManager?.approved ?? false) : false,
        riskManagerRejectionReason: aiConfirmedTrade ? (riskManager?.rejectionReason ?? null) : null,
        orderStatus: finalTradeApproved ? 'PENDING' : 'NONE',
      },
      select: { id: true },
    });
    return row;
  }

  /**
   * Fetch-AND-claim in one step, not a plain read — the collector polls
   * this on an interval, and if a PENDING order were merely read (not
   * atomically flipped to SENT), a second poll before the first attempt's
   * result comes back would see the SAME order still PENDING and could
   * execute it twice. The `updateMany` with `orderStatus: 'PENDING'` in
   * its own WHERE clause is the atomic claim: it only ever matches (and
   * flips) a row that is STILL pending at the moment this runs, so two
   * concurrent callers can never both win.
   */
  /**
   * `symbol` is REQUIRED (not optional) since the gold strategy's decisions
   * live in this same table (symbol='XAUUSD') — without this filter, this
   * EURUSD-facing claim would also match and claim a gold PENDING row,
   * sending it to the collector as if it were a EURUSD order (wrong magic
   * number, wrong volume, wrong point size). Found and fixed while wiring
   * gold execution, before any gold PENDING row was ever created.
   */
  async claimOldestPendingOrder(accountId: string, symbol: string) {
    const candidate = await this.prisma.autonomousDecision.findFirst({
      where: { accountId, orderStatus: 'PENDING', symbol },
      orderBy: { evaluatedAt: 'asc' },
    });
    if (!candidate) return null;

    const claimed = await this.prisma.autonomousDecision.updateMany({
      where: { id: candidate.id, orderStatus: 'PENDING' },
      data: { orderStatus: 'SENT' },
    });
    if (claimed.count === 0) return null; // lost the race to another poll — extremely unlikely with one collector, still handled

    return candidate;
  }

  async recordExecutionResult(
    decisionId: string,
    result: { ok: boolean; ticket?: number | null; filledPrice?: number | null; errorMessage?: string | null },
  ): Promise<void> {
    await this.prisma.autonomousDecision.update({
      where: { id: decisionId },
      data: {
        orderStatus: result.ok ? 'FILLED' : 'FAILED',
        mt5Ticket: result.ticket ?? null,
        filledPrice: result.filledPrice ?? null,
        filledAt: result.ok ? new Date() : null,
        executionError: result.errorMessage ?? null,
      },
    });
  }
}
