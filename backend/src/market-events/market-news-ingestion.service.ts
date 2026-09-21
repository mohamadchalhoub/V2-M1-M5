import { Injectable, Logger } from '@nestjs/common';
import { MarketEventSentiment } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MarketauxArticle, MarketauxClient, MarketauxRateLimitError } from './marketaux-client';
import { MarketauxConfig } from './marketaux.config';

// Marketaux's free plan gives no article-level "impact" classification the
// way a scheduled economic release has (curated-fred-releases.ts's
// hand-curated HIGH/MEDIUM/LOW). Rather than invent a fake importance
// score, every ingested news article is stored as MEDIUM — a deliberate,
// honest simplification (not a guess dressed as real classification): it
// sits below every curated FRED release's HIGH, and above nothing, until a
// real signal for news importance exists to replace it.
const NEWS_IMPACT = 'MEDIUM' as const;

/**
 * Upserts one MarketEvent row (`category: NEWS`) per Marketaux article —
 * idempotent by the same `@@unique([source, externalId, scheduledAt])`
 * constraint the FRED ingestion service already relies on
 * (market-event-ingestion.service.ts): an article's own `uuid` is stable
 * across re-fetches, so re-running this on a schedule never duplicates an
 * article it already knows about.
 */
@Injectable()
export class MarketNewsIngestionService {
  private readonly logger = new Logger(MarketNewsIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketauxClient: MarketauxClient,
  ) {}

  async ingest(config: MarketauxConfig): Promise<{ upserted: number; skipped: number }> {
    this.logger.log(`Marketaux request started: currencies=${config.currencies.join(',')}`);

    let articles: MarketauxArticle[];
    try {
      articles = await this.marketauxClient.getNews(config.apiToken, config.currencies, config.limit);
    } catch (err) {
      if (err instanceof MarketauxRateLimitError) {
        this.logger.warn(`Marketaux rate limit encountered — skipping this tick: ${err.message}`);
        return { upserted: 0, skipped: 0 };
      }
      // Any other provider failure (network, timeout, 5xx, malformed body)
      // must not crash the worker or affect anything else — logged and
      // surfaced to the caller so the queue's own small retry budget
      // (jobs.module.ts's MARKET_NEWS_QUEUE) can decide whether to retry.
      this.logger.error(`Marketaux request failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    let upserted = 0;
    let skipped = 0;
    let duplicates = 0;

    for (const article of articles) {
      if (!article.uuid || !article.title || !article.published_at || !article.url) {
        // Missing a field this table treats as required — skip rather than
        // insert a half-populated row or crash the whole tick over one bad
        // article.
        skipped++;
        continue;
      }

      const scheduledAt = new Date(article.published_at);
      if (Number.isNaN(scheduledAt.getTime())) {
        skipped++;
        continue;
      }

      const affectedCurrencies = matchCurrencies(article, config.currencies);
      const sentiment = deriveSentiment(article);
      const where = {
        source_externalId_scheduledAt: {
          source: 'MARKETAUX' as const,
          externalId: article.uuid,
          scheduledAt,
        },
      };

      const existing = await this.prisma.marketEvent.findUnique({ where, select: { id: true } });
      if (existing) duplicates++;

      await this.prisma.marketEvent.upsert({
        where,
        create: {
          source: 'MARKETAUX',
          externalId: article.uuid,
          category: 'NEWS',
          title: article.title,
          scheduleType: 'SURPRISE',
          impact: NEWS_IMPACT,
          sentiment,
          affectedCurrencies,
          scheduledAt,
          sourceUrl: article.url,
          rawPayload: article as unknown as object,
        },
        // A re-fetch of the same article can carry an updated sentiment
        // score or a corrected snippet — heal the row rather than leaving
        // it frozen at whatever the first fetch happened to see.
        update: {
          title: article.title,
          sentiment,
          affectedCurrencies,
          sourceUrl: article.url,
          rawPayload: article as unknown as object,
        },
      });
      upserted++;
    }

    this.logger.log(
      `Marketaux ingestion: ${upserted} upserted (${duplicates} already known, healed not duplicated), ${skipped} skipped (missing fields)`,
    );
    return { upserted, skipped };
  }
}

/**
 * Marketaux's own entity/symbol taxonomy for currency tagging isn't
 * verified against a live token in this environment (see marketaux-client.ts's
 * header comment) — this does a conservative textual match of each
 * configured currency code as a whole word against the title/description/
 * snippet instead, which works regardless of how entities are shaped. An
 * article that matched the `search` query (currencies OR'd together, see
 * marketaux-client.ts) but doesn't literally contain any configured code as
 * a whole word falls back to the full configured list — the query itself
 * was already currency-scoped, so "no exact word match" means "imprecise
 * text match," not "irrelevant to none of them."
 */
function matchCurrencies(article: MarketauxArticle, configuredCurrencies: string[]): string[] {
  const haystack = `${article.title} ${article.description ?? ''} ${article.snippet ?? ''}`.toUpperCase();
  const matched = configuredCurrencies.filter((currency) => new RegExp(`\\b${currency}\\b`).test(haystack));
  return matched.length > 0 ? matched : configuredCurrencies;
}

/**
 * Marketaux gives per-entity `sentiment_score` (roughly -1..1), not one
 * article-level sentiment — averaged across every entity that has a score
 * at all. UNCERTAIN (the schema's own default posture, schema.prisma's
 * MarketEvent comment) when no entity carries a score, rather than a fake
 * NEUTRAL.
 */
function deriveSentiment(article: MarketauxArticle): MarketEventSentiment {
  const scores = (article.entities ?? [])
    .map((e) => e.sentiment_score)
    .filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
  if (scores.length === 0) return 'UNCERTAIN';

  const average = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  if (average > 0.1) return 'POSITIVE';
  if (average < -0.1) return 'NEGATIVE';
  return 'NEUTRAL';
}
