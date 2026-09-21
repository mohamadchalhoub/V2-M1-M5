import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';
import { DashboardTokenGuard } from '../auth/dashboard-token.guard';
import { PrismaService } from '../prisma/prisma.service';
import { GoldAccountStateService } from './gold-account-state.service';
import { getStopNewEntriesFilePath } from './gold-execution-mode';
import { GoldRuntimeSettingsService } from './gold-runtime-settings.service';
import { GoldTelegramService } from './gold-telegram.service';
import { GoldNewsService } from './gold-news.service';
import { GoldAiSummaryService } from './gold-ai-summary.service';
import { GoldCloseExecutionService } from './gold-close-execution.service';
import { GOLD_SYMBOL } from './gold-safety-constants';

class SetVolumeDto {
  @IsNumber() volumeLots!: number;
  @IsOptional() @IsString() note?: string;
}

class SetStopNewEntriesDto {
  @IsBoolean() active!: boolean;
}

class RequestCloseDto {
  @IsString() positionId!: string;
  @IsBoolean() confirm!: boolean;
}

/**
 * Task item F — dashboard-facing controls, gold-only, every one gated to
 * FUTURE submissions only (never mutates anything already in flight or any
 * legacy/EURUSD state) and with no side effect from merely GET-ing status
 * (only the POST endpoints below write anything).
 */
@Controller('research/gold-execution-status')
@UseGuards(DashboardTokenGuard)
export class GoldControlsController {
  constructor(
    private readonly accountState: GoldAccountStateService,
    private readonly runtimeSettings: GoldRuntimeSettingsService,
    private readonly goldTelegram: GoldTelegramService,
    private readonly goldNews: GoldNewsService,
    private readonly goldAiSummary: GoldAiSummaryService,
    private readonly closeExecution: GoldCloseExecutionService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('news')
  async getNews() {
    const [items, coverage] = await Promise.all([this.goldNews.getRelevantNews(30), this.goldNews.getProviderCoverage()]);
    return { items, coverage };
  }

  @Get('ai-summaries')
  async getAiSummaries() {
    return { summaries: this.goldAiSummary.getRecent(20) };
  }

  @Get('volume')
  async getVolume() {
    return { volumeLots: this.runtimeSettings.getVolumeLots(), audit: this.runtimeSettings.getVolumeAudit() };
  }

  /** Broker-validated (min/max/step from live SymbolMetadata) before being persisted — never accepts an out-of-range value. */
  @Post('volume')
  async setVolume(@Body() dto: SetVolumeDto) {
    // resolveVolumeConstraints() fails closed to an impossible range
    // (min=+Infinity, max=0) when SymbolMetadata is missing/stale — the
    // range check below naturally rejects every value in that case, so no
    // separate null check is needed.
    const { minLots, maxLots, stepLots } = await this.accountState.resolveVolumeConstraints();
    if (dto.volumeLots < minLots || dto.volumeLots > maxLots) {
      return { ok: false, error: `volumeLots ${dto.volumeLots} is outside the broker's allowed range [${minLots}, ${maxLots}].` };
    }
    // Step validation with floating-point tolerance.
    const steps = (dto.volumeLots - minLots) / stepLots;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) {
      return { ok: false, error: `volumeLots ${dto.volumeLots} does not align to the broker's volume step (${stepLots}).` };
    }

    const result = this.runtimeSettings.setVolumeLots(dto.volumeLots, dto.note ?? 'dashboard change');
    void this.goldTelegram.notify(
      'VOLUME_CHANGED',
      `volume-change:${Date.now()}`,
      `GOLD DEMO — volume setting changed via dashboard: ${result.volumeAudit.at(-1)?.oldValue} -> ${dto.volumeLots} lots. ` +
        `Live from the next evaluation onward (risk gate + broker submission both use it) — never resizes an already-open position or a decision already queued.`,
    );
    return { ok: true, volumeLots: result.volumeLots };
  }

  @Get('stop-new-entries')
  async getStopNewEntries() {
    return { active: existsSync(getStopNewEntriesFilePath()) };
  }

  @Post('stop-new-entries')
  async setStopNewEntries(@Body() dto: SetStopNewEntriesDto) {
    const path = getStopNewEntriesFilePath();
    if (dto.active) {
      writeFileSync(path, `set via dashboard at ${new Date().toISOString()}`);
    } else if (existsSync(path)) {
      unlinkSync(path);
    }
    void this.goldTelegram.notify(
      dto.active ? 'STOP_NEW_ENTRIES_SET' : 'STOP_NEW_ENTRIES_CLEARED',
      `stop-new-entries:${Date.now()}`,
      `GOLD DEMO — stop-new-entries ${dto.active ? 'ENGAGED' : 'CLEARED'} via dashboard.`,
    );
    return { ok: true, active: dto.active };
  }

  /**
   * Scoped close-position action, gold-only. Creates a `GoldCloseRequest`
   * (task item 2) that the collector's own poll (`GET .../close-request` on
   * `GoldExecutionController`) claims and executes via `executor.py`'s
   * already-existing `close_position`. Side/volume are read from the LIVE
   * `Position` row by ticket — never trusted from the request body — so a
   * caller cannot request closing "position X" with a fabricated
   * side/volume. Duplicate requests for the same ticket return the existing
   * request instead of creating a second one. This endpoint itself never
   * marks anything closed — see `GoldExecutionController.postCloseResult`,
   * the only path that does, and only on a broker-confirmed result.
   */
  @Post('close-position')
  async requestClose(@Body() dto: RequestCloseDto) {
    if (!dto.confirm) {
      return { ok: false, error: 'confirm must be true to request a close.' };
    }

    const account = await this.prisma.tradingAccount.findFirst({ where: { platform: 'MT5' }, orderBy: { createdAt: 'asc' } });
    if (!account) {
      return { ok: false, error: 'No MT5 trading account found.' };
    }

    const position = await this.prisma.position.findUnique({
      where: { accountId_platform_externalPositionId: { accountId: account.id, platform: 'MT5', externalPositionId: dto.positionId } },
    });
    if (!position || position.symbol.toUpperCase() !== GOLD_SYMBOL || position.status !== 'OPEN') {
      return { ok: false, error: `No open gold position with ticket ${dto.positionId} found for this account.` };
    }

    const { request, duplicate } = await this.closeExecution.requestClose({
      accountId: account.id,
      positionTicket: dto.positionId,
      side: position.side as 'BUY' | 'SELL',
      volume: position.volume.toNumber(),
    });

    if (!duplicate) {
      void this.goldTelegram.notify(
        'CLOSE_REQUESTED',
        `close-request:${request.id}`,
        `GOLD DEMO — close REQUESTED via dashboard for position=${dto.positionId} (symbol=${GOLD_SYMBOL}, side=${position.side}, volume=${position.volume.toNumber()}). ` +
          `Queued for the collector's next poll — "closed" will only be confirmed after a real broker response.`,
      );
    }

    return {
      ok: true,
      requestId: request.id,
      status: request.status,
      duplicate,
      note: duplicate
        ? 'A close request for this position is already pending/in-flight — not creating a second one.'
        : 'Queued — the collector will attempt this on its next poll cycle. Status will move to CLOSED only after a broker-confirmed result.',
    };
  }
}
