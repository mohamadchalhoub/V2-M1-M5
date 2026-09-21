import { MarketEventCategory, MarketEventImpact, MarketEventScheduleType } from '@prisma/client';

/**
 * Objective 4 (economic calendar) — a minimal provider abstraction, added
 * because the architecture didn't have one: FredClient and MarketauxClient
 * predate this and stay exactly as they are (different method signatures,
 * their own ingestion services) rather than being forced into this shape
 * retroactively — that would be an unrelated refactor of working, tested
 * code. This interface applies going forward: any NEW market-event source
 * added after this one should implement it, so the normalized event model
 * (below) stays decoupled from any one external API's own response shape.
 */
export interface NormalizedMarketEvent {
  source: string;
  /** Provider-native identifier — combined with `source`/`scheduledAt`, this is MarketEvent's own dedup key (schema.prisma's `@@unique([source, externalId, scheduledAt])`). */
  externalId: string;
  category: MarketEventCategory;
  title: string;
  scheduleType: MarketEventScheduleType;
  impact: MarketEventImpact;
  affectedCurrencies: string[];
  scheduledAt: Date;
  rawPayload: object;
}

export interface MarketEventProvider {
  /** Every event this provider has for the given window (inclusive) — the caller decides what to do with them (e.g. upsert into MarketEvent). */
  fetchEvents(range: { from: Date; to: Date }): Promise<NormalizedMarketEvent[]>;
}
