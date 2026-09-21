import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HistoricalTickService } from '../../src/market-data/historical-tick.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { resetDatabase } from '../helpers/db';

describe('HistoricalTickService', () => {
  let prisma: PrismaClient;
  let service: HistoricalTickService;

  beforeAll(() => {
    prisma = new PrismaClient();
    service = new HistoricalTickService(prisma as unknown as PrismaService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('upserts every distinct tick and reports the true inserted count', async () => {
    const result = await service.upsertTicks('XAUUSD', null, null, null, [
      { timestamp: '2026-01-01T00:00:00.000Z', bid: 2400.1, ask: 2400.3, flags: 6, batchSeq: 0 },
      { timestamp: '2026-01-01T00:00:01.000Z', bid: 2400.2, ask: 2400.4, flags: 6, batchSeq: 1 },
    ]);
    expect(result).toEqual({ inserted: 2 });

    const rows = await prisma.historicalTick.findMany({ orderBy: { timestamp: 'asc' } });
    expect(rows).toHaveLength(2);
  });

  it('dedupes two identical rows within the same batch, keeping one — batchSeq is not part of identity', async () => {
    const result = await service.upsertTicks('XAUUSD', null, null, null, [
      { timestamp: '2026-01-01T00:00:00.000Z', bid: 2400.1, ask: 2400.3, flags: 6, batchSeq: 0 },
      { timestamp: '2026-01-01T00:00:00.000Z', bid: 2400.1, ask: 2400.3, flags: 6, batchSeq: 5 },
    ]);
    expect(result).toEqual({ inserted: 1 });
    expect(await prisma.historicalTick.count()).toBe(1);
  });

  it('re-ingesting the exact same batch a second time inserts 0 — idempotent, no DB error', async () => {
    const ticks = [{ timestamp: '2026-01-01T00:00:00.000Z', bid: 2400.1, ask: 2400.3, flags: 6, batchSeq: 0 }];
    const first = await service.upsertTicks('XAUUSD', 'XAUUSD.a', 'MetaQuotes-Demo', null, ticks);
    expect(first.inserted).toBe(1);

    const second = await service.upsertTicks('XAUUSD', 'XAUUSD.a', 'MetaQuotes-Demo', null, ticks);
    expect(second.inserted).toBe(0);

    expect(await prisma.historicalTick.count()).toBe(1);
  });

  it('an empty batch is a no-op and never issues a query', async () => {
    const result = await service.upsertTicks('XAUUSD', null, null, null, []);
    expect(result).toEqual({ inserted: 0 });
  });

  it('getCoverage returns null earliest/latest with no data, then the real range after ingestion', async () => {
    expect(await service.getCoverage('XAUUSD')).toEqual({ symbol: 'XAUUSD', count: 0, earliest: null, latest: null });

    await service.upsertTicks('XAUUSD', null, null, null, [
      { timestamp: '2026-01-01T00:00:00.000Z', bid: 2400.1, ask: 2400.3, flags: 6, batchSeq: 0 },
      { timestamp: '2026-01-01T00:10:00.000Z', bid: 2400.5, ask: 2400.7, flags: 6, batchSeq: 1 },
    ]);

    const coverage = await service.getCoverage('XAUUSD');
    expect(coverage.count).toBe(2);
    expect(coverage.earliest?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(coverage.latest?.toISOString()).toBe('2026-01-01T00:10:00.000Z');
  });

  it('scopes coverage strictly by symbol', async () => {
    await service.upsertTicks('XAUUSD', null, null, null, [{ timestamp: '2026-01-01T00:00:00.000Z', bid: 1, ask: 1.001, flags: 6, batchSeq: 0 }]);
    await service.upsertTicks('EURUSD', null, null, null, [{ timestamp: '2026-01-01T00:00:00.000Z', bid: 1.1, ask: 1.101, flags: 6, batchSeq: 0 }]);

    expect((await service.getCoverage('XAUUSD')).count).toBe(1);
    expect((await service.getCoverage('EURUSD')).count).toBe(1);
  });
});
