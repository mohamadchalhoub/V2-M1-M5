import { Injectable } from '@nestjs/common';
import { MarketEventCategory, MarketEventImpact } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface UpcomingMarketEvent {
  id: string;
  title: string;
  scheduledAt: Date;
  affectedCurrencies: string[];
  impact: MarketEventImpact;
}

export interface RecentMarketNews {
  id: string;
  title: string;
  scheduledAt: Date;
  affectedCurrencies: string[];
  sentiment: string;
  sourceUrl: string | null;
}

/**
 * The one read path into `market_events` for consumers outside this module
 * (the rule engine's HIGH_IMPACT_EVENT_EXPOSURE evaluator, and later the AI
 * context builder) — market-events.module.ts's ingestion services stay
 * write-only/internal; nothing outside this module queries the Prisma model
 * directly, so a future storage change here touches one file. Deliberately
 * has no knowledge of accounts, rules, or alerts — plain reads, parameterized
 * by what the caller already knows (a currency list, a time window).
 */
@Injectable()
export class MarketEventQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async findUpcomingHighImpactEvents(
    currencies: string[],
    now: Date,
    withinMinutes: number,
  ): Promise<UpcomingMarketEvent[]> {
    if (currencies.length === 0) return [];
    const until = new Date(now.getTime() + withinMinutes * 60_000);

    const rows = await this.prisma.marketEvent.findMany({
      where: {
        category: MarketEventCategory.ECONOMIC_EVENT,
        impact: MarketEventImpact.HIGH,
        scheduledAt: { gte: now, lte: until },
        affectedCurrencies: { hasSome: currencies },
      },
      select: { id: true, title: true, scheduledAt: true, affectedCurrencies: true, impact: true },
      orderBy: { scheduledAt: 'asc' },
    });
    return rows;
  }

  async findRecentNews(currencies: string[], since: Date): Promise<RecentMarketNews[]> {
    if (currencies.length === 0) return [];

    const rows = await this.prisma.marketEvent.findMany({
      where: {
        category: MarketEventCategory.NEWS,
        scheduledAt: { gte: since },
        affectedCurrencies: { hasSome: currencies },
      },
      select: { id: true, title: true, scheduledAt: true, affectedCurrencies: true, sentiment: true, sourceUrl: true },
      orderBy: { scheduledAt: 'desc' },
    });
    return rows;
  }
}
