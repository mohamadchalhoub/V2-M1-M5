/**
 * `xauusd-m1-rsi-retest-extremes-v1` — the application's single enabled entry
 * strategy.
 *
 * Imports `GoldExecutionModule` to REUSE its infrastructure rather than
 * duplicate it: the gold Telegram channel (its own bot and chat, with durable
 * deduplication), the close-request and protection-restore request paths, and
 * their existing collector endpoints. That module's own ENTRY generation is
 * disabled separately — see `app.module.ts` and the migration notes. What is
 * reused is plumbing; what is new is the strategy.
 *
 * Like every other coordinator in this codebase, nothing here runs on a timer
 * inside the Nest application. The watch loop is a separate, manually started
 * process (`scripts/xauusd-rsi-scheduler.ts`), which is what keeps "manual
 * start only" true: importing this module does not start trading.
 */
import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AuthModule } from '../auth/auth.module';
import { GoldExecutionModule } from '../gold-execution/gold-execution.module';
import { RsiAccountStateService } from './account-state.service';
import { RsiCoordinatorService } from './coordinator.service';
import { RsiDecisionService } from './decision.service';
import { RsiLiquidationService } from './liquidation.service';
import { RsiRuntimeSettingsService } from './runtime-settings.service';
import { RsiWatchService } from './watch.service';
import { RsiExecutionController } from './execution.controller';
import { RsiDashboardController } from './dashboard.controller';
import { RsiControlsController } from './controls.controller';

@Module({
  imports: [AccountsModule, AuthModule, GoldExecutionModule],
  controllers: [RsiExecutionController, RsiDashboardController, RsiControlsController],
  providers: [
    RsiAccountStateService,
    RsiRuntimeSettingsService,
    RsiCoordinatorService,
    RsiDecisionService,
    RsiLiquidationService,
    RsiWatchService,
  ],
  exports: [RsiAccountStateService, RsiRuntimeSettingsService, RsiCoordinatorService, RsiDecisionService, RsiLiquidationService, RsiWatchService],
})
export class XauusdRsiModule {}
