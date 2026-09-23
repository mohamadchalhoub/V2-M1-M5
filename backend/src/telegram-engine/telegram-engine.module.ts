/**
 * ENGINE B — the Telegram copy engine, as a Nest module.
 *
 * ## Importing this module does not start trading, and does not sign in
 *
 * Nothing here runs on a timer and nothing here connects to Telegram. The
 * ingestion adapter is started by a separate, manually started process
 * (`scripts/telegram-ingest.ts`), exactly as Engine A's observation loop is,
 * so booting the API to look at a dashboard can neither begin copying trades
 * nor touch the Telegram session.
 *
 * What the API DOES serve from this module is the collector contract and the
 * dashboard — the endpoints that move an already-decided leg to the terminal
 * and show an operator what happened.
 *
 * ## Why it does not import `XauusdM1M5Module`
 *
 * Engine A is frozen. Importing its module would put Engine B's providers in
 * reach of Engine A's occupancy service, lock store, decision queue and
 * liquidation service — and one accidental injection is all it would take for
 * Engine B to release a slot or close a position belonging to Engine A.
 *
 * The one exception is `M1M5Mt5SnapshotService`, which is genuinely shared
 * infrastructure: it reports what the TERMINAL may do, contains no RSI rule,
 * no threshold and no schedule, and is written by the collector rather than
 * by either strategy. It is provided directly here rather than by importing
 * Engine A's module, so no other Engine A provider comes with it.
 *
 * The magic-number separation is asserted at construction rather than at
 * first trade: a constant colliding with Engine A's would let Engine A's
 * Friday liquidation close Telegram positions, and that must fail at boot,
 * loudly, not at 23:00 on a Friday.
 */
import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { M1M5Mt5SnapshotService } from '../xauusd-m1m5/mt5-snapshot.service';
import { TelegramDashboardController } from './dashboard.controller';
import { DailyReportService } from './daily-report.service';
import { TelegramEntryRetraceWatchService } from './entry-retrace-watch.service';
import { TelegramExecutionController } from './execution.controller';
import { TelegramEngineExecutionService } from './execution.service';
import { TelegramIngestionService } from './ingestion/ingestion.service';
import { TelegramLegQueueService } from './leg-queue.service';
import { assertEngineSeparation } from './ownership';
import { TelegramQueueingBrokerPort } from './queue-broker.port';
import { TelegramReconciliationService } from './reconciliation.service';
import { TelegramEngineNotificationService } from './notifications/notification.service';
import { TelegramTp1WatchService } from './tp1-watch.service';

@Module({
  imports: [PrismaModule, AccountsModule, AuthModule],
  controllers: [TelegramExecutionController, TelegramDashboardController],
  providers: [
    TelegramEngineExecutionService,
    // Engine B's own alert sender. Shares the bot and the recipients with
    // Engine A by default; shares none of its dedup state, so neither engine
    // can suppress the other's alert about a different position.
    TelegramEngineNotificationService,
    TelegramLegQueueService,
    TelegramReconciliationService,
    TelegramTp1WatchService,
    TelegramEntryRetraceWatchService,
    DailyReportService,
    TelegramIngestionService,
    // Shared terminal-permission infrastructure. See the header for why this
    // one Engine A provider is acceptable and the rest are not.
    M1M5Mt5SnapshotService,
    // The production hand-off is the collector queue. Bound by token so a
    // test can substitute a simulated broker that answers synchronously,
    // which is the only way the FILLED/FAILED/UNKNOWN branches can be
    // exercised at all — production never answers any of them directly.
    { provide: 'TELEGRAM_BROKER_PORT', useClass: TelegramQueueingBrokerPort },
  ],
  exports: [
    TelegramEngineExecutionService,
    TelegramEngineNotificationService,
    TelegramLegQueueService,
    TelegramReconciliationService,
    TelegramTp1WatchService,
    TelegramEntryRetraceWatchService,
    DailyReportService,
    TelegramIngestionService,
  ],
})
export class TelegramEngineModule {
  constructor() {
    assertEngineSeparation();
  }
}
