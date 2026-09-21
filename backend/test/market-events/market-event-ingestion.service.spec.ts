import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketEventIngestionService } from '../../src/market-events/market-event-ingestion.service';
import type { FredClient, FredReleaseDate } from '../../src/market-events/fred-client';
import type { MarketEventsConfig } from '../../src/market-events/market-events.config';
import { resetDatabase } from '../helpers/db';

const config: MarketEventsConfig = {
  enabled: true,
  fredApiKey: 'test-key',
  fetchIntervalSeconds: 86400,
  lookaheadDays: 14,
};

function fakeFredClient(releaseDates: FredReleaseDate[]): FredClient {
  return { getUpcomingReleaseDates: vi.fn().mockResolvedValue(releaseDates) } as unknown as FredClient;
}

describe('MarketEventIngestionService', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('upserts a curated release into a MarketEvent row with the correct classification', async () => {
    const fred = fakeFredClient([{ releaseId: 50, releaseName: 'Employment Situation', date: '2026-10-02' }]);
    const service = new MarketEventIngestionService(prisma as any, fred);

    const result = await service.ingest(config);
    expect(result).toEqual({ upserted: 1, skipped: 0 });

    const rows = await prisma.marketEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'FRED',
      externalId: '50',
      title: 'Employment Situation (Nonfarm Payrolls)',
      scheduleType: 'EXPECTED',
      impact: 'HIGH',
      sentiment: 'UNCERTAIN',
      affectedCurrencies: ['USD'],
    });
  });

  it('skips a release id that is not on the curated allowlist, storing nothing for it', async () => {
    const fred = fakeFredClient([{ releaseId: 999999, releaseName: 'Some Obscure Daily Series', date: '2026-10-02' }]);
    const service = new MarketEventIngestionService(prisma as any, fred);

    const result = await service.ingest(config);
    expect(result).toEqual({ upserted: 0, skipped: 1 });
    expect(await prisma.marketEvent.count()).toBe(0);
  });

  it('is idempotent — running ingest twice for the same release/date never duplicates the row', async () => {
    const fred = fakeFredClient([{ releaseId: 10, releaseName: 'Consumer Price Index', date: '2026-10-14' }]);
    const service = new MarketEventIngestionService(prisma as any, fred);

    await service.ingest(config);
    await service.ingest(config);

    expect(await prisma.marketEvent.count()).toBe(1);
  });

  it('converts the ET release time to UTC correctly across both EST and EDT (DST-aware)', async () => {
    // NFP (release 50, 8:30am ET) on a January date (EST, UTC-5) and a July
    // date (EDT, UTC-4) — a fixed UTC-5 offset would get the July one wrong
    // by an hour.
    const fred = fakeFredClient([
      { releaseId: 50, releaseName: 'Employment Situation', date: '2026-01-09' },
      { releaseId: 50, releaseName: 'Employment Situation', date: '2026-07-03' },
    ]);
    const service = new MarketEventIngestionService(prisma as any, fred);
    await service.ingest(config);

    const rows = await prisma.marketEvent.findMany({ orderBy: { scheduledAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0].scheduledAt.toISOString()).toBe('2026-01-09T13:30:00.000Z'); // EST: UTC-5
    expect(rows[1].scheduledAt.toISOString()).toBe('2026-07-03T12:30:00.000Z'); // EDT: UTC-4
  });

  it('re-ingesting after a curated allowlist correction updates the existing row rather than leaving it stale', async () => {
    const fred = fakeFredClient([{ releaseId: 50, releaseName: 'Employment Situation', date: '2026-10-02' }]);
    const service = new MarketEventIngestionService(prisma as any, fred);
    await service.ingest(config);

    // Simulate drift between the stored row and the curated table (e.g. an
    // operator manually edited the row) — the next ingest tick should heal
    // it back to the curated title, not leave it diverged forever.
    await prisma.marketEvent.updateMany({ data: { title: 'stale title from before a correction' } });
    await service.ingest(config);

    const rows = await prisma.marketEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Employment Situation (Nonfarm Payrolls)');
  });
});
