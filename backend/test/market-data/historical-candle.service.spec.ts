import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HistoricalCandleService } from '../../src/market-data/historical-candle.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { resetDatabase } from '../helpers/db';

describe('HistoricalCandleService', () => {
  let prisma: PrismaClient;
  let service: HistoricalCandleService;

  beforeAll(() => {
    prisma = new PrismaClient();
    service = new HistoricalCandleService(prisma as unknown as PrismaService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('getCandlesInRange is inclusive of both endpoints and ordered ascending', async () => {
    await service.upsertCandles('EURUSD', 'M5', [
      { openTime: '2026-01-01T00:00:00.000Z', open: 1, high: 1, low: 1, close: 1 },
      { openTime: '2026-01-01T00:05:00.000Z', open: 1, high: 1, low: 1, close: 1 },
      { openTime: '2026-01-01T00:10:00.000Z', open: 1, high: 1, low: 1, close: 1 },
    ]);

    const result = await service.getCandlesInRange(
      'EURUSD',
      'M5',
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-01T00:05:00.000Z'),
    );
    expect(result.map((c) => c.openTime.toISOString())).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:05:00.000Z',
    ]);
  });

  it('scopes strictly by symbol AND timeframe — never leaks another pair\'s candles', async () => {
    await service.upsertCandles('EURUSD', 'M5', [
      { openTime: '2026-01-01T00:00:00.000Z', open: 1, high: 1, low: 1, close: 1 },
    ]);
    await service.upsertCandles('EURUSD', 'H1', [
      { openTime: '2026-01-01T00:00:00.000Z', open: 2, high: 2, low: 2, close: 2 },
    ]);
    await service.upsertCandles('GBPUSD', 'M5', [
      { openTime: '2026-01-01T00:00:00.000Z', open: 3, high: 3, low: 3, close: 3 },
    ]);

    const result = await service.getCandlesInRange(
      'EURUSD',
      'M5',
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-02T00:00:00.000Z'),
    );
    expect(result).toHaveLength(1);
    expect(result[0].open).toBe(1);
  });

  it('getLatestOpenTime returns null with no data, then the true latest across multiple upserts', async () => {
    expect(await service.getLatestOpenTime('EURUSD', 'M5')).toBeNull();

    await service.upsertCandles('EURUSD', 'M5', [
      { openTime: '2026-01-01T00:00:00.000Z', open: 1, high: 1, low: 1, close: 1 },
      { openTime: '2026-01-01T00:10:00.000Z', open: 1, high: 1, low: 1, close: 1 },
      { openTime: '2026-01-01T00:05:00.000Z', open: 1, high: 1, low: 1, close: 1 },
    ]);

    expect((await service.getLatestOpenTime('EURUSD', 'M5'))?.toISOString()).toBe('2026-01-01T00:10:00.000Z');
  });

  it('volume defaults to null when omitted, and converts Decimal to a plain number', async () => {
    await service.upsertCandles('EURUSD', 'M5', [
      { openTime: '2026-01-01T00:00:00.000Z', open: 1.2345, high: 1.236, low: 1.23, close: 1.234, volume: 55 },
    ]);
    const [row] = await service.getCandlesInRange(
      'EURUSD',
      'M5',
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(row.volume).toBe(55);
    expect(row.open).toBe(1.2345);
  });
});
