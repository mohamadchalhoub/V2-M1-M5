import { Injectable } from '@nestjs/common';
import { AutonomousDecisionAction, AutonomousOrderStatus, Prisma, TrendBreakoutInstrument } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GateResult } from './gate-result';
import { TrendBreakoutInstrumentId } from './instrument-config';

/**
 * §12 — writes the full observability record for every H1 signal-candle
 * evaluation (HOLD included). One row per (account, strategy version,
 * instrument, signal-close timestamp) — see `TrendBreakoutDecision`'s own
 * schema comment for why that tuple is both the durable signal identity
 * AND the idempotency guard.
 */
export interface LogDecisionInput {
  accountId: string;
  strategyVersion: string;
  instrument: TrendBreakoutInstrument;
  signalCloseAt: Date;
  decisionAtUtc: Date;
  decisionAtBeirut: string;
  action: AutonomousDecisionAction;
  h4Close: number | null;
  h4Ema50: number | null;
  h4Ema200: number | null;
  h1RangeHigh: number | null;
  h1RangeLow: number | null;
  h1SignalClose: number | null;
  h1SignalHigh: number | null;
  h1SignalLow: number | null;
  atr14: number | null;
  bid: number | null;
  ask: number | null;
  spreadPoints: number | null;
  quoteAt: Date | null;
  volumeUsed: number | null;
  volumeConfigVersion: number | null;
  riskPolicyVersion: number | null;
  estimatedStopRiskAmount: number | null;
  estimatedStopRiskCcy: string | null;
  intendedEntryPrice: number | null;
  intendedStopLoss: number | null;
  intendedTakeProfit: number | null;
  gateResults: GateResult[];
  rejectionReason: string | null;
  orderStatus: AutonomousOrderStatus;
}

@Injectable()
export class TrendBreakoutDecisionLoggerService {
  constructor(private readonly prisma: PrismaService) {}

  async log(input: LogDecisionInput) {
    return this.prisma.trendBreakoutDecision.create({
      data: {
        accountId: input.accountId,
        strategyVersion: input.strategyVersion,
        instrument: input.instrument,
        signalCloseAt: input.signalCloseAt,
        decisionAtUtc: input.decisionAtUtc,
        decisionAtBeirut: input.decisionAtBeirut,
        action: input.action,
        h4CloseAt: input.h4Close,
        h4Ema50: input.h4Ema50,
        h4Ema200: input.h4Ema200,
        h1RangeHigh: input.h1RangeHigh,
        h1RangeLow: input.h1RangeLow,
        h1SignalClose: input.h1SignalClose,
        h1SignalHigh: input.h1SignalHigh,
        h1SignalLow: input.h1SignalLow,
        atr14: input.atr14,
        bid: input.bid,
        ask: input.ask,
        spreadPoints: input.spreadPoints,
        quoteAt: input.quoteAt,
        volumeUsed: input.volumeUsed,
        volumeConfigVersion: input.volumeConfigVersion,
        riskPolicyVersion: input.riskPolicyVersion,
        estimatedStopRiskAmount: input.estimatedStopRiskAmount,
        estimatedStopRiskCcy: input.estimatedStopRiskCcy,
        intendedEntryPrice: input.intendedEntryPrice,
        intendedStopLoss: input.intendedStopLoss,
        intendedTakeProfit: input.intendedTakeProfit,
        gateResults: input.gateResults as unknown as Prisma.InputJsonValue,
        rejectionReason: input.rejectionReason,
        orderStatus: input.orderStatus,
      },
    });
  }

  async recent(accountId: string, instrument?: TrendBreakoutInstrument, limit = 50) {
    return this.prisma.trendBreakoutDecision.findMany({
      where: { accountId, ...(instrument ? { instrument } : {}) },
      orderBy: { decisionAtUtc: 'desc' },
      take: limit,
    });
  }

  /**
   * Atomic PENDING -> SENT claim for one instrument's oldest queued order —
   * same race protection as `AutonomousDecisionLoggerService.claimOldestPendingOrder`
   * (an `updateMany` guarded by the row's still being PENDING; a `count === 0`
   * means another poll won the race, never a duplicate send). Scoped by
   * `instrument` so EURUSD's and XAUUSD's collector polls (own routes, see
   * `trend-breakout-execution.controller.ts`) never claim each other's rows.
   */
  async claimOldestPendingOrder(accountId: string, instrument: TrendBreakoutInstrumentId) {
    const candidate = await this.prisma.trendBreakoutDecision.findFirst({
      where: { accountId, instrument: instrument as TrendBreakoutInstrument, orderStatus: 'PENDING' },
      orderBy: { decisionAtUtc: 'asc' },
    });
    if (!candidate) return null;

    const claimed = await this.prisma.trendBreakoutDecision.updateMany({
      where: { id: candidate.id, orderStatus: 'PENDING' },
      data: { orderStatus: 'SENT' },
    });
    if (claimed.count === 0) return null; // lost the race to another poll

    return candidate;
  }

  /**
   * Records the collector's broker-confirmed (or failed) result for a SENT
   * decision. No dedicated `mt5Ticket`/`executionError` columns exist on
   * `TrendBreakoutDecision` (unlike the legacy `AutonomousDecision`) — the
   * existing `brokerPositionId`/`actualFillPrice`/`rejectionReason` columns
   * are reused instead (same information, no new migration needed for this
   * step): a fill sets `brokerPositionId`/`actualFillPrice`; a failure sets
   * `rejectionReason` to the collector's error message. `orderStatus` is the
   * single source of truth for which case occurred, never these text fields.
   */
  async recordExecutionResult(
    decisionId: string,
    result: { ok: boolean; ticket?: number | null; filledPrice?: number | null; errorMessage?: string | null },
  ): Promise<void> {
    await this.prisma.trendBreakoutDecision.update({
      where: { id: decisionId },
      data: {
        orderStatus: result.ok ? 'FILLED' : 'FAILED',
        brokerPositionId: result.ok && result.ticket != null ? String(result.ticket) : undefined,
        actualFillPrice: result.ok ? (result.filledPrice ?? undefined) : undefined,
        rejectionReason: result.ok ? undefined : (result.errorMessage ?? 'Execution failed at the collector.'),
      },
    });
  }

  /**
   * Cancels a claimed (SENT) decision that failed the pre-send guard's final
   * re-verification — never sent to the broker at all. Distinct from
   * `recordExecutionResult`'s FAILED (which means the broker itself
   * rejected/errored) only in the log message; the resulting `orderStatus`
   * is the same terminal FAILED state either way, so a stuck PENDING/SENT
   * row can never linger.
   */
  async cancelAtPreSendGuard(decisionId: string, reason: string): Promise<void> {
    await this.prisma.trendBreakoutDecision.update({
      where: { id: decisionId },
      data: { orderStatus: 'FAILED', rejectionReason: `Cancelled at pre-send check: ${reason}` },
    });
  }
}
