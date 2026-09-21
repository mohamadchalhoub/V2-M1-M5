import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AutonomousAiDecisionService, AutonomousAiEvaluationResult } from './autonomous-ai-decision.service';
import { AutonomousDecisionLoggerService } from './autonomous-decision-logger.service';
import { AUTONOMOUS_RULES_CONFIG, AutonomousRulesConfig } from './autonomous-rules.config';
import { AutonomousEvaluationResult } from './autonomous-rule-engine.service';
import { isKillSwitchActive } from './kill-switch';
import { AccountTradeMode, evaluateRiskManager, RiskManagerAccountInfo, RiskManagerVerdict } from './risk-manager';

// Statuses that count as "used today" for the friend's one-order-per-day
// rule — a decision the risk manager itself rejected (orderStatus stays
// NONE) never consumed the day's slot; only a genuinely placed-or-placing
// order does.
const ORDER_STATUSES_COUNTING_TOWARD_DAILY_LIMIT = ['PENDING', 'SENT', 'FILLED'] as const;

export interface AutonomousExecutionResult {
  mechanical: AutonomousEvaluationResult;
  ai: AutonomousAiEvaluationResult;
  /** Null when no trade was confirmed to even check (mechanical HOLD, AI veto/rejection). */
  riskManager: RiskManagerVerdict | null;
  loggedDecisionId: string;
}

/**
 * Phase 6 — the layer that turns a confirmed AI decision into either a
 * PENDING order (for the collector's executor.py to pick up and place) or
 * a logged rejection, using REAL account state rather than synthetic
 * inputs: today's order count from this account's own decision history,
 * the file-based kill switch, and the account's own most recently pushed
 * trade_mode (AccountSnapshot — plan §1's TypeScript-side half of the
 * demo-account check; executor.py's own live `account_info()` check is
 * the other, authoritative half, immediately before any order).
 *
 * Deliberately has no scheduler of its own — nothing calls `run()` on a
 * timer yet. That is an intentional, separate decision: this system
 * should not go from "the code exists and is tested" to "runs
 * unsupervised" in the same step it was first wired together.
 */
@Injectable()
export class AutonomousExecutionCoordinatorService {
  constructor(
    private readonly aiDecision: AutonomousAiDecisionService,
    private readonly logger: AutonomousDecisionLoggerService,
    private readonly prisma: PrismaService,
    @Inject(AUTONOMOUS_RULES_CONFIG) private readonly config: AutonomousRulesConfig,
  ) {}

  async run(now: Date, accountId: string): Promise<AutonomousExecutionResult> {
    const ordersPlacedToday = await this.countOrdersPlacedToday(accountId, now);
    const { mechanical, ai } = await this.aiDecision.evaluate(now, ordersPlacedToday);

    const aiConfirmedTrade = ai.aiDecision !== null && (ai.aiDecision.action === 'OPEN_BUY' || ai.aiDecision.action === 'OPEN_SELL');

    let riskManager: RiskManagerVerdict | null = null;
    if (aiConfirmedTrade) {
      const accountInfo = await this.resolveAccountInfo(accountId);
      riskManager = evaluateRiskManager({
        decision: ai.aiDecision!,
        accountInfo,
        ordersPlacedToday,
        killSwitchActive: isKillSwitchActive(),
        config: this.config,
      });
    }

    const { id } = await this.logger.logAiAssisted(mechanical.decision, ai, riskManager, accountId, {
      now: now.toISOString(),
      mechanical,
      ai,
      riskManager,
      ordersPlacedToday,
    });

    return { mechanical, ai, riskManager, loggedDecisionId: id };
  }

  private async countOrdersPlacedToday(accountId: string, now: Date): Promise<number> {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return this.prisma.autonomousDecision.count({
      where: {
        accountId,
        evaluatedAt: { gte: dayStart },
        orderStatus: { in: [...ORDER_STATUSES_COUNTING_TOWARD_DAILY_LIMIT] },
      },
    });
  }

  /**
   * Fails closed: no snapshot, or a snapshot that never recorded
   * tradeMode (an older collector version, or one not yet updated), is
   * reported as REAL — never DEMO — so `evaluateRiskManager` rejects it
   * the same way it would reject an actual real-money account, rather
   * than silently treating "unknown" as "safe."
   */
  private async resolveAccountInfo(accountId: string): Promise<RiskManagerAccountInfo> {
    const snapshot = await this.prisma.accountSnapshot.findFirst({
      where: { accountId },
      orderBy: { capturedAt: 'desc' },
      select: { tradeMode: true },
    });
    const tradeMode: AccountTradeMode = (snapshot?.tradeMode as AccountTradeMode | undefined) ?? 'REAL';
    return { tradeMode };
  }
}
