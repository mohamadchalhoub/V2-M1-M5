import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CentralBankCalendarProvider } from './central-bank-calendar.provider';

// A generous, fixed lookahead — unlike FRED (config.lookaheadDays, tied to
// how far ahead its own release-dates endpoint is asked to look), this
// provider has no external call to bound, and the whole curated list is
// tiny (~15 entries/year). One year ahead comfortably covers the full
// currently-curated calendar without needing its own config knob.
const LOOKAHEAD_DAYS = 365;

/**
 * Objective 4 — same upsert shape as MarketEventIngestionService (FRED),
 * writing into the same `market_events` table via the same
 * `@@unique([source, externalId, scheduledAt])` idempotency key, so
 * MarketEventQueryService (already consumed by the rule engine's
 * HIGH_IMPACT_EVENT_EXPOSURE evaluator and the AI's
 * MarketContextBuilderService) picks these up with zero changes on either
 * side.
 */
@Injectable()
export class CentralBankCalendarIngestionService {
  private readonly logger = new Logger(CentralBankCalendarIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: CentralBankCalendarProvider,
  ) {}

  async ingest(): Promise<{ upserted: number }> {
    const from = new Date();
    const to = new Date(from.getTime() + LOOKAHEAD_DAYS * 86_400_000);
    const events = await this.provider.fetchEvents({ from, to });

    let upserted = 0;
    for (const event of events) {
      await this.prisma.marketEvent.upsert({
        where: {
          source_externalId_scheduledAt: {
            source: event.source,
            externalId: event.externalId,
            scheduledAt: event.scheduledAt,
          },
        },
        create: {
          source: event.source,
          externalId: event.externalId,
          category: event.category,
          title: event.title,
          scheduleType: event.scheduleType,
          impact: event.impact,
          sentiment: 'UNCERTAIN',
          affectedCurrencies: event.affectedCurrencies,
          scheduledAt: event.scheduledAt,
          rawPayload: event.rawPayload as object,
        },
        update: {
          // Same "heal on next tick if the curated list changes" reasoning
          // as MarketEventIngestionService's own FRED upsert.
          title: event.title,
          impact: event.impact,
          affectedCurrencies: event.affectedCurrencies,
          rawPayload: event.rawPayload as object,
        },
      });
      upserted++;
    }

    this.logger.log(`central bank calendar ingestion: ${upserted} upserted`);
    return { upserted };
  }
}
