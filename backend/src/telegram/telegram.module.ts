import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobsModule } from '../jobs/jobs.module';
import { TelegramBotClient } from './telegram-bot.client';
import { TelegramDeliveryProcessor } from './telegram-delivery.processor';
import { TELEGRAM_CONFIG, loadTelegramConfig } from './telegram.config';

/**
 * Owns `AlertDelivery`'s Telegram-facing side: the bot client, message
 * templates, and the delivery worker (Phase 0 §15). Does NOT import
 * `AlertsModule` — it reads `Alert`/`AlertDelivery` directly via the global
 * `PrismaService`, and needs none of `alerts`' services
 * (RuleEngineService/AlertLifecycleService), so importing the whole module
 * graph above it would add a dependency edge with no actual use.
 * `TelegramConfig` (§ startup validation, Req. 9) is loaded eagerly here —
 * a missing/invalid env var fails `NestFactory.create(...)` before the app
 * binds a port.
 */
@Module({
  imports: [JobsModule],
  providers: [
    {
      provide: TELEGRAM_CONFIG,
      useFactory: (config: ConfigService) => loadTelegramConfig(config),
      inject: [ConfigService],
    },
    TelegramBotClient,
    TelegramDeliveryProcessor,
  ],
  // TELEGRAM_CONFIG exported alongside TelegramBotClient (reliability pass)
  // so health/heartbeat-digest.processor.ts can read `opsChatIds` — the
  // same config `telegram-delivery.processor.ts` already reads internally,
  // now also needed one layer up since the heartbeat digest sends directly
  // rather than through this module's own delivery worker.
  exports: [TelegramBotClient, TELEGRAM_CONFIG],
})
export class TelegramModule {}
