import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinnhubArticle, FinnhubClient } from '../../src/market-events/finnhub-client';
import { FinnhubNewsIngestionService } from '../../src/market-events/finnhub-news-ingestion.service';
import type { FinnhubConfig } from '../../src/market-events/finnhub.config';
import { resetDatabase } from '../helpers/db';

const config: FinnhubConfig = {
  enabled: true,
  apiKey: 'test-key',
  pollIntervalSeconds: 1800,
  limit: 5,
  currencies: ['EUR', 'USD'],
};

function fakeFinnhubClient(articles: FinnhubArticle[] | (() => Promise<FinnhubArticle[]>)): FinnhubClient {
  const getForexNews = typeof articles === 'function' ? vi.fn(articles) : vi.fn().mockResolvedValue(articles);
  return { getForexNews } as unknown as FinnhubClient;
}

function article(overrides: Partial<FinnhubArticle> = {}): FinnhubArticle {
  return {
    category: 'forex',
    datetime: 1788856296,
    headline: 'ECB holds rates steady',
    id: 1,
    related: '',
    source: 'Forexlive',
    summary: 'The ECB kept rates unchanged.',
    url: 'https://example.com/a1',
    ...overrides,
  };
}

describe('FinnhubNewsIngestionService', () => {
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

  it('upserts an article into a MarketEvent row with category NEWS, source FINNHUB', async () => {
    const client = fakeFinnhubClient([article()]);
    const service = new FinnhubNewsIngestionService(prisma as any, client);

    const result = await service.ingest(config);
    expect(result).toEqual({ upserted: 1, skipped: 0 });

    const rows = await prisma.marketEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'FINNHUB',
      externalId: '1',
      category: 'NEWS',
      title: 'ECB holds rates steady',
      scheduleType: 'SURPRISE',
      impact: 'MEDIUM',
      sentiment: 'UNCERTAIN',
      affectedCurrencies: ['EUR', 'USD'],
      sourceUrl: 'https://example.com/a1',
    });
  });

  it('is idempotent — running ingest twice for the same article never duplicates the row', async () => {
    const client = fakeFinnhubClient([article()]);
    const service = new FinnhubNewsIngestionService(prisma as any, client);

    await service.ingest(config);
    await service.ingest(config);

    expect(await prisma.marketEvent.count()).toBe(1);
  });

  it('handles multiple articles in one tick, each becoming its own row', async () => {
    const client = fakeFinnhubClient([
      article({ id: 1, url: 'https://example.com/a1' }),
      article({ id: 2, url: 'https://example.com/a2', datetime: 1788856300 }),
      article({ id: 3, url: 'https://example.com/a3', datetime: 1788856400 }),
    ]);
    const service = new FinnhubNewsIngestionService(prisma as any, client);

    const result = await service.ingest(config);
    expect(result).toEqual({ upserted: 3, skipped: 0 });
    expect(await prisma.marketEvent.count()).toBe(3);
  });

  it('keeps only the most recent `limit` articles, newest first', async () => {
    const client = fakeFinnhubClient([
      article({ id: 1, datetime: 100 }),
      article({ id: 2, datetime: 300 }),
      article({ id: 3, datetime: 200 }),
    ]);
    const service = new FinnhubNewsIngestionService(prisma as any, client);

    const result = await service.ingest({ ...config, limit: 2 });
    expect(result).toEqual({ upserted: 2, skipped: 0 });
    const rows = await prisma.marketEvent.findMany({ orderBy: { scheduledAt: 'desc' } });
    expect(rows.map((r) => r.externalId)).toEqual(['2', '3']);
  });

  it('skips an article missing a required field rather than crashing the whole tick', async () => {
    const client = fakeFinnhubClient([
      article({ id: 1 }),
      article({ id: 0, headline: '' } as FinnhubArticle),
    ]);
    const service = new FinnhubNewsIngestionService(prisma as any, client);

    const result = await service.ingest(config);
    expect(result).toEqual({ upserted: 1, skipped: 1 });
  });

  it('tags every article with the full configured currency list — Finnhub carries no per-article currency tagging', async () => {
    const client = fakeFinnhubClient([article()]);
    const service = new FinnhubNewsIngestionService(prisma as any, client);
    await service.ingest(config);

    const row = await prisma.marketEvent.findFirstOrThrow();
    expect(row.affectedCurrencies.sort()).toEqual(['EUR', 'USD']);
  });

  it('a provider failure propagates so the queue can retry — never swallowed silently', async () => {
    const client = { getForexNews: vi.fn().mockRejectedValue(new Error('network blip')) } as unknown as FinnhubClient;
    const service = new FinnhubNewsIngestionService(prisma as any, client);

    await expect(service.ingest(config)).rejects.toThrow('network blip');
    expect(await prisma.marketEvent.count()).toBe(0);
  });

  it('re-fetching the same article heals the title/url if they changed', async () => {
    const client = fakeFinnhubClient([article({ headline: 'Initial headline' })]);
    const service = new FinnhubNewsIngestionService(prisma as any, client);
    await service.ingest(config);

    const client2 = fakeFinnhubClient([article({ headline: 'Updated headline' })]);
    const service2 = new FinnhubNewsIngestionService(prisma as any, client2);
    await service2.ingest(config);

    const rows = await prisma.marketEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Updated headline');
  });
});
