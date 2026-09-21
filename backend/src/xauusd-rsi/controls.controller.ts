/**
 * Operator controls for the active strategy.
 *
 * Every control here affects FUTURE submissions only. Nothing mutates a
 * decision already in flight, nothing touches a retired strategy's rows, and
 * a GET never writes. The two switches are file-based so they take effect on
 * the next check without a restart.
 */
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';
import { DashboardTokenGuard } from '../auth/dashboard-token.guard';
import { RsiAccountStateService } from './account-state.service';
import { RsiRuntimeSettingsService } from './runtime-settings.service';
import { getRsiStopNewEntriesPath, killSwitchState, stopNewEntriesState } from './controls';
import { RSI_SL_POINTS, RSI_TP_POINTS } from './safety-constants';

class SetVolumeDto {
  @IsNumber() volumeLots!: number;
  @IsOptional() @IsString() note?: string;
}

class SetStopNewEntriesDto {
  @IsBoolean() active!: boolean;
}

@Controller('research/xauusd-rsi-controls')
@UseGuards(DashboardTokenGuard)
export class RsiControlsController {
  constructor(
    private readonly accountState: RsiAccountStateService,
    private readonly runtimeSettings: RsiRuntimeSettingsService,
  ) {}

  @Get()
  async getControls() {
    const volume = this.runtimeSettings.resolveVolume();
    const constraints = await this.accountState.resolveBrokerConstraints();
    return {
      volume,
      volumeAudit: this.runtimeSettings.getVolumeAudit(),
      brokerConstraints: constraints,
      killSwitch: killSwitchState(),
      stopNewEntries: stopNewEntriesState(),
      brackets: { stopLossPoints: RSI_SL_POINTS, takeProfitPoints: RSI_TP_POINTS },
    };
  }

  /**
   * Validates against REAL broker min/max/step before persisting. A value
   * that fails is rejected with the reason — never rounded to the nearest
   * legal step, because silently trading a different size than the operator
   * asked for is worse than refusing.
   */
  @Post('volume')
  async setVolume(@Body() dto: SetVolumeDto) {
    const constraints = await this.accountState.resolveBrokerConstraints();

    if (!Number.isFinite(dto.volumeLots) || dto.volumeLots <= 0) {
      return { ok: false, reason: `Volume ${dto.volumeLots} is not a positive number.` };
    }
    if (!Number.isFinite(constraints.minLots) || constraints.maxLots <= 0) {
      return {
        ok: false,
        reason: 'Live broker volume constraints are unavailable or stale — refusing to accept a volume that cannot be validated against real broker limits.',
      };
    }
    if (dto.volumeLots < constraints.minLots || dto.volumeLots > constraints.maxLots) {
      return { ok: false, reason: `Volume ${dto.volumeLots} is outside the broker's bounds [${constraints.minLots}, ${constraints.maxLots}].` };
    }
    const steps = dto.volumeLots / constraints.stepLots;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) {
      return { ok: false, reason: `Volume ${dto.volumeLots} is not a multiple of the broker's step ${constraints.stepLots}. It is not rounded for you.` };
    }

    const saved = this.runtimeSettings.setVolumeLots(dto.volumeLots, dto.note?.trim() || 'set via dashboard');
    return { ok: true, volumeLots: saved.volumeLots, audit: saved.volumeAudit.slice(-5) };
  }

  /**
   * Freezes or resumes NEW ENTRIES only. It deliberately does not, and must
   * not, affect protective closures, reconciliation or Friday liquidation of
   * owned positions (spec §10).
   */
  @Post('stop-new-entries')
  setStopNewEntries(@Body() dto: SetStopNewEntriesDto) {
    const path = getRsiStopNewEntriesPath();
    if (dto.active) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `stop new entries set via dashboard at ${new Date().toISOString()}\n`);
    } else if (existsSync(path)) {
      unlinkSync(path);
    }
    const state = stopNewEntriesState();
    return {
      ok: true,
      stopNewEntries: state,
      note: state.active
        ? 'New entries are frozen. Protective closures, reconciliation and Friday liquidation of owned positions continue unaffected.'
        : 'New entries are permitted again, subject to schedule, session, risk and occupancy gates.',
      // Honest about a control this endpoint cannot clear.
      warning:
        !dto.active && stopNewEntriesState().active
          ? 'A DIFFERENT stop-new-entries source is still active and this endpoint cannot clear it — see `stopNewEntries.source`.'
          : null,
    };
  }
}
