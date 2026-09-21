import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  CENTRAL_BANK_CALENDAR_QUEUE,
  FINNHUB_NEWS_QUEUE,
  MARKET_EVENT_QUEUE,
  MARKET_NEWS_QUEUE,
} from '../jobs/jobs.constants';

const BEIRUT_TZ = 'Asia/Beirut';
/** XAU/USD-relevant currencies: gold is USD-denominated, and gold-moving macro is overwhelmingly USD (Fed policy, inflation, employment) — same MONITORED_CURRENCIES-style scoping as market-context-builder.service.ts, but gold's own fixed set rather than reusing that EURUSD-shaped constant. */
const GOLD_RELEVANT_CURRENCIES = ['USD', 'XAU'];

export interface GoldNewsItem {
  id: string;
  title: string;
  category: 'ECONOMIC_EVENT' | 'NEWS';
  scheduledAtIso: string;
  scheduledAtBeirut: string;
  affectedCurrencies: string[];
  sentiment: string | null;
  sourceUrl: string | null;
}

export type IngestionHealthStatus = 'OK' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';

export interface GoldProviderCoverage {
  source: string;
  totalRows: number;
  /**
   * SOURCE-DATA age — how recent the most recent row's own data is
   * (MAX(scheduledAt), i.e. does this provider have anything current to
   * say), kept deliberately separate from ingestionHealth below. A
   * provider can have perfectly fresh source data yet a broken job (stale
   * repeat data replayed), or a healthy job that legitimately has nothing
   * new to report (a quiet economic calendar) — conflating the two (as an
   * earlier version of this service did, using MAX(updatedAt) for both)
   * hides that distinction.
   */
  mostRecentSourceDataAtIso: string | null;
  sourceDataStaleAfterMs: number;
  sourceDataStale: boolean;
  /**
   * INGESTION HEALTH — whether the BullMQ job that's supposed to be
   * fetching this provider has actually been OBSERVED to run, from that
   * queue's own completed/failed job history (real execution evidence,
   * not inferred from row timestamps). UNKNOWN when no job history is
   * available (e.g. this provider has no queue mapping, or the queue has
   * never run/its history has rolled off) — never guessed or defaulted to
   * OK/DOWN without actual evidence.
   */
  ingestionHealth: IngestionHealthStatus;
  lastIngestionRunAtIso: string | null;
  lastIngestionRunOutcome: 'completed' | 'failed' | null;
}

/**
 * Task item G (extended by task item 6) — a read-only, gold-scoped view
 * over the existing (shared, not gold-specific) `market-events` providers
 * (Finnhub/FRED/Marketaux/central-bank-calendar), all writing into the one
 * `market_events` table via `MarketEventQueryService`'s underlying
 * `MarketEvent` model. This service does NOT modify any provider/job/config
 * — read-only consumption layer, exactly as scoped.
 *
 * Task item 6 fix: the original version of this service reported
 * MAX(MarketEvent.updatedAt) as both "coverage" and implied ingestion
 * health, which is wrong — a row landing recently proves data arrived, not
 * that the scheduled job is currently running successfully (a job that
 * silently stopped firing would show the SAME stale-but-once-fresh data
 * forever). This version reads REAL job-execution evidence from each
 * provider's own BullMQ queue history (`getJobs(['completed','failed'])`,
 * sorted by `finishedOn`) for `ingestionHealth`, and reports 'UNKNOWN'
 * (never a guessed OK/DOWN) when that queue has no completed/failed job in
 * its retained history — e.g. `DATA_INTEGRITY_QUEUE`-style queues that
 * prune history aggressively, or a provider this map doesn't recognize.
 */
