// One named queue carries every delivery job (deliver + the reconciliation
// sweep) — PHASE5_DELIVERY_SPEC.md §4: "don't introduce unnecessary
// infrastructure" (Phase 0 §24) argues against a second queue/worker pair
// for the sweep when job `name` alone is enough to dispatch.
export const TELEGRAM_DELIVERY_QUEUE_NAME = 'telegram-delivery';

export const TELEGRAM_DELIVERY_QUEUE = Symbol('TELEGRAM_DELIVERY_QUEUE');

export const RECONCILIATION_SWEEP_JOB_ID = 'reconciliation-sweep';

/**
 * Deterministic job id for one AlertDelivery's send — PHASE5_DELIVERY_SPEC.md
 * §6: BullMQ refuses a duplicate active jobId, closing the duplicate-enqueue
 * race. No prefix/separator (BullMQ v6 rejects `:` in custom job ids — it
 * uses colons as its own Redis key namespacing) — the AlertDelivery's own
 * uuid is already unique, so it's used as-is.
 */
export function deliveryJobId(alertDeliveryId: string): string {
  return alertDeliveryId;
}

// Phase 6 — AI_INTEGRATION_SPEC.md §7. A SEPARATE queue from delivery: AI
// generation has its own (smaller) retry budget and no reconciliation-sweep
// requirement (a FAILED AiAnalysis is a missed narrative, not a missed
// alert — message #1 already went out via TELEGRAM_DELIVERY_QUEUE). The
// `ai` module's worker consumes this; once a result is READY, it enqueues
// the actual Telegram send as a 'deliver-ai-narrative' job on
// TELEGRAM_DELIVERY_QUEUE instead — telegram remains the only module that
// ever calls the Bot API (AI_INTEGRATION_SPEC.md §1).
export const AI_ANALYSIS_QUEUE_NAME = 'ai-analysis';

export const AI_ANALYSIS_QUEUE = Symbol('AI_ANALYSIS_QUEUE');

/** Deterministic job id for one AiAnalysis's generation — same dedup reasoning as deliveryJobId. */
export function aiAnalysisJobId(aiAnalysisId: string): string {
  return aiAnalysisId;
}

// Phase 7 — HEALTH_SPEC.md. A third, independent queue: health checks run on
// their own schedule and must never be delayed by a delivery/AI backlog, and
// (Phase 0 §01's fourth invariant) the health checker's own status must not
// depend on the thing it's checking being healthy — sharing a queue with
// the very things it monitors would violate that.
export const HEALTH_CHECK_QUEUE_NAME = 'health-check';

export const HEALTH_CHECK_QUEUE = Symbol('HEALTH_CHECK_QUEUE');

export const HEALTH_CHECK_JOB_ID = 'health-check-tick';

// Phase 11 — HEALTH_SPEC.md's flagged gap, closed. A fourth, independent
// queue for the same reason HEALTH_CHECK_QUEUE is its own queue: a weekly
// audit must never be delayed by (or delay) the health checker's own
// 60-second cadence, and the two report through the same DATA_INTEGRITY
// component but run on entirely different schedules.
export const DATA_INTEGRITY_QUEUE_NAME = 'data-integrity-check';

export const DATA_INTEGRITY_QUEUE = Symbol('DATA_INTEGRITY_QUEUE');

export const DATA_INTEGRITY_JOB_ID = 'data-integrity-check-tick';

// Market intelligence (production readiness review, market-events phase) —
// a fifth, independent queue: ingestion runs on its own daily-ish schedule
// (FRED's calendar doesn't change intraday) and must never be delayed by,
// or delay, any of the trading-path queues above. Unlike the health/
// integrity queues, this one calls a real external HTTP API that can
// transiently fail, so it gets a small retry budget rather than
// `attempts: 1`.
export const MARKET_EVENT_QUEUE_NAME = 'market-event-ingestion';

export const MARKET_EVENT_QUEUE = Symbol('MARKET_EVENT_QUEUE');

export const MARKET_EVENT_JOB_ID = 'market-event-ingestion-tick';

