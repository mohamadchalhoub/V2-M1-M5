import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FinnhubArticle, FinnhubClient } from './finnhub-client';
import { FinnhubConfig } from './finnhub.config';

// Finnhub's forex-news feed carries no per-article sentiment or currency
// tagging at all (verified against a real response — just category,
// datetime, headline, id, related, source, summary, url). Rather than
// invent a fake classification, every article is stored as MEDIUM impact /
// UNCERTAIN sentiment and tagged with every configured currency — the
// same honest-simplification posture market-news-ingestion.service.ts
// (Marketaux) already established for exactly this situation.
const NEWS_IMPACT = 'MEDIUM' as const;

/**
 * Upserts one MarketEvent row (`category: NEWS`, `source: FINNHUB`) per
 * article — idempotent by the same `@@unique([source, externalId,
 * scheduledAt])` constraint every other ingestion service in this module
 * relies on, using Finnhub's own numeric `id` as `externalId`. No separate
 * `minId`/cache-based dedup needed (unlike the task spec's suggestion) —
 * the upsert already makes re-fetching the same articles a safe no-op,
 * survives restarts, and needs no extra Redis/in-memory state.
 */
@Injectable()
export class FinnhubNewsIngestionService {
  private readonly logger = new Logger(FinnhubNewsIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly finnhubClient: FinnhubClient,
  ) {}

  async ingest(config: FinnhubConfig): Promise<{ upserted: number; skipped: number }> {
    this.logger.log('Finnhub request started: category=forex');

    let articles: FinnhubArticle[];
    try {
      articles = await this.finnhubClient.getForexNews(config.apiKey);
    } catch (err) {
      // Never crash the worker — logged and surfaced to the caller so the
      // queue's own small retry budget (jobs.module.ts's FINNHUB_NEWS_QUEUE)
      // can decide whether to retry.
      this.logger.error(`Finnhub request failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    const mostRecentFirst = [...articles].sort((a, b) => b.datetime - a.datetime).slice(0, config.limit);

    let upserted = 0;
    let skipped = 0;
    let duplicates = 0;

    for (const article of mostRecentFirst) {
      if (!article.id || !article.headline || !article.datetime || !article.url) {
        skipped++;
        continue;
      }

      const scheduledAt = new Date(article.datetime * 1000);
      if (Number.isNaN(scheduledAt.getTime())) {
        skipped++;
        continue;
      }

      const where = {
        source_externalId_scheduledAt: {
          source: 'FINNHUB' as const,
          externalId: String(article.id),
          scheduledAt,
        },
      };

      const existing = await this.prisma.marketEvent.findUnique({ where, select: { id: true } });
      if (existing) duplicates++;

      await this.prisma.marketEvent.upsert({
        where,
        create: {
          source: 'FINNHUB',
          externalId: String(article.id),
          category: 'NEWS',
          title: article.headline,
          scheduleType: 'SURPRISE',
          impact: NEWS_IMPACT,
          sentiment: 'UNCERTAIN',
          affectedCurrencies: config.currencies,
          scheduledAt,
          sourceUrl: article.url,
          rawPayload: article as unknown as object,
        },
        update: {
          title: article.headline,
          sourceUrl: article.url,
          rawPayload: article as unknown as object,
        },
      });
      upserted++;
    }

    this.logger.log(
      `Finnhub ingestion: ${upserted} upserted (${duplicates} already known, healed not duplicated), ${skipped} skipped (missing fields)`,
    );
    return { upserted, skipped };
  }
}
