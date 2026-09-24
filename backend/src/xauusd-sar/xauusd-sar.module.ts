/**
 * ENGINE A REPLACEMENT — xauusd-sar-v1, as a Nest module.
 *
 * Importing this module does not start trading and does not touch Engine B.
 * Nothing here runs on a timer; the loop lives in
 * `scripts/xauusd-sar-scheduler.ts`, exactly as the frozen RSI strategy's
 * loop lives in `scripts/xauusd-m1m5-scheduler.ts` and Engine B's in
 * `scripts/telegram-ingest.ts`.
 *
 * Deliberately does NOT import `XauusdM1M5Module` or `TelegramEngineModule`:
 * this strategy's occupancy, ownership and execution must never be in reach
 * of either other strategy's providers.
 *
 * The ONE exception is `TelegramEngineNotificationService`, imported
 * directly (not via `TelegramEngineModule`) — the same precedent
 * `TelegramEngineModule` itself already sets for `M1M5Mt5SnapshotService`:
 * genuinely shared infrastructure that sends text and owns no strategy
 * decision, occupancy or ownership state. Reusing it means Engine A's alerts
 * (this strategy and the frozen RSI one) and Engine B's alerts all draw from
 * the SAME configured recipient list — one place to add or remove a
 * recipient, not three.
 */
import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TelegramEngineNotificationService } from '../telegram-engine/notifications/notification.service';
import { SarDashboardController } from './dashboard.controller';
import { SarExecutionController } from './execution.controller';
import { SarExecutionService } from './execution.service';
import { SarQueueingBrokerPort } from './queue-broker.port';
import { SarReconciliationService } from './reconciliation.service';
import { assertEngineSeparation } from './ownership';

@Module({
  imports: [PrismaModule, AccountsModule, AuthModule],
  controllers: [SarDashboardController, SarExecutionController],
  providers: [
    SarExecutionService,
    TelegramEngineNotificationService,
    SarReconciliationService,
    { provide: 'SAR_BROKER_PORT', useClass: SarQueueingBrokerPort },
  ],
  exports: [SarExecutionService, TelegramEngineNotificationService, SarReconciliationService],
})
export class XauusdSarModule {
  constructor() {
    assertEngineSeparation();
  }
}
