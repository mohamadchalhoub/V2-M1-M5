import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { JobsModule } from '../jobs/jobs.module';
import { TelegramModule } from '../telegram/telegram.module';
import { DataIntegrityProcessor } from './data-integrity.processor';
import { HealthCheckProcessor } from './health-check.processor';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { HealthStatusWriterService } from './health-status-writer.service';
import { HeartbeatDigestProcessor } from './heartbeat-digest.processor';
import { GoldTelegramService } from '../gold-execution/gold-telegram.service';

/**
 * Phase 0 §15/§13 — a second observer, independent of the trading path. Does
 * NOT import `rules`/`alerts`/`analytics` — a bug in trading-rule logic must
 * never be able to affect whether the system correctly reports its own
 * health. It DOES import `telegram` (for a lightweight reachability probe,
 * `TelegramBotClient.checkConnectivity`) and `ai` (for `AiConfig`, to know
 * whether AI is even enabled before judging its health) — both leaf,
 * client/config-shaped dependencies, not the decision-making services.
 */
@Module({
  imports: [JobsModule, TelegramModule, AiModule, AuthModule],
  controllers: [HealthController],
  providers: [HealthService, HealthCheckProcessor, DataIntegrityProcessor, HealthStatusWriterService, HeartbeatDigestProcessor, GoldTelegramService],
})
export class HealthModule {}
