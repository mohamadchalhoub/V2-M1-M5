import { Logger } from '@nestjs/common';
import { AiAnalysisResult, AiProvider, AlertContext } from './ai-provider.interface';
import { isTransientAiError, withTransientRetry } from './retry';

/**
 * Reliability pass — tries each provider in order, returning the first
 * success. Only throws (which `AiAnalysisProcessor` already treats as "AI
 * analysis failed, the trading alert still sends unaffected" — that
 * behavior needed no changes) once every provider in the chain has
 * failed. A composite `AiProvider`, not a change to how it's called:
 * `AiAnalysisProcessor` still calls `.analyze()` exactly once, same as
 * with any single provider — it has no idea a fallback chain exists.
 *
 * Each provider gets `withTransientRetry`'s own retry budget (retry.ts) —
 * a provider that's merely rate-limited/temporarily overloaded gets a real
 * chance to recover before this class gives up on it and moves to the
 * next one, rather than burning through the whole fallback chain on the
 * first blip.
 */
export class FallbackAiProvider implements AiProvider {
  private readonly logger = new Logger(FallbackAiProvider.name);

  constructor(private readonly providers: AiProvider[]) {
    if (providers.length === 0) {
      throw new Error('FallbackAiProvider requires at least one provider');
    }
  }

  async analyze(context: AlertContext): Promise<AiAnalysisResult> {
    let lastError: unknown;
    for (const [index, provider] of this.providers.entries()) {
      try {
        return await withTransientRetry(() => provider.analyze(context));
      } catch (err) {
        lastError = err;
        const isLast = index === this.providers.length - 1;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `provider ${index + 1}/${this.providers.length} (${provider.constructor.name}) failed` +
            (isTransientAiError(err) ? ' (transient, retries exhausted)' : ' (non-transient, not retried)') +
            (isLast ? ', no more fallbacks' : ', trying next') +
            `: ${message}`,
        );
      }
    }
    throw lastError;
  }
}
