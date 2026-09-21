import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AuthModule } from '../auth/auth.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { HistoricalChartsController } from './historical-charts.controller';
import { TradeAlignmentService } from './trade-alignment.service';

/**
 * Historical chart reconstruction phase — reads already-imported Trade rows
 * (any platform) and `market-data`'s candle store to reconstruct a trade's
 * chart context. No collector/ingestion path of its own; read-only,
 * dashboard-facing.
 */
@Module({
  imports: [AccountsModule, AuthModule, MarketDataModule],
  controllers: [HistoricalChartsController],
  providers: [TradeAlignmentService],
  // Exported so `ai`'s HistoricalPatternSummaryService can reuse
  // getRoundTrips() (AI provider phase — feeding a deterministic BUY/SELL
  // pattern summary into AlertContext) instead of re-implementing the
  // IN/OUT round-trip pairing a second time.
  exports: [TradeAlignmentService],
})
export class HistoricalChartsModule {}
