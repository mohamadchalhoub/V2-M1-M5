import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AuthModule } from '../auth/auth.module';
import { AiModule } from '../ai/ai.module';
import { JobsModule } from '../jobs/jobs.module';
import { AutonomousDecisionLoggerService } from '../autonomous/autonomous-decision-logger.service';
import { GoldExecutionController } from './gold-execution.controller';
import { GoldExecutionCoordinatorService } from './gold-execution-coordinator.service';
import { GoldAccountStateService } from './gold-account-state.service';
import { GoldDashboardController } from './gold-dashboard.controller';
import { GoldPreSendGuardService } from './gold-pre-send-guard.service';
import { GoldTelegramService } from './gold-telegram.service';
import { GoldRuntimeSettingsService } from './gold-runtime-settings.service';
import { GoldControlsController } from './gold-controls.controller';
import { GoldAiSummaryService } from './gold-ai-summary.service';
import { GoldNewsService } from './gold-news.service';
import { GoldCloseExecutionService } from './gold-close-execution.service';
import { GoldProtectionRestoreService } from './gold-protection-restore.service';

/**
 * Gold (XAUUSD) execution — fully separate module from AutonomousModule
 * (EURUSD). Reuses AutonomousDecisionLoggerService's underlying table (the
 * schema is already symbol-generic) and AccountsModule/AuthModule for the
 * same collector-auth convention, but registers its OWN controller
 * (`GoldExecutionController`, a distinct route) and its own coordinator —
 * no EURUSD-specific config, magic number, or volume is imported here.
 *
 * No scheduler here either, on purpose (same deliberate posture as
 * AutonomousModule's own header comment) — `GoldExecutionCoordinatorService
 * .evaluate()` has no automatic caller yet; wiring that in is a separate,
 * explicit next step once a real confirmed-retest-v2 watch signal source
 * is connected to it.
 */
@Module({
  imports: [AccountsModule, AuthModule, AiModule, JobsModule],
  controllers: [GoldExecutionController, GoldDashboardController, GoldControlsController],
  providers: [AutonomousDecisionLoggerService, GoldExecutionCoordinatorService, GoldAccountStateService, GoldPreSendGuardService, GoldTelegramService, GoldRuntimeSettingsService, GoldAiSummaryService, GoldNewsService, GoldCloseExecutionService, GoldProtectionRestoreService],
  exports: [GoldExecutionCoordinatorService, GoldAccountStateService, GoldTelegramService, GoldRuntimeSettingsService, GoldAiSummaryService],
})
export class GoldExecutionModule {}
