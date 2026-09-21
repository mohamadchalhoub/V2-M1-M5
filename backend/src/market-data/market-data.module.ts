import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HistoricalCandleService } from './historical-candle.service';
import { HistoricalTickService } from './historical-tick.service';
import { BackfillIntervalService } from './backfill-interval.service';
import { MarketDataController } from './market-data.controller';

/**
 * Historical chart reconstruction phase — owns `historical_candles`
 * storage/queries. The collector-push HTTP surface still lives on
 * `collector-ingress`'s existing `/collector/*` routes (same as
 * snapshots/trades; this module is imported there for its services).
 * Independent of `market-events` (economic events/news) — candles are raw
 * OHLC price history, a different domain, never conflated even though both
 * are "market data" in the loose sense.
 *
 * Gold historical-collection phase — added `HistoricalTickService` and
 * `BackfillIntervalService` (same "no accountId" market-data posture), and
 * this module's OWN controller, `MarketDataController`
 * (`DashboardTokenGuard`-protected dashboard read routes) — genuinely
 * separate from the collector's write-only `/collector/*` surface. Imports
 * `AuthModule` for that guard, same as `AccountsModule` does for its own
 * `DashboardTokenGuard`-protected controller.
 */
@Module({
  imports: [AuthModule],
  controllers: [MarketDataController],
  providers: [HistoricalCandleService, HistoricalTickService, BackfillIntervalService],
  exports: [HistoricalCandleService, HistoricalTickService, BackfillIntervalService],
})
export class MarketDataModule {}
