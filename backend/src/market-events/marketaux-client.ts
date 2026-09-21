import { Injectable, Logger } from '@nestjs/common';
import { redactToken } from '../common/redact';

const MARKETAUX_NEWS_URL = 'https://api.marketaux.com/v1/news/all';
const REQUEST_TIMEOUT_MS = 10_000;

export interface MarketauxEntity {
  symbol?: string;
  name?: string;
  type?: string;
  country?: string;
  sentiment_score?: number;
}

export interface MarketauxArticle {
  uuid: string;
  title: string;
  description?: string;
  snippet?: string;
  url: string;
  source?: string;
  language?: string;
  published_at: string; // ISO 8601
  entities?: MarketauxEntity[];
}

/** Thrown for a 429 specifically, so the caller can log/back off distinctly from a generic failure without retrying aggressively. */
export class MarketauxRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketauxRateLimitError';
  }
}

/**
 * Thin wrapper around Marketaux's `/v1/news/all` REST endpoint — same shape
 * as fred-client.ts (a plain, reusable API wrapper with no knowledge of
 * this app's own filtering/curation rules, which live in the ingestion
 * service instead). Deliberately makes exactly ONE request per call and
 * does no internal retrying: the free tier's 100 requests/day budget is too
 * tight to spend on a client-level retry loop layered underneath the
 * queue's own retry budget (jobs.module.ts's MARKET_NEWS_QUEUE) — a single
 * failure here is one job attempt, not a burst of calls.
 *
 * Marketaux's REST contract is not currently exercised against a live
 * token in this environment (no network egress to marketaux.com from this
 * sandbox) — the request shape below follows Marketaux's own published API
 * reference for `/v1/news/all` (api_token, search, entity_types, language,
 * limit, page); `search` is used for currency filtering because it's the
 * one documented parameter guaranteed to match free-text currency codes
 * regardless of how Marketaux's own entity/symbol taxonomy classifies FX —
 * this should be spot-checked against a real token before relying on it in
 * production, same posture as this repo's XTB importer (PROJECT_STATUS.md:
 * "best guess... NOT YET VERIFIED against a real export").
 */
@Injectable()
export class MarketauxClient {
  private readonly logger = new Logger(MarketauxClient.name);

  async getNews(
    apiToken: string,
    currencies: string[],
    limit: number,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<MarketauxArticle[]> {
    const url = new URL(MARKETAUX_NEWS_URL);
    url.searchParams.set('api_token', apiToken);
    url.searchParams.set('language', 'en');
    url.searchParams.set('limit', String(limit));
    if (currencies.length > 0) {
      url.searchParams.set('search', currencies.join(' OR '));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url.toString(), { signal: controller.signal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Marketaux request failed: ${redactToken(message, apiToken)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      const body = await response.text().catch(() => '');
      throw new MarketauxRateLimitError(`Marketaux rate limit hit (429): ${redactToken(body, apiToken).slice(0, 300)}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Marketaux returned ${response.status}: ${redactToken(body, apiToken).slice(0, 300)}`);
    }

    const payload = (await response.json()) as { data?: MarketauxArticle[] };
    const articles = payload.data ?? [];
    this.logger.log(`Marketaux request succeeded: ${articles.length} article(s) received`);
    return articles;
  }
}
