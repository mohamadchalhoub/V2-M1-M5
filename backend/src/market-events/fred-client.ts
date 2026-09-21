import { Injectable } from '@nestjs/common';
import { redactToken } from '../common/redact';

const FRED_RELEASES_DATES_URL = 'https://api.stlouisfed.org/fred/releases/dates';
const PAGE_SIZE = 1000; // FRED's own documented maximum for `limit`

export interface FredReleaseDate {
  releaseId: number;
  releaseName: string;
  date: string; // YYYY-MM-DD, no time component — FRED never gives one
}

/**
 * Thin wrapper around FRED's public /fred/releases/dates endpoint. Fetches
 * the FULL calendar for the lookahead window in one (paginated) pass rather
 * than one call per curated release_id — the ingestion service filters the
 * result down to the curated allowlist client-side (fred-client.ts has no
 * knowledge of which releases are curated; that's curated-fred-releases.ts's
 * job, kept separate so this client stays a plain, reusable API wrapper).
 */
@Injectable()
export class FredClient {
  async getUpcomingReleaseDates(apiKey: string, fromDate: string, toDate: string): Promise<FredReleaseDate[]> {
    const results: FredReleaseDate[] = [];
    let offset = 0;

    for (;;) {
      const url = new URL(FRED_RELEASES_DATES_URL);
      url.searchParams.set('api_key', apiKey);
      url.searchParams.set('file_type', 'json');
      url.searchParams.set('realtime_start', fromDate);
      url.searchParams.set('realtime_end', toDate);
      // Without this, FRED excludes releases that don't have data attached
      // yet — which is exactly every genuinely FUTURE release; this is what
      // makes the endpoint usable as a forward-looking calendar at all.
      url.searchParams.set('include_release_dates_with_no_data', 'true');
      url.searchParams.set('order_by', 'release_date');
      url.searchParams.set('sort_order', 'asc');
      url.searchParams.set('limit', String(PAGE_SIZE));
      url.searchParams.set('offset', String(offset));

      let response: Response;
      try {
        response = await fetch(url.toString());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`FRED request failed: ${redactToken(message, apiKey)}`);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`FRED returned ${response.status}: ${redactToken(body, apiKey).slice(0, 300)}`);
      }

      const payload = (await response.json()) as {
        count?: number;
        release_dates?: { release_id: number; release_name: string; date: string }[];
      };

      const page = payload.release_dates ?? [];
      results.push(...page.map((r) => ({ releaseId: r.release_id, releaseName: r.release_name, date: r.date })));

      const total = payload.count ?? results.length;
      if (page.length < PAGE_SIZE || results.length >= total) break;
      offset += PAGE_SIZE;
    }

    return results;
  }
}
