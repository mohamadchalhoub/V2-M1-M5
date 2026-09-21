import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketNewsIngestionService } from '../../src/market-events/market-news-ingestion.service';
import { MarketauxArticle, MarketauxClient, MarketauxRateLimitError } from '../../src/market-events/marketaux-client';
import type { MarketauxConfig } from '../../src/market-events/marketaux.config';
import { resetDatabase } from '../helpers/db';

const config: MarketauxConfig = {
  enabled: true,
  apiToken: 'test-token',
  pollIntervalSeconds: 3600,
  currencies: ['EUR', 'USD'],
  limit: 3,
};

function fakeMarketauxClient(articles: MarketauxArticle[] | (() => Promise<MarketauxArticle[]>)): MarketauxClient {
  const getNews = typeof articles === 'function' ? vi.fn(articles) : vi.fn().mockResolvedValue(articles);
  return { getNews } as unknown as MarketauxClient;
}

describe('MarketNewsIngestionService', () => {
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

  it('upserts an article into a MarketEvent row with category NEWS', async () => {
    const client = fakeMarketauxClient([
      {
        uuid: 'a1',
        title: 'ECB holds rates steady',
        description: 'The ECB kept EUR rates unchanged.',
        url: 'https://example.com/a1',
        published_at: '2026-09-05T10:00:00.000Z',
        entities: [{ symbol: 'EUR', sentiment_score: 0.4 }],
      },
    ]);
    const service = new MarketNewsIngestionService(prisma as any, client);

    const result = await service.ingest(config);
    expect(result).toEqual({ upserted: 1, skipped: 0 });

    const rows = await prisma.marketEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'MARKETAUX',
      externalId: 'a1',
      category: 'NEWS',
      title: 'ECB holds rates steady',
      scheduleType: 'SURPRISE',
      impact: 'MEDIUM',
      sentiment: 'POSITIVE',
      affectedCurrencies: ['EUR'],
      sourceUrl: 'https://example.com/a1',
    });
  });

  it('is idempotent — running ingest twice for the same article never duplicates the row', async () => {
    const client = fakeMarketauxClient([
      { uuid: 'a1', title: 'Same article', url: 'https://example.com/a1', published_at: '2026-09-05T10:00:00.000Z' },
    ]);
    const service = new MarketNewsIngestionService(prisma as any, client);

    await service.ingest(config);
    await service.ingest(config);

    expect(await prisma.marketEvent.count()).toBe(1);
  });

  it('handles multiple articles in one tick, each becoming its own row', async () => {
    const client = fakeMarketauxClient([
      { uuid: 'a1', title: 'Article one', url: 'https://example.com/a1', published_at: '2026-09-05T10:00:00.000Z' },
      { uuid: 'a2', title: 'Article two', url: 'https://example.com/a2', published_at: '2026-09-05T11:00:00.000Z' },
      { uuid: 'a3', title: 'Article three', url: 'https://example.com/a3', published_at: '2026-09-05T12:00:00.000Z' },
    ]);
    const service = new MarketNewsIngestionService(prisma as any, client);

    const result = await service.ingest(config);
    expect(result).toEqual({ upserted: 3, skipped: 0 });
    expect(await prisma.marketEvent.count()).toBe(3);
  });

  it('skips an article missing a required field rather than crashing the whole tick', async () => {
    const client = fakeMarketauxClient([
      { uuid: 'a1', title: 'Good article', url: 'https://example.com/a1', published_at: '2026-09-05T10:00:00.000Z' },
      { uuid: '', title: 'Missing uuid', url: 'https://example.com/a2', published_at: '2026-09-05T10:00:00.000Z' } as MarketauxArticle,
    ]);
    const service = new MarketNewsIngestionService(prisma as any, client);

    const result = await service.ingest(config);
    expect(result).toEqual({ upserted: 1, skipped: 1 });
  });

  it('defaults sentiment to UNCERTAIN when no entity carries a sentiment_score', async () => {
    const client = fakeMarketauxClient([
      { uuid: 'a1', title: 'No entities here', url: 'https://example.com/a1', published_at: '2026-09-05T10:00:00.000Z' },
    ]);
    const service = new MarketNewsIngestionService(prisma as any, client);
    await service.ingest(config);

    const row = await prisma.marketEvent.findFirstOrThrow();
    expect(row.sentiment).toBe('UNCERTAIN');
  });

  it('falls back to the full configured currency list when no currency literally appears in the text', async () => {
    const client = fakeMarketauxClient([
      { uuid: 'a1', title: 'Global markets react to central bank moves', url: 'https://example.com/a1', published_at: '2026-09-05T10:00:00.000Z' },
    ]);
    const service = new MarketNewsIngestionService(prisma as any, client);
    await service.ingest(config);

    const row = await prisma.marketEvent.findFirstOrThrow();
    expect(row.affectedCurrencies.sort()).toEqual(['EUR', 'USD']);
  });

  it('a rate-limit error is caught and never crashes the ingestion tick', async () => {
    const client = { getNews: vi.fn().mockRejectedValue(new MarketauxRateLimitError('429')) } as unknown as MarketauxClient;
    const service = new MarketNewsIngestionService(prisma as any, client);

    const result = await service.ingest(config);
    expect(result).toEqual({ upserted: 0, skipped: 0 });
    expect(await prisma.marketEvent.count()).toBe(0);
  });

  it('a generic provider failure propagates so the queue can retry — never swallowed silently', async () => {
    const client = { getNews: vi.fn().mockRejectedValue(new Error('network blip')) } as unknown as MarketauxClient;
    const service = new MarketNewsIngestionService(prisma as any, client);

    await expect(service.ingest(config)).rejects.toThrow('network blip');
  });

  it('re-fetching the same article heals sentiment/title if they changed', async () => {
    const client = fakeMarketauxClient([
      { uuid: 'a1', title: 'Initial headline', url: 'https://example.com/a1', published_at: '2026-09-05T10:00:00.000Z' },
    ]);
    const service = new MarketNewsIngestionService(prisma as any, client);
    await service.ingest(config);

    const client2 = fakeMarketauxClient([
      { uuid: 'a1', title: 'Updated headline', url: 'https://example.com/a1', published_at: '2026-09-05T10:00:00.000Z' },
    ]);
    const service2 = new MarketNewsIngestionService(prisma as any, client2);
    await service2.ingest(config);

    const rows = await prisma.marketEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Updated headline');
  });
});
