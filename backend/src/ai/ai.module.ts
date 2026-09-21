import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HistoricalChartsModule } from '../historical-charts/historical-charts.module';
import { JobsModule } from '../jobs/jobs.module';
import { MarketEventsModule } from '../market-events/market-events.module';
import { AiAnalysisProcessor } from './ai-analysis.processor';
import { AI_PROVIDER } from './ai-provider.token';
import { AnthropicProvider } from './anthropic-provider';
import { FallbackAiProvider } from './fallback-provider';
import { GeminiProvider } from './gemini-provider';
import { GroqProvider } from './groq-provider';
import { HistoricalPatternSummaryService } from './historical-pattern-summary.service';
import { MarketContextBuilderService } from './market-context-builder.service';
import { MockAiProvider } from './mock-provider';
import { OpenRouterProvider } from './openrouter-provider';
import { AI_CONFIG, AiConfig, loadAiConfig } from './ai.config';

/**
 * Owns AI narration end-to-end: config validation, provider selection, the
 * safety filter, and the `AI_ANALYSIS_QUEUE` worker (AI_INTEGRATION_SPEC.md
 * §2). Does NOT import `alerts` or `telegram` — it reads `Alert`/`AiAnalysis`
 * directly via the global PrismaService, and hands off to Telegram only by
 * enqueueing a job on `TELEGRAM_DELIVERY_QUEUE` (via `JobsModule`), never by
 * calling `TelegramBotClient` itself. `AiConfig` (§9, startup validation) is
 * loaded eagerly — with AI_ENABLED=false (the default) this is a no-op; with
 * AI_ENABLED=true, a missing provider/model/key fails `NestFactory.create(...)`
 * before the app binds a port, same posture as `telegram.config.ts`.
 */
@Module({
  imports: [JobsModule, MarketEventsModule, HistoricalChartsModule],
  providers: [
    {
      provide: AI_CONFIG,
      useFactory: (config: ConfigService) => loadAiConfig(config),
      inject: [ConfigService],
    },
    {
      provide: AI_PROVIDER,
      useFactory: (config: AiConfig) => {
        // Constructed even when disabled — harmless (holds config only,
        // makes no network call until .analyze() is invoked, which
        // AiAnalysisProcessor never does while config.enabled is false).
        switch (config.enabled ? config.provider : 'anthropic') {
          case 'anthropic':
            return new AnthropicProvider(config);
          case 'openrouter':
            return new OpenRouterProvider(config);
          case 'gemini': {
            const gemini = new GeminiProvider(config);
            // Reliability pass — config.fallbacks is only ever populated
            // (per ai.config.ts) with whichever of OPENROUTER_API_KEY/
            // GROQ_API_KEY are actually set, already in try-order
            // (OpenRouter before Groq). With neither set, Gemini just runs
            // alone like any other single-provider setup.
            if (config.fallbacks.length === 0) return gemini;
            const fallbackProviders = config.fallbacks.map((fb) => {
              const fallbackConfig = { ...config, apiKey: fb.apiKey, model: fb.model };
              return fb.provider === 'groq' ? new GroqProvider(fallbackConfig) : new OpenRouterProvider(fallbackConfig);
            });
            return new FallbackAiProvider([gemini, ...fallbackProviders]);
          }
          case 'mock':
            return new MockAiProvider();
          default:
            throw new Error(`Unknown AI_PROVIDER "${config.provider}" — supported: anthropic, openrouter, gemini, mock`);
        }
      },
      inject: [AI_CONFIG],
    },
    MarketContextBuilderService,
    HistoricalPatternSummaryService,
    AiAnalysisProcessor,
  ],
  // HistoricalPatternSummaryService exported alongside AI_CONFIG so the
  // autonomous-trading module (a separate feature, same friend's-EURUSD-
  // history need) can reuse the exact same deterministic BUY/SELL pattern
  // summary instead of re-querying TradeAlignmentService a second way.
  exports: [AI_CONFIG, HistoricalPatternSummaryService],
})
export class AiModule {}