@Injectable()
export class GoldNewsService {
  private readonly logger = new Logger(GoldNewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MARKET_EVENT_QUEUE) private readonly fredQueue: Queue,
    @Inject(MARKET_NEWS_QUEUE) private readonly marketauxQueue: Queue,
    @Inject(FINNHUB_NEWS_QUEUE) private readonly finnhubQueue: Queue,
    @Inject(CENTRAL_BANK_CALENDAR_QUEUE) private readonly centralBankQueue: Queue,
  ) {}

  private queueFor(source: string): Queue | null {
    switch (source) {
      case 'FRED':
        return this.fredQueue;
      case 'MARKETAUX':
        return this.marketauxQueue;
      case 'FINNHUB':
        return this.finnhubQueue;
      case 'FOMC':
      case 'ECB':
        return this.centralBankQueue;
      default:
        return null;
    }
  }

  async getRelevantNews(limit = 20): Promise<GoldNewsItem[]> {
    const rows = await this.prisma.marketEvent.findMany({
      where: { affectedCurrencies: { hasSome: GOLD_RELEVANT_CURRENCIES } },
      orderBy: { scheduledAt: 'desc' },
      take: limit,
      select: { id: true, title: true, category: true, scheduledAt: true, affectedCurrencies: true, sentiment: true, sourceUrl: true },
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      category: r.category,
      scheduledAtIso: r.scheduledAt.toISOString(),
      scheduledAtBeirut: formatBeirut(r.scheduledAt),
      affectedCurrencies: r.affectedCurrencies,
      sentiment: r.sentiment ?? null,
      sourceUrl: r.sourceUrl ?? null,
    }));
  }

  async getProviderCoverage(): Promise<GoldProviderCoverage[]> {
    const grouped = await this.prisma.marketEvent.groupBy({
      by: ['source'],
      _count: { _all: true },
      // Both maxima are fetched: `scheduledAt` and `updatedAt` mean very
      // different things depending on category (see `sourceTimestampFor`
      // below), so neither alone is safe to treat as "how recent is our
      // data" for every source.
      _max: { scheduledAt: true, updatedAt: true },
    });
    const sourceDataStaleAfterMs = 24 * 60 * 60_000; // 24h — same order of magnitude as SymbolMetadata's own staleness posture elsewhere in this codebase
    const now = Date.now();

    return Promise.all(
      grouped.map(async (g) => {
        const mostRecentSourceDataAt = this.sourceTimestampFor(g.source, g._max.scheduledAt, g._max.updatedAt);
        const ingestion = await this.readIngestionHealth(g.source);
        return {
          source: g.source,
          totalRows: g._count._all,
          mostRecentSourceDataAtIso: mostRecentSourceDataAt ? mostRecentSourceDataAt.toISOString() : null,
          sourceDataStaleAfterMs,
          sourceDataStale: !mostRecentSourceDataAt || now - mostRecentSourceDataAt.getTime() > sourceDataStaleAfterMs,
          ...ingestion,
        };
      }),
    );
  }

  /**
   * Bug fix (found while auditing the gold dashboard's provenance labels):
   * this used to report `MAX(scheduledAt)` as "source data freshness" for
   * EVERY source. That's correct for NEWS rows, where `scheduledAt` really
   * is `published_at` (see schema.prisma) — a real past timestamp. But for
   * ECONOMIC_EVENT rows (FRED/FOMC/ECB), `scheduledAt` is the *forward-
   * looking* release/meeting date pulled from each provider's own upcoming-
   * calendar API (`market-event-ingestion.service.ts`'s
   * `etDateAndTimeToUtc(release.date, ...)`, `config.lookaheadDays` ahead)
   * — i.e. a FUTURE scheduled release time, not evidence of when we last
   * actually fetched/published anything. Using it for staleness silently
   * conflated "there's an upcoming release far in the future" with "our
   * data is fresh", which could report DEGRADED-worthy staleness as fresh
   * (or vice versa) depending on how far out the next release sits.
   * For economic-calendar sources this now uses `MAX(updatedAt)` instead —
   * the actual last-ingested/last-touched time for that source's rows —
   * which is the correct proxy for "how recently did we pull data".
   */
  private sourceTimestampFor(source: string, maxScheduledAt: Date | null, maxUpdatedAt: Date | null): Date | null {
    const isForwardLookingCalendar = source === 'FRED' || source === 'FOMC' || source === 'ECB';
    return isForwardLookingCalendar ? maxUpdatedAt : maxScheduledAt;
  }

  private async readIngestionHealth(source: string): Promise<Pick<GoldProviderCoverage, 'ingestionHealth' | 'lastIngestionRunAtIso' | 'lastIngestionRunOutcome'>> {
    const queue = this.queueFor(source);
    if (!queue) {
      return { ingestionHealth: 'UNKNOWN', lastIngestionRunAtIso: null, lastIngestionRunOutcome: null };
    }

    try {
      // Most recent finished job of EITHER outcome, across both kinds
      // (completed/failed) — BullMQ doesn't expose a single "most recent
      // regardless of state" call, so both lists are fetched and merged.
      const [completed, failed] = await Promise.all([
        queue.getJobs(['completed'], 0, 5),
        queue.getJobs(['failed'], 0, 5),
      ]);
      const all = [...completed.map((j) => ({ job: j, outcome: 'completed' as const })), ...failed.map((j) => ({ job: j, outcome: 'failed' as const }))]
        .filter((x) => typeof x.job.finishedOn === 'number')
        .sort((a, b) => (b.job.finishedOn ?? 0) - (a.job.finishedOn ?? 0));

      if (all.length === 0) {
        // No completed/failed job in this queue's retained history — genuinely no execution evidence available.
        return { ingestionHealth: 'UNKNOWN', lastIngestionRunAtIso: null, lastIngestionRunOutcome: null };
      }

      const mostRecent = all[0];
      const finishedAt = new Date(mostRecent.job.finishedOn as number);
      const ageMs = Date.now() - finishedAt.getTime();
      const EXPECTED_RUN_INTERVAL_MS = 2 * 60 * 60_000; // generous upper bound across all four providers' actual schedules

      let ingestionHealth: IngestionHealthStatus;
      if (mostRecent.outcome === 'failed') {
        ingestionHealth = 'DOWN';
      } else if (ageMs > EXPECTED_RUN_INTERVAL_MS) {
        ingestionHealth = 'DEGRADED'; // last known run succeeded, but it's been a while since ANY run was observed
      } else {
        ingestionHealth = 'OK';
      }

      return { ingestionHealth, lastIngestionRunAtIso: finishedAt.toISOString(), lastIngestionRunOutcome: mostRecent.outcome };
    } catch (err) {
      this.logger.warn(`could not read ingestion job history for source=${source}: ${err instanceof Error ? err.message : err}`);
      return { ingestionHealth: 'UNKNOWN', lastIngestionRunAtIso: null, lastIngestionRunOutcome: null };
    }
  }
}

function formatBeirut(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: BEIRUT_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}
