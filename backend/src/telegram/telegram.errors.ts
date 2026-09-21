/** Retried with backoff (PHASE5_DELIVERY_SPEC.md §5) — network errors, Telegram 5xx, Telegram 429. */
export class TelegramTransientError extends Error {}

/** Fails the job immediately via BullMQ's UnrecoverableError, no retries wasted — Telegram 400/403. */
export class TelegramPermanentError extends Error {}
