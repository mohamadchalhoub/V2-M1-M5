/**
 * What an operator can see about Engine A (xauusd-sar-v1).
 *
 * Own route, own section — never merged into the frozen RSI view or Engine
 * B's. Resolves the single deployed account the same way
 * `xauusd-m1m5/dashboard.controller.ts` does (`findFirst`, oldest first),
 * so the frontend needs no account id in the URL, matching that page's
 * calling convention exactly.
 */
import { Controller, Get, Inject, Post, Body, UseGuards } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardTokenGuard } from '../auth/dashboard-token.guard';
import { getSarExecutionMode, sarEngineEnabled, sarKillSwitchState } from './controls';
import { SAR_MAGIC } from './safety-constants';
import { SPEC, XAUUSD_SAR_STRATEGY_VERSION } from './spec';
import { currentSarVolume, setSarVolume } from './volume-setting';

@Controller('xauusd-sar')
@UseGuards(DashboardTokenGuard)
export class SarDashboardController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  private async primaryAccountId(): Promise<string | null> {
    const account = await this.prisma.tradingAccount.findFirst({ orderBy: { createdAt: 'asc' } });
    return account?.id ?? null;
  }

  @Get('status')
  async status() {
    const accountId = await this.primaryAccountId();
    const row = accountId ? await this.prisma.xauusdSarSession.findUnique({ where: { accountId } }) : null;
    const volume = accountId ? await currentSarVolume(this.prisma, accountId) : null;
    const recentCycles = accountId
      ? await this.prisma.xauusdSarCycle.findMany({ where: { accountId }, orderBy: { entryAt: 'desc' }, take: 20 })
      : [];

    return {
      strategyVersion: XAUUSD_SAR_STRATEGY_VERSION,
      magic: SAR_MAGIC,
      accountConfigured: accountId !== null,
      enabled: sarEngineEnabled(),
      executionMode: getSarExecutionMode(),
      killSwitch: sarKillSwitchState(),
      reversalDistanceUsd: SPEC.reversalDistanceUsd,
      sessionStart: '01:00 Asia/Beirut',
      dailyClose: '23:40 Asia/Beirut',
      volumeLots: volume,
      session: row
        ? {
            sessionDate: row.sessionDate,
            state: row.state,
            sessionReference: row.sessionReference ? Number(row.sessionReference) : null,
            buyTrigger: row.initialBuyTrigger ? Number(row.initialBuyTrigger) : null,
            sellTrigger: row.initialSellTrigger ? Number(row.initialSellTrigger) : null,
            direction: row.direction,
            entryFillPrice: row.entryFillPrice ? Number(row.entryFillPrice) : null,
            extremeSinceEntry: row.extremeSinceEntry ? Number(row.extremeSinceEntry) : null,
            reversalLevel: row.reversalLevel ? Number(row.reversalLevel) : null,
            brokerTicket: row.brokerTicket,
            unknownSince: row.unknownSince,
          }
        : null,
      recentCycles: recentCycles.map((c) => ({
        cycleId: c.cycleId,
        direction: c.direction,
        entryTicket: c.entryTicket,
        entryFillPrice: Number(c.entryFillPrice),
        entryAt: c.entryAt,
        exitTicket: c.exitTicket,
        exitFillPrice: c.exitFillPrice ? Number(c.exitFillPrice) : null,
        exitAt: c.exitAt,
        exitReason: c.exitReason,
      })),
    };
  }

  @Get('volume')
  async volume() {
    const accountId = await this.primaryAccountId();
    const lots = accountId ? await currentSarVolume(this.prisma, accountId) : null;
    return { volumeLots: lots };
  }

  @Post('volume')
  async setVolume(@Body() body: { volumeLots?: number; note?: string }) {
    const accountId = await this.primaryAccountId();
    if (!accountId) return { ok: false, error: 'no account configured' };
    const lots = Number(body.volumeLots);
    const result = await setSarVolume(this.prisma, { accountId, lots, changedBy: 'dashboard', note: body.note ?? null });
    return result.ok ? { ok: true, volumeLots: result.lots } : { ok: false, error: result.reason };
  }
}
