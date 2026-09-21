import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountsModule } from '../accounts/accounts.module';
import { AiModule } from '../ai/ai.module';
import { AI_CONFIG, AiConfig } from '../ai/ai.config';
import { AuthModule } from '../auth/auth.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { MarketEventsModule } from '../market-events/market-events.module';
import { AUTONOMOUS_RULES_CONFIG, loadAutonomousRulesConfig } from './autonomous-rules.config';
import { AutonomousRuleEngineService } from './autonomous-rule-engine.service';
import { AutonomousDecisionLoggerService } from './autonomous-decision-logger.service';
import { AutonomousAiDecisionService } from './autonomous-ai-decision.service';
import { AutonomousExecutionCoordinatorService } from './autonomous-execution-coordinator.service';
import { AutonomousExecutionController } from './autonomous-execution.controller';
import { AUTONOMOUS_AI_PROVIDER } from './autonomous-ai-provider.token';
import { buildAutonomousAiProvider } from './autonomous-ai-provider.factory';

/**
 * Autonomous demo trading (v2) — AUTONOMOUS_DEMO_TRADING_PLAN.md and
 * AUTONOMOUS_RULE_ENGINE_SPEC.md. Phase 6: this module can now compute a
 * decision (mechanical rule → AI confirmation → risk manager) and queue an
 * approved order for the collector to pick up via
 * `AutonomousExecutionController`'s poll/report routes — but nothing here
 * runs on a schedule. `AutonomousExecutionCoordinatorService.run()` has no
 * automatic caller; someone (a script today, a real scheduler later, added
 * as its own deliberate decision) must invoke it. `PrismaService` is
 * available via the global `PrismaModule`, so it isn't imported here.
 *
 * Reuses `AiModule` (for `AI_CONFIG`/credentials and
 * `HistoricalPatternSummaryService`), `MarketEventsModule` (for
 * `MarketEventQueryService`), `AccountsModule` and `AuthModule` (for
 * `CollectorTokenGuard` — same per-account collector-auth convention every
 * other collector-facing route in this codebase already uses) rather than
 * re-implementing any of them. The only NEW provider-specific code is
 * `AutonomousGeminiProvider`/`AutonomousGroqProvider`/`AutonomousOpenRouterProvider`,
 * since the existing `AiProvider` family is hard-coupled to the
 * alert-narration schema (`AlertContext`/`AiAnalysisResult`), not reusable
 * for a trade-decision one.
 *
 * Reliability pass — found live this session: Gemini's free-tier daily
 * quota is exhausted at the Google Cloud PROJECT level, not the API-key
 * level, so a new key alone doesn't recover from it. `AUTONOMOUS_AI_PROVIDER`
 * is therefore wired the same way `AI_PROVIDER` (ai.module.ts) already is
 * for the alert-narration side: Gemini first, then whichever of
 * OPENROUTER_API_KEY/GROQ_API_KEY are configured (`AI_CONFIG.fallbacks`,
 * already computed by `loadAiConfig`), wrapped in `AutonomousFallbackProvider`.
 */
@Module({
  imports: [MarketDataModule, AiModule, MarketEventsModule, AccountsModule, AuthModule],
  controllers: [AutonomousExecutionController],
  providers: [
    {
      provide: AUTONOMOUS_RULES_CONFIG,
      useFactory: (config: ConfigService) => loadAutonomousRulesConfig(config),
      inject: [ConfigService],
    },
    {
      provide: AUTONOMOUS_AI_PROVIDER,
      useFactory: (config: AiConfig) => buildAutonomousAiProvider(config),
      inject: [AI_CONFIG],
    },
    AutonomousRuleEngineService,
    AutonomousDecisionLoggerService,
    AutonomousAiDecisionService,
    AutonomousExecutionCoordinatorService,
  ],
  exports: [
    AUTONOMOUS_RULES_CONFIG,
    AutonomousRuleEngineService,
    AutonomousDecisionLoggerService,
    AutonomousAiDecisionService,
    AutonomousExecutionCoordinatorService,
  ],
})
export class AutonomousModule {}
