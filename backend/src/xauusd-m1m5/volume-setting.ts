/**
 * Setting this strategy's order volume, with the audit trail the spec
 * requires ("explicitly configured with an audit trail -- never blindly
 * inherited").
 *
 * The execution path reads exactly one thing, the `xauusd_m1m5_volume_settings`
 * row, fresh for every order. Until this existed nothing wrote that row, and
 * the `XAUUSD_M1M5_VOLUME_LOTS` variable in the deployment's env file is read
 * by no code at all -- so there was no supported way to change the volume.
 *
 * Refuses a value that is not positive, or not valid for the broker's live
 * min / max / step. Never rounds to fit: a silently different volume is a
 * different trade. Does NOT refuse a volume the risk caps would refuse -- that
 * is the risk gate's call, per order, against live equity -- but reports it.
 */
import type { PrismaClient } from '@prisma/client';
import { V2_SL_USD, V2_STOP_RISK_CAP_PCT, V2_SYMBOL } from './safety-constants';
import { validateVolume } from './volume';

export interface SetVolumeInput {
  readonly accountId: string;
  readonly lots: number;
  readonly changedBy: string;
  readonly note?: string | null;
}

export type SetVolumeResult =
  | {
      readonly ok: true;
      readonly previousLots: number | null;
      readonly lots: number;
      readonly provenance: string;
      readonly stopRisk: number;
      /** Null when no equity reading exists yet. */
      readonly stopRiskPct: number | null;
      readonly aboveCap: boolean;
    }
  | { readonly ok: false; readonly reason: string };

export async function setVolume(prisma: PrismaClient, input: SetVolumeInput): Promise<SetVolumeResult> {
  const { accountId, lots, changedBy, note } = input;
  if (!Number.isFinite(lots) || lots <= 0) {
    return { ok: false, reason: `${lots} is not a positive number of lots.` };
  }

  const metadata = await prisma.symbolMetadata.findUnique({ where: { symbol: V2_SYMBOL } });
  if (!metadata) {
    return {
      ok: false,
      reason:
        `no broker metadata for ${V2_SYMBOL}, so the volume cannot be validated against the broker's ` +
        'min/max/step. Let the collector run until it has reported it, then retry.',
    };
  }
  const limits = { min: Number(metadata.volumeMin), max: Number(metadata.volumeMax), step: Number(metadata.volumeStep) };
  const check = validateVolume(lots, limits);
  if (!check.acceptable) {
    return {
      ok: false,
      reason:
        `${lots} lot is not valid for this broker (min ${limits.min}, max ${limits.max}, step ${limits.step}): ` +
        `${check.reason}. It was NOT rounded to fit.`,
    };
  }

  const previous = await prisma.xauusdM1M5VolumeSetting.findUnique({ where: { accountId } });
  const provenance = `Set to ${lots} lot by ${changedBy} with xauusd-m1m5-set-volume` + (note ? ` -- ${note}` : '') + '.';

  // One transaction: the audit record can never be missing while the change
  // itself took effect.
  await prisma.$transaction([
    prisma.xauusdM1M5VolumeSetting.upsert({
      where: { accountId },
      create: { accountId, volumeLots: lots, source: 'OPERATOR', provenance },
      update: { volumeLots: lots, source: 'OPERATOR', provenance },
    }),
    prisma.xauusdM1M5VolumeAudit.create({
      data: { accountId, previousLots: previous?.volumeLots ?? null, newLots: lots, source: 'OPERATOR', provenance, changedBy },
    }),
  ]);

  const stopRisk = V2_SL_USD * Number(metadata.contractSize) * lots;
  const snapshot = await prisma.accountSnapshot.findFirst({
    where: { accountId },
    orderBy: { capturedAt: 'desc' },
    select: { equity: true },
  });
  const stopRiskPct = snapshot ? (stopRisk / Number(snapshot.equity)) * 100 : null;

  return {
    ok: true,
    previousLots: previous ? Number(previous.volumeLots) : null,
    lots,
    provenance,
    stopRisk,
    stopRiskPct,
    aboveCap: stopRiskPct !== null && stopRiskPct > V2_STOP_RISK_CAP_PCT,
  };
}
