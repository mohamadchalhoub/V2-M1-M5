import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountsModule } from '../accounts/accounts.module';
import { AuthModule } from '../auth/auth.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { TechnicalAnalysisController } from './technical-analysis.controller';
import { TechnicalAnalysisReportService } from './technical-analysis-report.service';
import { loadTechnicalAnalysisConfig, TECHNICAL_ANALYSIS_CONFIG } from './technical-analysis.config';

/**
 * User's custom EURUSD trading rules — the "Technical Analysis / Indicator
 * Services" layer (the user's own architecture diagram). Owns
 * TechnicalAnalysisReportService (fetches real candles via MarketDataModule,
 * calls the pure calculation functions in this same directory) so that
 * candle-fetching and indicator math live in exactly one place — both
 * `alerts` (the rule engine) and `historical-charts`-style dashboard
 * endpoints call this service and only ever receive already-computed
 * results, never fetch candles or run a calculation themselves.
 */
@Module({
  imports: [MarketDataModule, AccountsModule, AuthModule],
  controllers: [TechnicalAnalysisController],
  providers: [
    {
      provide: TECHNICAL_ANALYSIS_CONFIG,
      useFactory: (config: ConfigService) => loadTechnicalAnalysisConfig(config),
      inject: [ConfigService],
    },
    TechnicalAnalysisReportService,
  ],
  exports: [TECHNICAL_ANALYSIS_CONFIG, TechnicalAnalysisReportService],
})
export class TechnicalAnalysisModule {}
