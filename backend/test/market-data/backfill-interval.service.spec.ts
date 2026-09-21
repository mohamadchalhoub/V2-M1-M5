import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BackfillIntervalService } from '../../src/market-data/backfill-interval.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { resetDatabase } from '../helpers/db';

describe('BackfillIntervalService', () => {
  let prisma: PrismaClient;
  let service: BackfillIntervalService;

  beforeAll(() => {
    prisma = new PrismaClient();
    service = new BackfillIntervalService(prisma as unknown as PrismaService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  const range = { rangeStart: new Date('2026-01-01T00:00:00.000Z'), rangeEnd: new Date('2026-01-02T00:00:00.000Z') };

  it('creates a PENDING row with completedAt null', async () => {
    const row = await service.upsertInterval({ symbol: 'XAUUSD', dataType: 'CANDLE', timeframe: 'H1', status: 'PENDING', ...range });
    expect(row.status).toBe('PENDING');
    expect(row.completedAt).toBeNull();
    expect(row.timeframeKey).toBe('H1');
  });

  it('transitions PENDING -> COMPLETED on the same identity, setting completedAt, without creating a second row', async () => {
    const pending = await service.upsertInterval({ symbol: 'XAUUSD', dataType: 'CANDLE', timeframe: 'H1', status: 'PENDING', ...range });
    expect(pending.completedAt).toBeNull();

    const completed = await service.upsertInterval({
      symbol: 'XAUUSD',
      dataType: 'CANDLE',
      timeframe: 'H1',
      status: 'COMPLETED',
      recordCount: 24,
      ...range,
    });
    expect(completed.id).toBe(pending.id);
    expect(completed.status).toBe('COMPLETED');
    expect(completed.recordCount).toBe(24);
    expect(completed.completedAt).not.toBeNull();

    expect(await prisma.backfillInterval.count()).toBe(1);
  });

  it('EMPTY_CONFIRMED also sets completedAt; FAILED/INCOMPLETE/PENDING/EMPTY_UNCONFIRMED/SUSPECTED_TRUNCATED do not', async () => {
    const nonCompleting: Array<'PENDING' | 'EMPTY_UNCONFIRMED' | 'FAILED' | 'INCOMPLETE' | 'SUSPECTED_TRUNCATED'> = [
      'PENDING',
      'EMPTY_UNCONFIRMED',
      'FAILED',
      'INCOMPLETE',
      'SUSPECTED_TRUNCATED',
    ];
    for (const status of nonCompleting) {
      const row = await service.upsertInterval({ symbol: 'XAUUSD', dataType: 'CANDLE', timeframe: 'M5', status, ...range });
      expect(row.completedAt).toBeNull();
    }
    const confirmed = await service.upsertInterval({ symbol: 'XAUUSD', dataType: 'CANDLE', timeframe: 'M5', status: 'EMPTY_CONFIRMED', ...range });
    expect(confirmed.completedAt).not.toBeNull();
  });

  it('re-upserting to a non-completion status clears a previously-set completedAt', async () => {
    await service.upsertInterval({ symbol: 'XAUUSD', dataType: 'CANDLE', timeframe: 'H1', status: 'COMPLETED', ...range });
    const demoted = await service.upsertInterval({ symbol: 'XAUUSD', dataType: 'CANDLE', timeframe: 'H1', status: 'INCOMPLETE', evidence: 'resource guard paused', ...range });
    expect(demoted.completedAt).toBeNull();
  });

  it('a TICK interval uses the "_TICK_" timeframeKey and leaves timeframe null', async () => {
    const row = await service.upsertInterval({ symbol: 'XAUUSD', dataType: 'TICK', status: 'PENDING', ...range });
    expect(row.timeframe).toBeNull();
    expect(row.timeframeKey).toBe('_TICK_');
  });

  it('a CANDLE interval and a TICK interval on the identical range are distinct rows', async () => {
    await service.upsertInterval({ symbol: 'XAUUSD', dataType: 'CANDLE', timeframe: 'H1', status: 'PENDING', ...range });
    await service.upsertInterval({ symbol: 'XAUUSD', dataType: 'TICK', status: 'PENDING', ...range });
    expect(await prisma.backfillInterval.count()).toBe(2);
  });

  it('queryIntervals orders by rangeStart ascending and filters by dataType/timeframe/status', async () => {
    await service.upsertInterval({
      symbol: 'XAUUSD',
      dataType: 'CANDLE',
      timeframe: 'H1',
      status: 'COMPLETED',
      rangeStart: new Date('2026-01-02T00:00:00.000Z'),
      rangeEnd: new Date('2026-01-03T00:00:00.000Z'),
    });
    await service.upsertInterval({
      symbol: 'XAUUSD',
      dataType: 'CANDLE',
      timeframe: 'H1',
      status: 'FAILED',
      rangeStart: new Date('2026-01-01T00:00:00.000Z'),
      rangeEnd: new Date('2026-01-02T00:00:00.000Z'),
    });
    await service.upsertInterval({ symbol: 'XAUUSD', dataType: 'TICK', status: 'PENDING', ...range });
    await service.upsertInterval({ symbol: 'EURUSD', dataType: 'CANDLE', timeframe: 'H1', status: 'COMPLETED', ...range });

    const all = await service.queryIntervals({ symbol: 'XAUUSD', dataType: 'CANDLE', timeframe: 'H1' });
    expect(all).toHaveLength(2);
    expect(all[0].rangeStart.toISOString()).toBe('2026-01-01T00:00:00.000Z');

    const filtered = await service.queryIntervals({ symbol: 'XAUUSD', dataType: 'CANDLE', timeframe: 'H1', statuses: ['COMPLETED'] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].status).toBe('COMPLETED');
  });
});
