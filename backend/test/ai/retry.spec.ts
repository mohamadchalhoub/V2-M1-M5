import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTransientAiError, withTransientRetry } from '../../src/ai/retry';

describe('isTransientAiError', () => {
  it.each(['429', '500', '502', '503', '504'])('classifies a message containing HTTP %s as transient', (status) => {
    expect(isTransientAiError(new Error(`Gemini returned ${status}: {"error":"..."}`))).toBe(true);
  });

  it('classifies "temporarily overloaded" as transient (OpenRouter\'s embedded-upstream-error shape)', () => {
    expect(isTransientAiError(new Error('OpenRouter returned 200 with an embedded upstream error: Upstream error from Nvidia: Service temporarily overloaded'))).toBe(true);
  });

  it('classifies "service unavailable" and "rate limit" as transient', () => {
    expect(isTransientAiError(new Error('Service Unavailable'))).toBe(true);
    expect(isTransientAiError(new Error('you have hit the rate limit'))).toBe(true);
  });

  it('does not classify a 200 status number as transient (must not false-positive on unrelated numbers)', () => {
    expect(isTransientAiError(new Error('OpenRouter returned 200: ok'))).toBe(false);
  });

  it('does not classify a non-transient failure (bad JSON, safety block, schema error) as transient', () => {
    expect(isTransientAiError(new Error('Gemini response was not valid JSON'))).toBe(false);
    expect(isTransientAiError(new Error('Gemini blocked the request: SAFETY'))).toBe(false);
    expect(isTransientAiError(new Error('provider unavailable'))).toBe(false);
  });

  it('handles a non-Error thrown value without crashing', () => {
    expect(isTransientAiError('503 something')).toBe(true);
    expect(isTransientAiError(undefined)).toBe(false);
  });
});

describe('withTransientRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the result immediately on first success — no delay, called once', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withTransientRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('does not retry a non-transient error — fails immediately, called once', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('not valid JSON'));
    await expect(withTransientRetry(fn)).rejects.toThrow('not valid JSON');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries a transient error with 2s/4s/8s backoff, then succeeds on the 2nd attempt', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('503 Service Unavailable')).mockResolvedValueOnce('ok');
    const promise = withTransientRetry(fn);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries up to 3 times (4 attempts total) on a persistently transient error, with the documented 2s/4s/8s delays, then gives up', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('429 rate limit'));
    const promise = withTransientRetry(fn);
    promise.catch(() => {}); // avoid an unhandled-rejection warning while timers advance

    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(fn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(8000);
    expect(fn).toHaveBeenCalledTimes(4);

    await expect(promise).rejects.toThrow('429 rate limit');
    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries, never a 5th
  });
});
