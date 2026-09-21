import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AlertsModule } from '../alerts/alerts.module';
import { AuthModule } from '../auth/auth.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { TradingDataModule } from '../trading-data/trading-data.module';
import { CollectorIngressController } from './collector-ingress.controller';
import { GoldClosureReconciliationService } from '../gold-execution/gold-closure-reconciliation.service';
import { GoldProtectionMonitorService } from '../gold-execution/gold-protection-monitor.service';
import { GoldTelegramService } from '../gold-execution/gold-telegram.service';
import { GoldAiSummaryService } from '../gold-execution/gold-ai-summary.service';
import { GoldCloseExecutionService } from '../gold-execution/gold-close-execution.service';
import { GoldProtectionRestoreService } from '../gold-execution/gold-protection-restore.service';
import { AiModule } from '../ai/ai.module';
// Shared market-data infrastructure that happens to live in the retired
// trend-breakout strategy's folder. It ingests `/collector/symbol-metadata`,
// which the ACTIVE strategy depends on for real broker volume/stops/tick
// constraints, so it outlives the strategy it was written alongside and is
// provided here directly rather than by importing that retired module.
import { SymbolMetadataService } from '../trend-breakout/symbol-metadata.service';

// AlertsModule (→ RuleEngineService) is imported here per RULE_ENGINE_SPEC.md
// §12.12 decision 4a: the existing ingestion path is the evaluation trigger,
// not a separate cron (Phase 0 §01's own invariant — "the collector is a
// client of the API, never a peer it polls" — extends naturally to "one
// thing pushes, the pipeline reacts synchronously," with no new scheduler).
// MarketDataModule (historical chart reconstruction phase) — the collector
// pushes candles through this same controller, same one-way architecture.
@Module({
  // TrendBreakoutModule removed with the strategy migration. The only thing
  // this controller actually used from it was SymbolMetadataService, which is
  // shared infrastructure and is now provided directly below — so the retired
  // strategy's coordinators, controllers and slot locks are no longer
  // constructed anywhere.
  imports: [AccountsModule, TradingDataModule, AuthModule, AlertsModule, MarketDataModule, AiModule],
  controllers: [CollectorIngressController],
  providers: [SymbolMetadataService, GoldClosureReconciliationService, GoldProtectionMonitorService, GoldTelegramService, GoldAiSummaryService, GoldCloseExecutionService, GoldProtectionRestoreService],
})
export class CollectorIngressModule {}
