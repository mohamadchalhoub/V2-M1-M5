import { PrismaClient } from '@prisma/client';
import { PositionBehaviorMetrics } from '../types/analytics.types';
import { inDealVolumeStats } from '../queries';
import { decimalToNumber, round2, round4 } from '../util';

export async function computePositionBehaviorMetrics(
  prisma: PrismaClient,
  accountId: string,
): Promise<PositionBehaviorMetrics> {
  const [openPositions, historicalVolume] = await Promise.all([
    prisma.position.findMany({
      where: { accountId, status: 'OPEN' },
      select: { volume: true, symbol: true, side: true, stopLoss: true },
    }),
    inDealVolumeStats(prisma, accountId),
  ]);

  const currentOpenPositions = openPositions.length;
  const currentTotalVolume = round2(
    openPositions.reduce((sum, p) => sum + decimalToNumber(p.volume), 0),
  );
  const maximumPositionVolume =
    openPositions.length === 0
      ? null
      : round2(Math.max(...openPositions.map((p) => decimalToNumber(p.volume))));

  const bySymbol = new Map<string, { totalVolume: number; count: number }>();
  for (const p of openPositions) {
    const vol = decimalToNumber(p.volume);
    const existing = bySymbol.get(p.symbol);
    if (existing) {
      existing.totalVolume += vol;
      existing.count += 1;
    } else {
      bySymbol.set(p.symbol, { totalVolume: vol, count: 1 });
    }
  }
  const positionVolumeBySymbol = Array.from(bySymbol.entries())
    .map(([symbol, v]) => ({ symbol, totalVolume: round2(v.totalVolume), count: v.count }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  // Live-test production-readiness pass (item E, NO_STOP_LOSS) — a direct
  // count over the same open-positions rows fetched above; never null (0 for
  // no positions or all-protected alike — both are "nothing to warn about").
  const openPositionsWithoutStopLoss = openPositions.filter((p) => p.stopLoss === null).length;

  // Item F, CONCENTRATION — symbol concentration reuses the bySymbol totals
  // just computed above; direction concentration buckets the same rows by
  // BUY/SELL. Both null when nothing is open (currentTotalVolume === 0) —
  // "0% concentrated" is misleading when there's nothing to concentrate.
  const maximumSymbolConcentrationPct =
    currentTotalVolume > 0
      ? round4(Math.max(...positionVolumeBySymbol.map((s) => s.totalVolume)) / currentTotalVolume)
      : null;

  const volumeByDirection = new Map<string, number>();
  for (const p of openPositions) {
    const vol = decimalToNumber(p.volume);
    volumeByDirection.set(p.side, (volumeByDirection.get(p.side) ?? 0) + vol);
  }
  const maximumDirectionConcentrationPct =
    currentTotalVolume > 0
      ? round4(Math.max(...volumeByDirection.values()) / currentTotalVolume)
      : null;

  return {
    currentOpenPositions,
    currentTotalVolume,
    maximumPositionVolume,
    positionVolumeBySymbol,
    numberOfSimultaneousPositions: currentOpenPositions,
    averageHistoricalPositionVolume:
      historicalVolume.average === null ? null : round2(historicalVolume.average),
    openPositionsWithoutStopLoss,
    maximumSymbolConcentrationPct,
    maximumDirectionConcentrationPct,
  };
}
