/**
 * `xauusd-m1-m5-rsi-threshold-v2` — this application's single enabled entry
 * strategy (§2).
 *
 * ## Importing this module does not start trading
 *
 * Nothing here runs on a timer inside the Nest application. The observation
 * loop is a separate, manually started process
 * (`scripts/xauusd-m1m5-scheduler.ts`), which is what keeps "manual start
 * only" (§14) true rather than aspirational: booting the API to look at a
 * dashboard cannot begin trading, and there is no scheduled task, service or
 * startup shortcut anywhere in this project.
 *
 * ## Why this module reuses so little
 *
 * The strategy it sits alongside imports `GoldExecutionModule` to reuse that
 * module's Telegram channel, close-request path and collector endpoints. This
 * one deliberately does not.
 *
 * §1 requires this application to have its own Telegram delivery and
 * deduplication records, its own collector credentials and its own runtime
 * state. Reusing another strategy's delivery plumbing would put this
 * strategy's notifications into that strategy's channel and its dedup table —
 * exactly the confusion §13 exists to prevent, given that both bots trade the
 * same symbol on the same broker from the same machine.
 *
 * What is shared is genuinely generic: Prisma, auth, accounts.
 */
import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { M1M5OccupancyService } from './occupancy.service';
import { M1M5CloseRequestService } from './close-request.service';
import { M1M5ProtectionService } from './protection.service';
import { M1M5TelegramService } from './telegram.service';
import { M1M5DecisionQueueService } from './decision-queue.service';
import { M1M5ExecutionService } from './execution.service';
import { M1M5Mt5SnapshotService } from './mt5-snapshot.service';
import { M1M5QueueingBrokerPort } from './queue-broker.port';
import { M1M5DashboardController } from './dashboard.controller';
import { M1M5ExecutionController } from './execution.controller';

@Module({
  imports: [PrismaModule, AccountsModule, AuthModule],
  controllers: [M1M5DashboardController, M1M5ExecutionController],
  providers: [
    M1M5OccupancyService,
    M1M5DecisionQueueService,
    M1M5CloseRequestService,
    M1M5TelegramService,
    M1M5ProtectionService,
    M1M5Mt5SnapshotService,
    M1M5ExecutionService,
    // The production broker hand-off is the collector queue. Bound by token so
    // a test can substitute a simulated broker that answers synchronously,
    // which is the only way the FILLED/FAILED/UNKNOWN branches of the
    // execution service can be exercised at all -- production never answers
    // any of them directly.
    { provide: 'M1M5_BROKER_PORT', useClass: M1M5QueueingBrokerPort },
  ],
  exports: [
    M1M5OccupancyService,
    M1M5DecisionQueueService,
    M1M5CloseRequestService,
    M1M5TelegramService,
    M1M5ProtectionService,
    M1M5Mt5SnapshotService,
    M1M5ExecutionService,
  ],
})
export class XauusdM1M5Module {}
