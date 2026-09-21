// Reliability pass — retrying a genuinely transient provider failure (rate
// limited, upstream overloaded, temporarily unavailable) before giving up
// on that provider and falling through to the next one in the chain.
// Deliberately narrow: a non-transient failure (invalid JSON, a safety
// block, a schema-invalid result, a bad API key) will never succeed no
// matter how many times it's retried, so those fail fast instead of
// wasting the whole retry budget on something that can't recover.
const TRANSIENT_ERROR_PATTERN = /\b(429|500|502|503|504)\b|temporarily overloaded|service unavailable|rate limit/i;

export function isTransientAiError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_ERROR_PATTERN.test(message);
}

// 3 retries, exponential backoff (2s, 4s, 8s) — 4 attempts total per
// provider before giving up on it.
const RETRY_DELAYS_MS = [2000, 4000, 8000];

/**
 * Retries `fn` when it throws a transient error, waiting the corresponding
 * `RETRY_DELAYS_MS` entry between attempts. A non-transient error, or a
 * transient one that's exhausted every retry, propagates immediately —
 * `FallbackAiProvider` treats that as "this provider is done, try the next
 * one," same as it always has.
 */
export async function withTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length || !isTransientAiError(err)) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}
