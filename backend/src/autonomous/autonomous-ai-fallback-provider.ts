import { Logger } from '@nestjs/common';
import { isTransientAiError, withTransientRetry } from '../ai/retry';
import { AutonomousAiContext, AutonomousAiProvider, RawAutonomousAiDecision } from './autonomous-ai-decision.types';

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Same pattern as `ai/fallback-provider.ts` (tries each provider in order,
 * each with its own `withTransientRetry` budget, returns the first
 * success), for `AutonomousAiProvider` instead of `AiProvider`. Added after
 * this session found live that Gemini's free-tier daily quota is exhausted
 * at the ACCOUNT level, not the API-key level — a new key under the same
 * Google Cloud project inherits the same exhausted quota, so a real
 * fallback to a different provider (not just a different key) is the only
 * way to keep the Phase 5 AI-assisted backtest (and later, live decisions)
 * running when that happens.
 *
 * Cooldown (found necessary live this session, not in `ai/fallback-provider.ts`):
 * a provider that just failed is skipped — without spending its own
 * `withTransientRetry` budget again — on subsequent `decide()` calls for
 * `cooldownMs`. Without this, a single instance reused across many calls in
 * a short window (this module's own `AUTONOMOUS_AI_PROVIDER` is a
 * NestJS-singleton, and the backtest script calls `decide()` roughly once
 * per mechanical candidate) would re-run Gemini's full ~14s retry-and-
 * backoff on EVERY call even though it's known to still be quota-exhausted
 * from the last call a few seconds ago. The cooldown is intentionally
 * bounded (not permanent) rather than a one-way circuit breaker, so a
 * provider whose failure was time-boxed (a per-minute rate limit, a daily
 * quota that resets) gets tried again on its own later — this module never
 * assumes a failed provider is down for good.
 */
export class AutonomousFallbackProvider implements AutonomousAiProvider {
  private readonly logger = new Logger(AutonomousFallbackProvider.name);
  private readonly cooldownUntilMs: number[];

  /**
   * Mutated to whichever leaf provider answered the MOST RECENT successful
   * `decide()` call — see `AutonomousAiProvider.providerName`'s own comment
   * for the defect this fixes. 'unknown' only before the very first call.
   */
  providerName = 'unknown';

  constructor(
    private readonly providers: AutonomousAiProvider[],
    private readonly cooldownMs = DEFAULT_COOLDOWN_MS,
  ) {
    if (providers.length === 0) {
      throw new Error('AutonomousFallbackProvider requires at least one provider');
    }
    this.cooldownUntilMs = providers.map(() => 0);
  }

  async decide(context: AutonomousAiContext): Promise<RawAutonomousAiDecision> {
    const now = Date.now();
    const available = this.providers.map((_, index) => index).filter((index) => this.cooldownUntilMs[index] <= now);
    // If EVERY provider is currently cooling down, try them all anyway
    // (in original order) rather than failing without attempting a single
    // call — a bounded cooldown is a "try this one less often" hint, never
    // a hard "never call this" rule.
    const order = available.length > 0 ? available : this.providers.map((_, index) => index);

    let lastError: unknown;
    for (const [position, index] of order.entries()) {
      const provider = this.providers[index];
      try {
        const result = await withTransientRetry(() => provider.decide(context));
        this.cooldownUntilMs[index] = 0;
        this.providerName = provider.providerName;
        return result;
      } catch (err) {
        lastError = err;
        this.cooldownUntilMs[index] = now + this.cooldownMs;
        const isLast = position === order.length - 1;
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
