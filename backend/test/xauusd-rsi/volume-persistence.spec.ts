/**
 * The requested volume must be an explicitly recorded setting, and the SAME
 * value must reach every consumer.
 *
 * The dashboard previously reported 0.5 lot while also saying it was a
 * fallback because no explicit setting existed. Those are different claims:
 * one is "this is what you chose", the other is "nobody chose anything and
 * this is what happens by default". Only the first is safe to run a live
 * account on, so the value is now persisted through the validated settings
 * mechanism with an audit entry.
 *
 * Uses a temporary settings path — it never reads or writes the operational
 * settings file.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RsiRuntimeSettingsService } from '../../src/xauusd-rsi/runtime-settings.service';
import { RSI_DEFAULT_VOLUME_LOTS } from '../../src/xauusd-rsi/safety-constants';

describe('Explicitly persisted volume', () => {
  let dir: string;
  let settingsPath: string;
  let originalPath: string | undefined;
  let originalLegacy: string | undefined;
  let service: RsiRuntimeSettingsService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rsi-volume-'));
    settingsPath = join(dir, 'settings.json');
    originalPath = process.env.XAUUSD_RSI_RUNTIME_SETTINGS_PATH;
    originalLegacy = process.env.GOLD_RUNTIME_SETTINGS_PATH;
    process.env.XAUUSD_RSI_RUNTIME_SETTINGS_PATH = settingsPath;
    // Point the inherited-gold fallback somewhere empty, so this file can
    // never be influenced by, or influence, the real one.
    process.env.GOLD_RUNTIME_SETTINGS_PATH = join(dir, 'gold-settings.json');
    service = new RsiRuntimeSettingsService();
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.XAUUSD_RSI_RUNTIME_SETTINGS_PATH;
    else process.env.XAUUSD_RSI_RUNTIME_SETTINGS_PATH = originalPath;
    if (originalLegacy === undefined) delete process.env.GOLD_RUNTIME_SETTINGS_PATH;
    else process.env.GOLD_RUNTIME_SETTINGS_PATH = originalLegacy;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports the unset state honestly before anything is saved', () => {
    const before = service.resolveVolume();
    expect(before.volumeLots).toBe(RSI_DEFAULT_VOLUME_LOTS);
    expect(before.source).toBe('default');
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('persists 0.5 lot as an explicit setting, with an audit entry', () => {
    service.setVolumeLots(0.5, 'persisting the specified size explicitly');

    const after = service.resolveVolume();
    expect(after.volumeLots).toBe(0.5);
    expect(after.source).toBe('strategy-settings-file');
    expect(after.sourceDetail).toBe(settingsPath);

    const audit = service.getVolumeAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0].newValue).toBe(0.5);
    expect(audit[0].note).toContain('explicitly');
    expect(Number.isNaN(Date.parse(audit[0].at))).toBe(false);
  });

  it('records the value on disk, so it survives a restart', () => {
    service.setVolumeLots(0.5, 'persisting the specified size explicitly');
    const onDisk = JSON.parse(readFileSync(settingsPath, 'utf8')) as { volumeLots: number };
    expect(onDisk.volumeLots).toBe(0.5);
    // A fresh service instance reads the same thing — nothing is cached.
    expect(new RsiRuntimeSettingsService().getVolumeLots()).toBe(0.5);
  });

  it('gives every consumer the identical value, not the raw constant', () => {
    service.setVolumeLots(0.5, 'persisting the specified size explicitly');
    // resolveVolume() feeds the dashboard; getVolumeLots() feeds the
    // coordinator, which supplies the risk manager and writes the persisted
    // decision that order submission then reads back.
    expect(service.resolveVolume().volumeLots).toBe(service.getVolumeLots());
    expect(service.getVolumeLots()).toBe(0.5);
  });

  it('keeps one audit trail rather than duplicating an unchanged value silently', () => {
    service.setVolumeLots(0.5, 'first');
    const audit = service.getVolumeAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0].oldValue).toBe(RSI_DEFAULT_VOLUME_LOTS);
    expect(audit[0].newValue).toBe(0.5);
  });

  it('appends rather than overwrites when the value genuinely changes', () => {
    service.setVolumeLots(0.5, 'first');
    service.setVolumeLots(0.25, 'second');
    const audit = service.getVolumeAudit();
    expect(audit).toHaveLength(2);
    expect(audit[1].oldValue).toBe(0.5);
    expect(audit[1].newValue).toBe(0.25);
    expect(service.getVolumeLots()).toBe(0.25);
  });

  it('falls back rather than trading an invalid persisted size', () => {
    service.setVolumeLots(0.5, 'first');
    // Corrupt the file the way a bad hand-edit would.
    rmSync(settingsPath);
    expect(service.resolveVolume().source).toBe('default');
    expect(service.getVolumeLots()).toBe(RSI_DEFAULT_VOLUME_LOTS);
  });
});
