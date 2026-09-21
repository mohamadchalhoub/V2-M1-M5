import { Injectable, Logger } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GOLD_VOLUME_LOTS } from './gold-safety-constants';

export interface GoldVolumeAuditEntry {
  at: string;
  oldValue: number;
  newValue: number;
  note: string;
}

interface GoldRuntimeSettingsFile {
  volumeLots: number;
  volumeAudit: GoldVolumeAuditEntry[];
}

/**
 * Task item F — "user-controlled volume setting (initially 0.01 lots) with
 * broker validation + audit trail." `GOLD_VOLUME_LOTS` (gold-safety-constants.ts)
 * is a compile-time constant, which cannot be user-controlled at runtime —
 * this is the live override the dashboard actually writes to, read fresh on
 * every call (same never-cache-a-safety-relevant-read posture as the kill
 * switch), so a change here is picked up by the very next pending-order poll
 * with no restart. File-based, same posture as GOLD_KILL_SWITCH_PATH — one
 * JSON file under `GOLD_RUNTIME_SETTINGS_PATH` (default
 * `gold-execution-runtime/settings.json` under the backend working
 * directory), holding the current value plus a full change history (the
 * audit trail). Falls back to the original hardcoded 0.01 constant if the
 * file has never been written.
 */
@Injectable()
export class GoldRuntimeSettingsService {
  private readonly logger = new Logger(GoldRuntimeSettingsService.name);

  private getPath(): string {
    return process.env.GOLD_RUNTIME_SETTINGS_PATH?.trim() || join(process.cwd(), 'gold-execution-runtime', 'settings.json');
  }

  private read(): GoldRuntimeSettingsFile {
    const path = this.getPath();
    if (!existsSync(path)) {
      return { volumeLots: GOLD_VOLUME_LOTS, volumeAudit: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as GoldRuntimeSettingsFile;
      if (typeof parsed.volumeLots !== 'number' || !Number.isFinite(parsed.volumeLots) || parsed.volumeLots <= 0) {
        this.logger.error(`gold runtime settings file at ${path} has an invalid volumeLots — falling back to the default ${GOLD_VOLUME_LOTS}`);
        return { volumeLots: GOLD_VOLUME_LOTS, volumeAudit: parsed.volumeAudit ?? [] };
      }
      return { volumeLots: parsed.volumeLots, volumeAudit: parsed.volumeAudit ?? [] };
    } catch (err) {
      this.logger.error(`failed to read/parse gold runtime settings at ${path}: ${err instanceof Error ? err.message : err} — falling back to the default ${GOLD_VOLUME_LOTS}`);
      return { volumeLots: GOLD_VOLUME_LOTS, volumeAudit: [] };
    }
  }

  /** Always the live, current value — this is what order submission must read, never the raw constant. */
  getVolumeLots(): number {
    return this.read().volumeLots;
  }

  getVolumeAudit(): GoldVolumeAuditEntry[] {
    return this.read().volumeAudit;
  }

  /**
   * Caller (the controls controller) is responsible for broker validation
   * (min/max/step, via `GoldAccountStateService.resolveVolumeConstraints()`)
   * BEFORE calling this — this method only persists an already-validated
   * value plus its audit entry, it does not re-validate.
   */
  setVolumeLots(newValue: number, note: string): GoldRuntimeSettingsFile {
    const current = this.read();
    const entry: GoldVolumeAuditEntry = { at: new Date().toISOString(), oldValue: current.volumeLots, newValue, note };
    const next: GoldRuntimeSettingsFile = { volumeLots: newValue, volumeAudit: [...current.volumeAudit, entry] };

    const path = this.getPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2));
    this.logger.log(`gold volume setting changed: ${current.volumeLots} -> ${newValue} (${note})`);
    return next;
  }
}
