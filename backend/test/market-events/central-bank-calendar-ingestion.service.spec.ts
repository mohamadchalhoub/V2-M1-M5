import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CentralBankCalendarIngestionService } from '../../src/market-events/central-bank-calendar-ingestion.service';
import { CentralBankCalendarProvider } from '../../src/market-events/central-bank-calendar.provider';
import { resetDatabase } from '../helpers/db';

describe('CentralBankCalendarIngestionService', () => {
  let prisma: PrismaClient;
  let service: CentralBankCalendarIngestionService;

  beforeAll(() => {
    prisma = new PrismaClient();
    service = new CentralBankCalendarIngestionService(prisma as any, new CentralBankCalendarProvider());
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('upserts curated FOMC and ECB meetings into MarketEvent rows with the correct classification', async () => {
    const result = await service.ingest();
    expect(result.upserted).toBeGreaterThan(0);

    const fomcRows = await prisma.marketEvent.findMany({ where: { source: 'FOMC' } });
    expect(fomcRows.length).toBeGreaterThan(0);
    expect(fomcRows[0]).toMatchObject({
      category: 'ECONOMIC_EVENT',
      title: 'FOMC Interest Rate Decision',
      scheduleType: 'EXPECTED',
      impact: 'HIGH',
      sentiment: 'UNCERTAIN',
      affectedCurrencies: ['USD'],
    });

    const ecbRows = await prisma.marketEvent.findMany({ where: { source: 'ECB' } });
    expect(ecbRows.length).toBeGreaterThan(0);
    expect(ecbRows[0]).toMatchObject({
      category: 'ECONOMIC_EVENT',
      title: 'ECB Governing Council Interest Rate Decision',
      impact: 'HIGH',
      affectedCurrencies: ['EUR'],
    });
  });

  it('is idempotent — running ingest twice never duplicates any row', async () => {
    const first = await service.ingest();
    const countAfterFirst = await prisma.marketEvent.count();

    const second = await service.ingest();
    const countAfterSecond = await prisma.marketEvent.count();

    expect(second.upserted).toBe(first.upserted);
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it('the resulting rows are queryable through the existing MarketEventQueryService, unchanged', async () => {
    await service.ingest();

    // Same read path HIGH_IMPACT_EVENT_EXPOSURE (rule engine) and
    // MarketContextBuilderService (AI) already use — proves zero changes
    // were needed on either consumer for this new source's events to appear.
    const { MarketEventQueryService } = await import('../../src/market-events/market-event-query.service');
    const query = new MarketEventQueryService(prisma as any);
    const upcoming = await query.findUpcomingHighImpactEvents(['USD', 'EUR'], new Date('2026-09-01T00:00:00Z'), 60 * 24 * 60);
    expect(upcoming.some((e) => e.title === 'FOMC Interest Rate Decision')).toBe(true);
    expect(upcoming.some((e) => e.title === 'ECB Governing Council Interest Rate Decision')).toBe(true);
  });
});
