import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_VOLUME_LOTS, TrendBreakoutInstrumentId } from './instrument-config';
import { SymbolMetadataRow } from './symbol-metadata.service';

/**
 * §2/§12 — user-controlled, per-instrument fixed volume. "Only the
 * authenticated user can change these volumes through application
 * settings... Store separate volume settings per instrument. Audit every
 * setting change. Changes apply to future entry requests only." The
 * "authenticated user" check itself is the CONTROLLER's job
 * (`trend-breakout.controller.ts`, behind the same `DashboardTokenGuard`
 * every other settings-shaped route in this codebase already uses) —
 * this service assumes it is only ever called with an already-verified
 * caller identity string.
 */
export interface VolumeSetting {
  instrument: TrendBreakoutInstrumentId;
  volumeLots: number;
  version: number;
  updatedAt: Date;
  updatedBy: string;
}

export interface VolumeUpdateResult {
  ok: boolean;
  setting?: VolumeSetting;
  error?: string;
  /** Present when the update was accepted but broker min/max/step could not be checked (no SymbolMetadata row yet) — the value is saved, but §2's full validation only completes once metadata exists; entries still fail closed against missing metadata regardless (evaluated at request time, not here). */
  warning?: string;
}

@Injectable()
export class TrendBreakoutVolumeSettingsService {
  private readonly logger = new Logger(TrendBreakoutVolumeSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Bootstraps §2's stated initial volumes (EURUSD 0.12, XAUUSD 0.01) on first read — this constant is NEVER consulted again for an instrument once its row exists. */
  async getOrBootstrap(instrument: TrendBreakoutInstrumentId): Promise<VolumeSetting> {
    const existing = await this.prisma.trendBreakoutVolumeSetting.findUnique({ where: { instrument } });
    if (existing) return toVolumeSetting(existing);

    const created = await this.prisma.trendBreakoutVolumeSetting.upsert({
      where: { instrument },
      create: { instrument, volumeLots: DEFAULT_VOLUME_LOTS[instrument], version: 1, updatedBy: 'system-bootstrap' },
      update: {}, // a concurrent bootstrap race just returns the winner's row, never overwrites it
    });
    this.logger.log(`bootstrapped ${instrument} volume setting at default ${DEFAULT_VOLUME_LOTS[instrument]} lots`);
    return toVolumeSetting(created);
  }

  async getAll(): Promise<VolumeSetting[]> {
    return Promise.all([this.getOrBootstrap('EURUSD'), this.getOrBootstrap('XAUUSD')]);
  }

  /**
   * §12 — "Before saving volume changes, validate the values and explain
   * that they apply to future trades only." Basic validation (positive
   * number) always applies; broker min/max/step validation applies WHEN
   * `symbolMetadata` is available (a warning is returned, not a rejection,
   * when it isn't — see this service's own doc comment: entry-time
   * validation is what actually fails closed on missing metadata, not this
   * settings save). Never rounds or substitutes the requested value — an
   * out-of-range volume against KNOWN metadata is rejected outright, never
   * silently clamped.
   */
  async updateVolume(instrument: TrendBreakoutInstrumentId, newVolumeLots: number, changedBy: string, symbolMetadata: SymbolMetadataRow | null): Promise<VolumeUpdateResult> {
    if (!Number.isFinite(newVolumeLots) || newVolumeLots <= 0) {
      return { ok: false, error: `Volume must be a positive number, got ${newVolumeLots}.` };
    }

    let warning: string | undefined;
    if (symbolMetadata) {
      if (newVolumeLots < symbolMetadata.volumeMin || newVolumeLots > symbolMetadata.volumeMax) {
        return { ok: false, error: `Volume ${newVolumeLots} is outside the broker's allowed range [${symbolMetadata.volumeMin}, ${symbolMetadata.volumeMax}] for ${symbolMetadata.symbol}.` };
      }
      const steps = (newVolumeLots - symbolMetadata.volumeMin) / symbolMetadata.volumeStep;
      if (Math.abs(steps - Math.round(steps)) > 1e-6) {
        return { ok: false, error: `Volume ${newVolumeLots} is not a valid multiple of the broker's volume step (${symbolMetadata.volumeStep}) for ${symbolMetadata.symbol}.` };
      }
    } else {
      warning = `Broker volume min/max/step for ${instrument} are not yet known (no SymbolMetadata row) — this value is saved, but every entry request will still independently validate it once broker metadata is available, and will block if it's invalid then.`;
    }

    const current = await this.getOrBootstrap(instrument);
    const newVersion = current.version + 1;

    const [, updated] = await this.prisma.$transaction([
      this.prisma.trendBreakoutVolumeAudit.create({
        data: { instrument, oldVolume: current.volumeLots, newVolume: newVolumeLots, newVersion, changedBy },
      }),
      this.prisma.trendBreakoutVolumeSetting.update({
        where: { instrument },
        data: { volumeLots: newVolumeLots, version: newVersion, updatedBy: changedBy },
      }),
    ]);

    this.logger.log(`${instrument} volume changed ${current.volumeLots} -> ${newVolumeLots} lots by ${changedBy} (v${newVersion}) — applies to future entry requests only`);
    return { ok: true, setting: toVolumeSetting(updated), warning };
  }

  async getAuditLog(instrument: TrendBreakoutInstrumentId, limit = 50) {
    return this.prisma.trendBreakoutVolumeAudit.findMany({
      where: { instrument },
      orderBy: { changedAt: 'desc' },
      take: limit,
    });
  }
}

function toVolumeSetting(row: { instrument: string; volumeLots: { toNumber(): number }; version: number; updatedAt: Date; updatedBy: string }): VolumeSetting {
  return {
    instrument: row.instrument as TrendBreakoutInstrumentId,
    volumeLots: row.volumeLots.toNumber(),
    version: row.version,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}
