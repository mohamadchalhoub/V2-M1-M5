import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AccountsModule } from './accounts/accounts.module';
import { TradingDataModule } from './trading-data/trading-data.module';
import { CollectorIngressModule } from './collector-ingress/collector-ingress.module';
import { MarketDataModule } from './market-data/market-data.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { RulesModule } from './rules/rules.module';
import { AlertsModule } from './alerts/alerts.module';
import { JobsModule } from './jobs/jobs.module';
import { TelegramModule } from './telegram/telegram.module';
import { AiModule } from './ai/ai.module';
import { HealthModule } from './health/health.module';
import { MarketEventsModule } from './market-events/market-events.module';
import { HistoricalChartsModule } from './historical-charts/historical-charts.module';
import { XtbImportModule } from './xtb-import/xtb-import.module';
import { GoldExecutionModule } from './gold-execution/gold-execution.module';
import { XauusdRsiModule } from './xauusd-rsi/xauusd-rsi.module';
import { XauusdM1M5Module } from './xauusd-m1m5/xauusd-m1m5.module';
import { AppController } from './app.controller';

/**
 * Strategy wiring, as of the migration to `xauusd-m1-rsi-retest-extremes-v1`.
 *
 * REMOVED from active wiring (their code and historical rows are untouched
 * and remain readable; only their ability to generate or submit entries is
 * gone, because their modules — and therefore their controllers and
 * coordinators — are no longer registered):
 *
 *   - `AutonomousModule`            legacy EURUSD autonomous strategy,
 *                                   including its AI approval/veto layer.
 *   - `TrendBreakoutModule`         H4/H1 trend-breakout (EURUSD + XAUUSD).
 *   - `ConfirmedRetestDashboardModule`  the archived H4 gold research UI.
 *
 * The only module able to produce a new entry is `XauusdM1M5Module`.
 *
 * `XauusdRsiModule` is still imported, and still serves its dashboard,
 * reconciliation and protective management, but its ENTRY wiring is disabled
 * in code in this copy (see `xauusd-m1m5/legacy-entries-disabled.ts`). The
 * same is true of the gold and trend-breakout modules above. Their history
 * and routes remain readable; none of them can submit an order here.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AccountsModule,
    TradingDataModule,
    CollectorIngressModule,
    MarketDataModule,
    AnalyticsModule,
    RulesModule,
    AlertsModule,
    JobsModule,
    AiModule,
    TelegramModule,
    HealthModule,
    XtbImportModule,
    MarketEventsModule,
    HistoricalChartsModule,
    // Gold EXECUTION INFRASTRUCTURE only — its own entry generation is
    // disabled (see gold-execution.controller.ts's pending-order route). This
    // module is retained because the active strategy reuses its Telegram
    // channel, close-request path and protection-restore path, and because
    // positions opened by the retired H4 strategy must keep their original
    // protective management until they resolve.
    GoldExecutionModule,
    // Retained for its dashboard, reconciliation and protective management.
    // Its entry wiring is disabled in code in this copy.
    XauusdRsiModule,
    // The single enabled entry strategy: two independent execution paths,
    // M1 and M5. Importing it does not start trading — the observation loop
    // is a separate, manually started process.
    XauusdM1M5Module,
  ],
  controllers: [AppController],
})
export class AppModule {}
