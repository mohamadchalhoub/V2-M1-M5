/**
 * The live, operator-settable volume for `xauusd-m1-rsi-retest-extremes-v1`,
 * with an audit trail of every change.
 *
 * File-based and read fresh on every call, the same posture as the kill
 * switch: a change takes effect on the next evaluation with no restart.
 *
 * Spec §10: "Keep the current valid configured volume. Default to 0.5 lot if
 * no valid explicit setting exists." Resolution order is therefore:
 *
 *   1. This strategy's own settings file, if it holds a valid positive number.
 *   2. The preserved gold settings file, if it holds one — so an operator who
 *      had deliberately configured a volume before the migration keeps it
 *      rather than being silently moved to a different size.
 *   3. `RSI_DEFAULT_VOLUME_LOTS` (0.5).
 *
 * Whatever this resolves to is only ever a REQUEST. It is validated against
 * real broker min/max/step and the equity risk caps before any submission,
 * and it is never auto-resized to make an order acceptable — an out-of-bounds
 * or too-risky volume produces a recorded rejection, not a smaller trade.
 */
import { Injectable, Logger } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RSI_DEFAULT_VOLUME_LOTS } from './safety-constants';

export interface RsiVolumeAuditEntry {
  at: string;
  oldValue: number;
  newValue: number;
  note: string;
}

interface RsiRuntimeSettingsFile {
  volumeLots: number;
  volumeAudit: RsiVolumeAuditEntry[];
}

export interface ResolvedVolume {
  volumeLots: number;
  /** Where the value came from, so the dashboard never implies a user set something they did not. */
  source: 'strategy-settings-file' | 'inherited-gold-settings-file' | 'default';
  sourceDetail: string;
}

@Injectable()
export class RsiRuntimeSettingsService {
  private readonly logger = new Logger(RsiRuntimeSettingsService.name);

  getPath(): string {
    return process.env.XAUUSD_RSI_RUNTIME_SETTINGS_PATH?.trim() || join(process.cwd(), 'xauusd-rsi-runtime', 'settings.json');
  }

  private getLegacyGoldPath(): string {
    return process.env.GOLD_RUNTIME_SETTINGS_PATH?.trim() || join(process.cwd(), 'gold-execution-runtime', 'settings.json');
  }

  private readFile(path: string): RsiRuntimeSettingsFile | null {
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RsiRuntimeSettingsFile>;
      if (typeof parsed.volumeLots !== 'number' || !Number.isFinite(parsed.volumeLots) || parsed.volumeLots <= 0) {
        this.logger.error(`settings file ${path} has an invalid volumeLots — ignoring it rather than trading an invalid size`);
        return null;
      }
      return { volumeLots: parsed.volumeLots, volumeAudit: parsed.volumeAudit ?? [] };
    } catch (err) {
      this.logger.error(`failed to read/parse settings at ${path}: ${err instanceof Error ? err.message : err} — ignoring it`);
      return null;
    }
  }

  resolveVolume(): ResolvedVolume {
    const own = this.readFile(this.getPath());
    if (own) {
      return { volumeLots: own.volumeLots, source: 'strategy-settings-file', sourceDetail: this.getPath() };
    }
    const legacyPath = this.getLegacyGoldPath();
    const legacy = this.readFile(legacyPath);
    if (legacy) {
      return {
        volumeLots: legacy.volumeLots,
        source: 'inherited-gold-settings-file',
        sourceDetail: `${legacyPath} (explicitly configured before the migration and preserved)`,
      };
    }
    return {
      volumeLots: RSI_DEFAULT_VOLUME_LOTS,
      source: 'default',
      sourceDetail: `no explicit setting found; using the specified default of ${RSI_DEFAULT_VOLUME_LOTS} lot`,
    };
  }

  /** The value order submission must read. Never the raw constant. */
  getVolumeLots(): number {
    return this.resolveVolume().volumeLots;
  }

  getVolumeAudit(): RsiVolumeAuditEntry[] {
    return this.readFile(this.getPath())?.volumeAudit ?? [];
  }

  /**
   * Persists an ALREADY-VALIDATED value plus its audit entry. The caller (the
   * controls controller) is responsible for checking it against live broker
   * min/max/step first — this method does not re-validate, and it never
   * rounds or clamps.
   */
  setVolumeLots(newValue: number, note: string): RsiRuntimeSettingsFile {
    const current = this.resolveVolume();
    const existingAudit = this.getVolumeAudit();
    const entry: RsiVolumeAuditEntry = { at: new Date().toISOString(), oldValue: current.volumeLots, newValue, note };
    const next: RsiRuntimeSettingsFile = { volumeLots: newValue, volumeAudit: [...existingAudit, entry] };

    const path = this.getPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2));
    this.logger.log(`XAUUSD RSI volume changed: ${current.volumeLots} -> ${newValue} (${note})`);
    return next;
  }
}
