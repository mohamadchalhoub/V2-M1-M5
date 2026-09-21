import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuthModule } from '../auth/auth.module';
import { JobsModule } from '../jobs/jobs.module';
import { MarketEventsModule } from '../market-events/market-events.module';
import { RulesModule } from '../rules/rules.module';
import { TechnicalAnalysisModule } from '../technical-analysis/technical-analysis.module';
import { AlertLifecycleService } from './alert-lifecycle.service';
import { AlertsController } from './alerts.controller';
import { DailyMarketAnalysisProcessor } from './daily-market-analysis.processor';
import { RuleEngineService } from './rule-engine.service';

// Phase 0 §15: alerts depends on rules (never the reverse). RuleEngineService
// additionally depends on AnalyticsModule directly, since it is the
// orchestrator that calls AnalyticsService — the data-flow order (Analytics
// → Rules → Alerts) is unchanged either way. JobsModule (Phase 5) is
// @Global() so this import is technically redundant once AppModule imports
// it, but kept explicit — AlertLifecycleService injects the delivery queue
// directly, so the dependency should be visible here. MarketEventsModule
// (market-events phase 5) is imported one-way, same posture — RuleEngineService
// reads MarketEventQueryService to evaluate HIGH_IMPACT_EVENT_EXPOSURE;
// market-events itself has no knowledge of alerts/rules. TechnicalAnalysisModule
// (user's custom EURUSD rules) is imported the same one-way — RuleEngineService
// and DailyMarketAnalysisProcessor both call TechnicalAnalysisReportService;
// technical-analysis itself has no knowledge of alerts/rules either.
@Module({
  imports: [RulesModule, AnalyticsModule, JobsModule, AccountsModule, AuthModule, MarketEventsModule, TechnicalAnalysisModule],
  controllers: [AlertsController],
  providers: [AlertLifecycleService, RuleEngineService, DailyMarketAnalysisProcessor],
  exports: [RuleEngineService, AlertLifecycleService],
})
export class AlertsModule {}
