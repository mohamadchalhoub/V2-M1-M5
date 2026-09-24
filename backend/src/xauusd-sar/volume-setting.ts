/**
 * Setting xauusd-sar-v1's order volume, with an audit trail.
 *
 * Mirrors `xauusd-m1m5/volume-setting.ts` exactly, against this strategy's
 * own table — `xauusd_sar_volume_settings`, never the RSI strategy's. See the
 * migration plan for how this is SEEDED from the RSI strategy's last
 * configured volume rather than starting from the compiled default, per the
 * instruction not to silently resize on a strategy replacement.
 */
import type { PrismaClient } from '@prisma/client';
import { SAR_SYMBOL } from './safety-constants';
import { validateVolume } from '../xauusd-m1m5/volume';

export interface SetSarVolumeInput {
  readonly accountId: string;
  readonly lots: number;
  readonly changedBy: string;
  readonly note?: string | null;
}

export type SetSarVolumeResult =
  | { readonly ok: true; readonly previousLots: number | null; readonly lots: number; readonly provenance: string }
  | { readonly ok: false; readonly reason: string };

export async function setSarVolume(prisma: PrismaClient, input: SetSarVolumeInput): Promise<SetSarVolumeResult> {
  const { accountId, lots, changedBy, note } = input;
  if (!Number.isFinite(lots) || lots <= 0) {
    return { ok: false, reason: `${lots} is not a positive number of lots.` };
  }

  const metadata = await prisma.symbolMetadata.findUnique({ where: { symbol: SAR_SYMBOL } });
  if (!metadata) {
    return {
      ok: false,
      reason: `no broker metadata for ${SAR_SYMBOL}, so the volume cannot be validated. Let the collector run until it has reported it, then retry.`,
    };
  }
  const limits = { min: Number(metadata.volumeMin), max: Number(metadata.volumeMax), step: Number(metadata.volumeStep) };
  const check = validateVolume(lots, limits);
  if (!check.acceptable) {
    return {
      ok: false,
      reason: `${lots} lot is not valid for this broker (min ${limits.min}, max ${limits.max}, step ${limits.step}): ${check.reason}. It was NOT rounded to fit.`,
    };
  }

  const previous = await prisma.xauusdSarVolumeSetting.findUnique({ where: { accountId } });
  const provenance = `Set to ${lots} lot by ${changedBy}` + (note ? ` -- ${note}` : '') + '.';

  await prisma.$transaction([
    prisma.xauusdSarVolumeSetting.upsert({
      where: { accountId },
      create: { accountId, volumeLots: lots, source: 'OPERATOR', provenance },
      update: { volumeLots: lots, source: 'OPERATOR', provenance },
    }),
    prisma.xauusdSarVolumeAudit.create({
      data: { accountId, previousLots: previous?.volumeLots ?? null, newLots: lots, source: 'OPERATOR', provenance, changedBy },
    }),
  ]);

  return { ok: true, previousLots: previous ? Number(previous.volumeLots) : null, lots, provenance };
}

export async function currentSarVolume(prisma: PrismaClient, accountId: string): Promise<number | null> {
  const row = await prisma.xauusdSarVolumeSetting.findUnique({ where: { accountId } });
  return row ? Number(row.volumeLots) : null;
}
