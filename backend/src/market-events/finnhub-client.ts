import { Injectable, Logger } from '@nestjs/common';
import { redactToken } from '../common/redact';

const FINNHUB_NEWS_URL = 'https://finnhub.io/api/v1/news';
const REQUEST_TIMEOUT_MS = 10_000;

export interface FinnhubArticle {
  category: string;
  datetime: number; // Unix seconds
  headline: string;
  id: number;
  related: string;
  source: string;
  summary: string;
  url: string;
}

/**
 * Thin wrapper around Finnhub's `/api/v1/news` REST endpoint — same shape
 * as marketaux-client.ts (a plain, reusable API wrapper with no knowledge
 * of this app's own curation rules, which live in the ingestion service
 * instead). Raw `fetch`, no SDK — every other external API in this app
 * (Anthropic, OpenRouter, Gemini, Telegram, FRED, Marketaux) is a plain
 * REST wrapper for the same reasons (no new dependency, trivial to mock in
 * tests, one obvious place to see exactly what's sent). The official
 * `finnhub` npm package uses an old callback-based client shape that
 * doesn't fit this pattern, so it's not used here.
 *
 * The shape above and the `category=forex` query parameter were verified
 * against a real, live call during implementation (not guessed from
 * documentation) — confirmed to return real Forexlive/etc. articles.
 */
@Injectable()
export class FinnhubClient {
  private readonly logger = new Logger(FinnhubClient.name);

  async getForexNews(apiKey: string, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<FinnhubArticle[]> {
    const url = new URL(FINNHUB_NEWS_URL);
    url.searchParams.set('category', 'forex');
    url.searchParams.set('token', apiKey);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url.toString(), { signal: controller.signal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Finnhub request failed: ${redactToken(message, apiKey)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      const body = await response.text().catch(() => '');
      throw new Error(`Finnhub rate limit hit (429): ${redactToken(body, apiKey).slice(0, 300)}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Finnhub returned ${response.status}: ${redactToken(body, apiKey).slice(0, 300)}`);
    }

    const articles = (await response.json()) as FinnhubArticle[];
    this.logger.log(`Finnhub request succeeded: ${articles.length} article(s) received`);
    return articles;
  }
}