// Market intelligence, news phase — a SIXTH, independent queue, deliberately
// separate from MARKET_EVENT_QUEUE (FRED): the two providers must stay
// uncoupled (do NOT tightly couple FRED and Marketaux), and Marketaux's tiny
// 100-requests/day free-tier budget means its own retry budget must be much
// smaller/slower than FRED's — sharing a queue would mean one provider's
// retry policy accidentally governs the other's.
export const MARKET_NEWS_QUEUE_NAME = 'market-news-ingestion';

export const MARKET_NEWS_QUEUE = Symbol('MARKET_NEWS_QUEUE');

export const MARKET_NEWS_JOB_ID = 'market-news-ingestion-tick';

// Economic calendar gap fill (Objective 4) — a SEVENTH, independent queue.
// Unlike MARKET_EVENT_QUEUE (FRED) and MARKET_NEWS_QUEUE (Marketaux), this
// one never calls an external API at all (curated-central-bank-meetings.ts
// is static, in-process data) — idempotent and side-effect-free on every
// run, so it gets the same "no retries needed" posture as
// DATA_INTEGRITY_QUEUE rather than a network-failure retry budget.
export const CENTRAL_BANK_CALENDAR_QUEUE_NAME = 'central-bank-calendar-ingestion';

export const CENTRAL_BANK_CALENDAR_QUEUE = Symbol('CENTRAL_BANK_CALENDAR_QUEUE');

export const CENTRAL_BANK_CALENDAR_JOB_ID = 'central-bank-calendar-ingestion-tick';

// User's custom EURUSD trading rules (Rules 3+4, the daily morning report)
// — an EIGHTH, independent queue. Runs once a day at DAILY_ANALYSIS_TIME/
// DAILY_ANALYSIS_TIMEZONE (a cron `pattern` + `tz`, not `every` — the only
// queue in this app scheduled by wall-clock time-of-day rather than a
// fixed interval). No external HTTP call (candles/events are already in
// Postgres), same "no retries needed" posture as DATA_INTEGRITY_QUEUE/
// CENTRAL_BANK_CALENDAR_QUEUE.
export const DAILY_MARKET_ANALYSIS_QUEUE_NAME = 'daily-market-analysis';

export const DAILY_MARKET_ANALYSIS_QUEUE = Symbol('DAILY_MARKET_ANALYSIS_QUEUE');

export const DAILY_MARKET_ANALYSIS_JOB_ID = 'daily-market-analysis-tick';

// Reliability pass — "let me know the system is alive even on a quiet day"
// — a NINTH, independent queue. Deliberately separate from
// DAILY_MARKET_ANALYSIS_QUEUE despite both being once-a-day cron jobs: this
// one lives in `health` (reads HealthStatus + counts today's Alerts, sends
// straight to TELEGRAM_OPS_CHAT_IDS via TelegramBotClient — it does NOT go
// through the Alert/AlertDelivery/NotificationClass.SYSTEM_HEALTH pipeline,
// which is reserved for future real-time incident notifications sourced
// from HealthIncident rows, a different concept from this periodic digest).
// Gets a real retry budget (unlike DAILY_MARKET_ANALYSIS_QUEUE's
// attempts: 1) because, unlike that job, this one DOES make an external
// call (Telegram) that can transiently fail — same reasoning as
// MARKET_EVENT_QUEUE.
export const HEARTBEAT_DIGEST_QUEUE_NAME = 'heartbeat-digest';

export const HEARTBEAT_DIGEST_QUEUE = Symbol('HEARTBEAT_DIGEST_QUEUE');

export const HEARTBEAT_DIGEST_JOB_ID = 'heartbeat-digest-tick';

// Finnhub forex news — a TENTH, independent queue, deliberately separate
// from MARKET_NEWS_QUEUE (Marketaux): the two news providers must stay
// uncoupled, same reasoning as FRED/Marketaux above, and their free-tier
// rate limits differ enough (60/min vs 100/day) that sharing a retry
// budget would be wrong for one or the other.
export const FINNHUB_NEWS_QUEUE_NAME = 'finnhub-news-ingestion';

export const FINNHUB_NEWS_QUEUE = Symbol('FINNHUB_NEWS_QUEUE');

export const FINNHUB_NEWS_JOB_ID = 'finnhub-news-ingestion-tick';
