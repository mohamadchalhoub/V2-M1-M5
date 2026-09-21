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
import { M1M5DashboardController } from './dashboard.controller';

@Module({
  imports: [PrismaModule, AccountsModule, AuthModule],
  controllers: [M1M5DashboardController],
  providers: [M1M5OccupancyService],
  exports: [M1M5OccupancyService],
})
export class XauusdM1M5Module {}
