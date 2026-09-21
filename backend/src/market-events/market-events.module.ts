import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobsModule } from '../jobs/jobs.module';
import { CentralBankCalendarIngestionProcessor } from './central-bank-calendar-ingestion.processor';
import { CentralBankCalendarIngestionService } from './central-bank-calendar-ingestion.service';
import { CentralBankCalendarProvider } from './central-bank-calendar.provider';
import { CENTRAL_BANK_CALENDAR_CONFIG, loadCentralBankCalendarConfig } from './central-bank-calendar.config';
import { FinnhubClient } from './finnhub-client';
import { FINNHUB_CONFIG, loadFinnhubConfig } from './finnhub.config';
import { FinnhubNewsIngestionProcessor } from './finnhub-news-ingestion.processor';
import { FinnhubNewsIngestionService } from './finnhub-news-ingestion.service';
import { FredClient } from './fred-client';
import { MarketEventIngestionProcessor } from './market-event-ingestion.processor';
import { MarketEventIngestionService } from './market-event-ingestion.service';
import { MarketEventQueryService } from './market-event-query.service';
import { loadMarketEventsConfig, MARKET_EVENTS_CONFIG } from './market-events.config';
import { MarketauxClient } from './marketaux-client';
import { loadMarketauxConfig, MARKETAUX_CONFIG } from './marketaux.config';
import { MarketNewsIngestionProcessor } from './market-news-ingestion.processor';
import { MarketNewsIngestionService } from './market-news-ingestion.service';

/**
 * Four independent ingestion providers (FRED for scheduled economic
 * events, Marketaux and Finnhub for news, and the curated central-bank
 * calendar for FOMC/ECB rate decisions — Objective 4's gap fill, a static
 * local source with no external HTTP call — each with its own
 * config/service/processor/queue, never sharing state) writing into the
 * one `market_events` table, plus a single read path
 * (`MarketEventQueryService`) other modules use to consume what's been
 * ingested — this is also how Finnhub articles reach the AI/Telegram
 * pipeline: `category: NEWS` rows are indistinguishable to every existing
 * reader (`findRecentNews`, the daily report, `ai-prompt.ts`) regardless of
 * which provider wrote them, so no changes were needed anywhere else.
 * `rules`/`alerts` now depend on `MarketEventQueryService`
 * (HIGH_IMPACT_EVENT_EXPOSURE, market-events phase 5) — this module still
 * owns no knowledge of rules/alerts itself, the dependency runs one way
 * only. Each provider is off by default (MARKET_EVENTS_ENABLED /
 * MARKETAUX_ENABLED / CENTRAL_BANK_CALENDAR_ENABLED / FINNHUB_ENABLED all
 * default false) — an existing deployment is entirely unaffected until
 * explicitly turned on.
 */
@Module({
  imports: [JobsModule],
  providers: [
    {
      provide: MARKET_EVENTS_CONFIG,
      useFactory: (config: ConfigService) => loadMarketEventsConfig(config),
      inject: [ConfigService],
    },
    {
      provide: MARKETAUX_CONFIG,
      useFactory: (config: ConfigService) => loadMarketauxConfig(config),
      inject: [ConfigService],
    },
    {
      provide: CENTRAL_BANK_CALENDAR_CONFIG,
      useFactory: (config: ConfigService) => loadCentralBankCalendarConfig(config),
      inject: [ConfigService],
    },
    {
      provide: FINNHUB_CONFIG,
      useFactory: (config: ConfigService) => loadFinnhubConfig(config),
      inject: [ConfigService],
    },
    FredClient,
    MarketEventIngestionService,
    MarketEventIngestionProcessor,
    MarketauxClient,
    MarketNewsIngestionService,
    MarketNewsIngestionProcessor,
    CentralBankCalendarProvider,
    CentralBankCalendarIngestionService,
    CentralBankCalendarIngestionProcessor,
    FinnhubClient,
    FinnhubNewsIngestionService,
    FinnhubNewsIngestionProcessor,
    MarketEventQueryService,
  ],
  exports: [MARKET_EVENTS_CONFIG, MARKETAUX_CONFIG, CENTRAL_BANK_CALENDAR_CONFIG, FINNHUB_CONFIG, MarketEventQueryService],
})
export class MarketEventsModule {}
