import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getBeirutCalendarDate } from './schedule';
import { updateCashFlowAdjustedHigh } from './risk-policy';

/**
 * §10 — durable daily-loss/drawdown state, persisted so "a restart or
 * transient data loss can NEVER silently reset a baseline or clear a
 * triggered flag." Backed by `TrendBreakoutRiskState` (schema.prisma),
 * exactly one row per account.
 *
 * Known, disclosed limitation (see the delivery report): deposit/withdrawal
 * DETECTION is not wired up in this session — `recordCashFlow` exists and
 * is unit-tested, but nothing calls it automatically yet, because reliably
 * distinguishing "a deposit landed" from "trading P&L moved the balance"
 * from this system's current data (AccountSnapshot balance/equity only, no
 * transaction ledger) needs its own careful design, not a guess bolted on
 * here. Until that exists, `dailyNetCashFlow` stays 0 in practice — the
 * math is cash-flow-adjustment-READY, not cash-flow-adjustment-ACTIVE.
 */
export interface RiskStateSnapshot {
  accountId: string;
  beirutDate: string;
  dailyBaselineEquity: number;
  dailyNetCashFlow: number;
  dailyLossTriggered: boolean;
  cashFlowAdjustedHigh: number;
  drawdownTriggered: boolean;
  drawdownTriggeredAt: Date | null;
}

@Injectable()
export class TrendBreakoutRiskStateService {
  private readonly logger = new Logger(TrendBreakoutRiskStateService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reads the current state, rolling the daily baseline forward exactly
   * once if the Beirut calendar day has changed since the last read (§10 —
   * "once triggered, block entries until the next Beirut day"). Never
   * called implicitly on every request without an explicit `now` — the
   * caller (the coordinator) always passes the real evaluation instant, so
   * the roll only ever happens because real time actually advanced, not as
   * a side effect of an unrelated code path.
   */
  async getOrRoll(accountId: string, now: Date, currentEquity: number): Promise<RiskStateSnapshot> {
    const beirutDate = getBeirutCalendarDate(now);
    const existing = await this.prisma.trendBreakoutRiskState.findUnique({ where: { accountId } });

    if (!existing) {
      const created = await this.prisma.trendBreakoutRiskState.create({
        data: {
          accountId,
          beirutDate,
          dailyBaselineEquity: currentEquity,
          dailyNetCashFlow: 0,
          dailyLossTriggered: false,
          cashFlowAdjustedHigh: currentEquity,
          drawdownTriggered: false,
        },
      });
      return toSnapshot(created);
    }

    if (existing.beirutDate !== beirutDate) {
      this.logger.log(`account ${accountId}: Beirut day rolled ${existing.beirutDate} -> ${beirutDate}, resetting daily baseline to ${currentEquity} and clearing the daily-loss trigger`);
      const updated = await this.prisma.trendBreakoutRiskState.update({
        where: { accountId },
        data: { beirutDate, dailyBaselineEquity: currentEquity, dailyNetCashFlow: 0, dailyLossTriggered: false },
      });
      return toSnapshot(updated);
    }

    return toSnapshot(existing);
  }

  async markDailyLossTriggered(accountId: string): Promise<void> {
    await this.prisma.trendBreakoutRiskState.update({ where: { accountId }, data: { dailyLossTriggered: true } });
    this.logger.warn(`account ${accountId}: daily loss threshold TRIGGERED — entries blocked until the next Beirut day`);
  }

  /** Updates the monotonic cash-flow-adjusted equity high — never decreases except via `resetDrawdown` below. */
  async updateEquityHigh(accountId: string, cashFlowAdjustedEquity: number): Promise<void> {
    const existing = await this.prisma.trendBreakoutRiskState.findUnique({ where: { accountId } });
    if (!existing) return; // getOrRoll must be called first to establish the row
    const newHigh = updateCashFlowAdjustedHigh(existing.cashFlowAdjustedHigh.toNumber(), cashFlowAdjustedEquity);
    if (newHigh !== existing.cashFlowAdjustedHigh.toNumber()) {
      await this.prisma.trendBreakoutRiskState.update({ where: { accountId }, data: { cashFlowAdjustedHigh: newHigh } });
    }
  }

  async markDrawdownTriggered(accountId: string, at: Date): Promise<void> {
    await this.prisma.trendBreakoutRiskState.update({ where: { accountId }, data: { drawdownTriggered: true, drawdownTriggeredAt: at } });
    this.logger.warn(`account ${accountId}: drawdown threshold TRIGGERED — entries blocked until explicit user review/reset`);
  }

  /** §10 — "block new entries until explicit user review/reset." The ONLY way `drawdownTriggered` is ever cleared; never automatic. */
  async resetDrawdown(accountId: string, resetBy: string): Promise<void> {
    await this.prisma.trendBreakoutRiskState.update({ where: { accountId }, data: { drawdownTriggered: false, drawdownTriggeredAt: null } });
    this.logger.warn(`account ${accountId}: drawdown block explicitly reset by ${resetBy}`);
  }

  /** Not yet called automatically anywhere — see this file's own module comment. Exists and is tested so the daily-loss math is genuinely cash-flow-adjustment-ready once a deposit/withdrawal detector is built. */
  async recordCashFlow(accountId: string, amount: number): Promise<void> {
    await this.prisma.trendBreakoutRiskState.update({
      where: { accountId },
      data: { dailyNetCashFlow: { increment: amount } },
    });
  }
}

function toSnapshot(row: {
  accountId: string;
  beirutDate: string;
  dailyBaselineEquity: { toNumber(): number };
  dailyNetCashFlow: { toNumber(): number };
  dailyLossTriggered: boolean;
  cashFlowAdjustedHigh: { toNumber(): number };
  drawdownTriggered: boolean;
  drawdownTriggeredAt: Date | null;
}): RiskStateSnapshot {
  return {
    accountId: row.accountId,
    beirutDate: row.beirutDate,
    dailyBaselineEquity: row.dailyBaselineEquity.toNumber(),
    dailyNetCashFlow: row.dailyNetCashFlow.toNumber(),
    dailyLossTriggered: row.dailyLossTriggered,
    cashFlowAdjustedHigh: row.cashFlowAdjustedHigh.toNumber(),
    drawdownTriggered: row.drawdownTriggered,
    drawdownTriggeredAt: row.drawdownTriggeredAt,
  };
}
