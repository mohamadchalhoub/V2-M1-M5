import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MarketContextBuilderService } from '../../src/ai/market-context-builder.service';
import { MarketEventQueryService } from '../../src/market-events/market-event-query.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser, validPositionPayload } from '../helpers/factories';

describe('MarketContextBuilderService', () => {
  let prisma: PrismaClient;
  let service: MarketContextBuilderService;

  beforeAll(() => {
    prisma = new PrismaClient();
    service = new MarketContextBuilderService(prisma as unknown as PrismaService, new MarketEventQueryService(prisma as unknown as PrismaService));
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('always includes EUR/USD even with no open positions — this system only ever monitors EURUSD, so news/calendar context should never depend on currently holding a position', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);

    const result = await service.build(account.id, new Date());
    expect(result.exposedCurrencies.sort()).toEqual(['EUR', 'USD']);
    // No market_events rows exist at all in this test's DB — empty events/news
    // here reflects "nothing to find," not "nothing was searched for."
    expect(result.upcomingHighImpactEvents).toEqual([]);
    expect(result.recentNews).toEqual([]);
  });

  it('finds real EUR/USD events with zero open positions — the exact gap a live system audit found: MarketContextBuilderService used to derive currencies ONLY from open positions, so an account with none got empty market context despite real Finnhub/FRED data existing', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const now = new Date();
    await prisma.marketEvent.create({
      data: {
        source: 'FRED',
        externalId: '51',
        category: 'ECONOMIC_EVENT',
        title: 'Unemployment Claims',
        scheduleType: 'EXPECTED',
        impact: 'HIGH',
        sentiment: 'UNCERTAIN',
        affectedCurrencies: ['USD'],
        scheduledAt: new Date(now.getTime() + 60 * 60_000),
        rawPayload: {},
      },
    });
    await prisma.marketEvent.create({
      data: {
        source: 'FINNHUB',
        externalId: 'article-2',
        category: 'NEWS',
        title: 'ECB holds rates steady',
        scheduleType: 'SURPRISE',
        impact: 'MEDIUM',
        sentiment: 'NEUTRAL',
        affectedCurrencies: ['EUR'],
        scheduledAt: new Date(now.getTime() - 60 * 60_000),
        sourceUrl: 'https://example.com/a2',
        rawPayload: {},
      },
    });

    // No open positions for this account — the scenario that used to return empty everything.
    const result = await service.build(account.id, now);
    expect(result.upcomingHighImpactEvents).toHaveLength(1);
    expect(result.upcomingHighImpactEvents[0]).toMatchObject({ title: 'Unemployment Claims' });
    expect(result.recentNews).toHaveLength(1);
    expect(result.recentNews[0]).toMatchObject({ title: 'ECB holds rates steady' });
  });

  it('derives exposed currencies from open positions and includes an upcoming HIGH-impact event affecting one of them', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const payload = validPositionPayload({ symbol: 'EURUSD' });
    await prisma.position.create({
      data: {
        accountId: account.id,
        platform: 'MT5',
        externalPositionId: payload.externalPositionId,
        symbol: payload.symbol,
        side: 'BUY',
        volume: 1,
        openPrice: 1.1,
        openedAt: new Date(),
        status: 'OPEN',
      },
    });
    const now = new Date();
    await prisma.marketEvent.create({
      data: {
        source: 'FRED',
        externalId: '50',
        category: 'ECONOMIC_EVENT',
        title: 'Employment Situation',
        scheduleType: 'EXPECTED',
        impact: 'HIGH',
        sentiment: 'UNCERTAIN',
        affectedCurrencies: ['USD'],
        scheduledAt: new Date(now.getTime() + 60 * 60_000),
        rawPayload: {},
      },
    });
    await prisma.marketEvent.create({
      data: {
        source: 'MARKETAUX',
        externalId: 'article-1',
        category: 'NEWS',
        title: 'ECB signals steady policy',
        scheduleType: 'SURPRISE',
        impact: 'MEDIUM',
        sentiment: 'POSITIVE',
        affectedCurrencies: ['EUR'],
        scheduledAt: new Date(now.getTime() - 60 * 60_000),
        sourceUrl: 'https://example.com/a1',
        rawPayload: {},
      },
    });

    const result = await service.build(account.id, now);
    expect(result.exposedCurrencies.sort()).toEqual(['EUR', 'USD']);
    expect(result.upcomingHighImpactEvents).toHaveLength(1);
    expect(result.upcomingHighImpactEvents[0]).toMatchObject({ title: 'Employment Situation', affectedCurrencies: ['USD'] });
    expect(result.recentNews).toHaveLength(1);
    expect(result.recentNews[0]).toMatchObject({ title: 'ECB signals steady policy', sentiment: 'POSITIVE', sourceUrl: 'https://example.com/a1' });
  });

  it('ignores a non-forex symbol (no parseable currency pair) when deriving exposure — falls back to just the always-included EUR/USD', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    await prisma.position.create({
      data: {
        accountId: account.id,
        platform: 'MT5',
        externalPositionId: 'p1',
        symbol: 'US30',
        side: 'BUY',
        volume: 1,
        openPrice: 40000,
        openedAt: new Date(),
        status: 'OPEN',
      },
    });

    const result = await service.build(account.id, new Date());
    expect(result.exposedCurrencies.sort()).toEqual(['EUR', 'USD']);
  });
});
