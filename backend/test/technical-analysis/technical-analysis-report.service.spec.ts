import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TechnicalAnalysisReportService } from '../../src/technical-analysis/technical-analysis-report.service';
import { loadTechnicalAnalysisConfig } from '../../src/technical-analysis/technical-analysis.config';
import { HistoricalCandleService } from '../../src/market-data/historical-candle.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { resetDatabase } from '../helpers/db';

const NOW = new Date('2026-09-08T12:00:00Z');
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** 5 H1 candles centered on `centerTime`, with a clean fractal-high peak (and non-extreme low) at the middle candle — registers as exactly one RESISTANCE level, nothing else. */
async function seedH1ResistancePivot(prisma: PrismaClient, centerTime: Date, peakPrice: number) {
  const highs = [peakPrice - 0.001, peakPrice - 0.0005, peakPrice, peakPrice - 0.0005, peakPrice - 0.001];
  for (let i = 0; i < 5; i++) {
    const openTime = new Date(centerTime.getTime() + (i - 2) * HOUR_MS);
    const high = highs[i];
    await prisma.historicalCandle.create({
      data: {
        symbol: 'EURUSD',
        timeframe: 'H1',
        openTime,
        open: high - 0.0002,
        high,
        low: high - 0.001, // shaped the same as `high` — never the extreme low, so no spurious SUPPORT pivot forms
        close: high - 0.0003,
        source: 'MT5',
      },
    });
  }
}

describe('TechnicalAnalysisReportService.getSupportResistanceLevels — H1 dynamic lookback with fallback', () => {
  let prisma: PrismaClient;
  let service: TechnicalAnalysisReportService;

  beforeAll(() => {
    prisma = new PrismaClient();
    const candles = new HistoricalCandleService(prisma as unknown as PrismaService);
    const config = loadTechnicalAnalysisConfig({ get: () => undefined } as any);
    service = new TechnicalAnalysisReportService(candles, config);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('finds a level from within the last 14 days without expanding', async () => {
    const recent = new Date(NOW.getTime() - 5 * DAY_MS);
    await seedH1ResistancePivot(prisma, recent, 1.165);

    const levels = await service.getSupportResistanceLevels('H1', NOW);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toMatchObject({ type: 'RESISTANCE', timeframe: 'H1' });
  });

  it('finds nothing when there are fewer than 5 H1 candles in the last 14 days and none further back — terminates at the cap, no infinite loop', async () => {
    const levels = await service.getSupportResistanceLevels('H1', NOW);
    expect(levels).toEqual([]);
  });

  it('expands past 14 days when nothing recent exists, and finds an older level', async () => {
    // Nothing within the last 14 days; a real pivot 40 days back — outside
    // the initial window, but within the 14->28->56 expansion sequence.
    const older = new Date(NOW.getTime() - 40 * DAY_MS);
    await seedH1ResistancePivot(prisma, older, 1.17);

    const levels = await service.getSupportResistanceLevels('H1', NOW);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toMatchObject({ type: 'RESISTANCE', timeframe: 'H1', price: 1.17 });
  });

  it('does not find a level older than the 365-day cap', async () => {
    const tooOld = new Date(NOW.getTime() - 400 * DAY_MS);
    await seedH1ResistancePivot(prisma, tooOld, 1.18);

    const levels = await service.getSupportResistanceLevels('H1', NOW);
    expect(levels).toEqual([]);
  });

  it('H4 is unaffected by the H1-only dynamic window — still finds a level well outside 14 days, using its own unchanged 90-day lookback', async () => {
    const beyond14Days = new Date(NOW.getTime() - 40 * DAY_MS);
    const highs = [1.169, 1.1695, 1.17, 1.1695, 1.169];
    for (let i = 0; i < 5; i++) {
      const openTime = new Date(beyond14Days.getTime() + (i - 2) * 4 * HOUR_MS);
      const high = highs[i];
      await prisma.historicalCandle.create({
        data: { symbol: 'EURUSD', timeframe: 'H4', openTime, open: high - 0.0002, high, low: high - 0.001, close: high - 0.0003, source: 'MT5' },
      });
    }

    const levels = await service.getSupportResistanceLevels('H4', NOW);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toMatchObject({ type: 'RESISTANCE', timeframe: 'H4', price: 1.17 });
  });

  it('D1 is unaffected by the H1-only dynamic window — same 500-day lookback as always', async () => {
    const beyond14Days = new Date(NOW.getTime() - 40 * DAY_MS);
    const highs = [1.171, 1.1715, 1.172, 1.1715, 1.171];
    for (let i = 0; i < 5; i++) {
      const openTime = new Date(beyond14Days.getTime() + (i - 2) * DAY_MS);
      const high = highs[i];
      await prisma.historicalCandle.create({
        data: { symbol: 'EURUSD', timeframe: 'D1', openTime, open: high - 0.0002, high, low: high - 0.001, close: high - 0.0003, source: 'MT5' },
      });
    }

    const levels = await service.getSupportResistanceLevels('D1', NOW);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toMatchObject({ type: 'RESISTANCE', timeframe: 'D1', price: 1.172 });
  });
});
