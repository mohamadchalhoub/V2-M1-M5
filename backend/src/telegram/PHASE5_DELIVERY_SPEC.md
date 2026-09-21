# Phase 5 — Reliable Telegram Alert Delivery + Background Jobs
> See `../../../PROJECT_STATUS.md` at the repo root for the authoritative build order, phase-numbering crosswalk, and current status of every component.

Status: **DESIGN ONLY — awaiting approval. No code in this phase yet.**

Written against the approved Phase 0 architecture (`telegram`/`jobs` modules, §11/§13/§15/§20/§26),
the completed Phase 4 `alerts` module, and the current Prisma schema. Nothing here reopens Phase 4's
design — `alerts` gains exactly one new relation (`Alert.delivery`); `RuleEngineService` and
`AlertLifecycleService` are untouched.

**Constraints this design is built to satisfy:**
The Rule Engine never waits for Telegram — `AlertLifecycleService.apply()` still returns the moment
the `Alert` row is committed. Delivery happens strictly after, off the request path. The dashboard is
not built yet and is never required for delivery to work. The system keeps delivering alerts with the
browser closed, across backend restarts, across worker restarts, and (once Redis recovers) across a
Redis outage. AI is not involved — see the closing section.

---

## 1. Architecture

```
AlertLifecycleService.apply()
  → Alert row committed (Phase 4, unchanged)
  → AlertDelivery row committed, status=PENDING   (NEW — same transaction, §3)
  → best-effort BullMQ enqueue                    (NEW — outside that transaction, §4)
        ↓ (Redis up)                    ↓ (Redis down)
  TelegramDeliveryProcessor         reconciliation sweep picks it up later (§7)
  (BullMQ worker)
        ↓
  Telegram Bot API sendMessage
        ↓
  AlertDelivery.status → SENT | FAILED | DEAD      (§5)
```

The same shape serves `HealthIncident` once the health module exists (§13), via the message-class
discriminator in §2 — not built in Phase 5, but not designed away either.

**Why a DB row before a queue job, not just a queue job:** BullMQ's job store lives in Redis. If
Redis has no persistence configured, or loses data before a job is processed, an alert that only ever
existed as a Redis job is unrecoverable — silently. Writing `AlertDelivery` to Postgres *first*, in
the same transaction as the decision to notify, makes Postgres (already the system's durable source
of truth for everything else) the record of "this alert needs to be delivered," and the Redis job is
just the *live trigger* for picking it up promptly. This is the transactional-outbox pattern — it's
what makes "jobs remaining after restart" and "Redis outage" survivable without a fundamentally
different design for each (§7).

---

## 2. Message classes stay distinct

Per your instruction, trading alerts and system-health incidents are two message classes through one
delivery worker, not one undifferentiated stream:

```prisma
enum NotificationClass {
  TRADING_ALERT
  SYSTEM_HEALTH
}
```

`AlertDelivery.class` is always `TRADING_ALERT` in Phase 5 (the only source that exists is `alerts`).
The processor selects both the **message template** and the **destination chat IDs**
(`TELEGRAM_TRADING_CHAT_IDS` vs `TELEGRAM_OPS_CHAT_IDS`, Phase 0 §20) by this field — so adding
`SYSTEM_HEALTH` later (from a future `health_incidents` table) is a new row source and a new template
function, not a schema or worker redesign.

---

## 3. Schema additions

```prisma
enum NotificationClass {
  TRADING_ALERT
  SYSTEM_HEALTH
}

enum DeliveryStatus {
  PENDING     // row written, not yet handed to a worker (or enqueue failed — §7 sweep will pick it up)
  SENT        // Telegram accepted it for every configured recipient
  FAILED      // a transient failure, will retry (attempts < maxAttempts)
  DEAD        // exhausted retries or a permanent error — needs human attention
}

model AlertDelivery {
  id            String             @id @default(uuid())
  alertId       String             @unique @map("alert_id")   // TRADING_ALERT source; nullable FK design left room for a future healthIncidentId
  class         NotificationClass  @default(TRADING_ALERT)
  status        DeliveryStatus     @default(PENDING)
  attempts      Int                @default(0)
  lastError     String?            @map("last_error")          // truncated, never the bot token (§10)
  telegramMessageIds Json          @default("[]") @map("telegram_message_ids") // one per recipient chat, for audit/dedup
  createdAt     DateTime           @default(now()) @map("created_at")
  sentAt        DateTime?          @map("sent_at")
  updatedAt     DateTime           @updatedAt @map("updated_at")

  alert Alert @relation(fields: [alertId], references: [id], onDelete: Cascade)

  @@index([status, createdAt])   // the reconciliation sweep's query (§7)
  @@map("alert_deliveries")
}
```

`alertId` is `@unique` — one delivery record per alert, by design (§6: an alert either gets delivered
or doesn't; a *resend* is a deliberate future operator action, not automatic re-delivery of the same
alert). Add the back-relation `delivery AlertDelivery?` to `Alert`. No changes to `rule_definitions`,
`rule_states`, or any Phase 1–3 table.

---

## 4. Modules

Matching Phase 0 §15's `telegram`/`jobs` split:

- **`jobs`** — BullMQ registration only: the Redis connection, the queue definition
  (`telegram-delivery`), retry/backoff policy (§5), nothing message-shaped. `alerts` and `telegram`
  both depend on it; it depends on nothing else in this system.
- **`telegram`** — owns `AlertDelivery` CRUD, the `TelegramBotClient` (a thin wrapper over the Bot
  API's `sendMessage`, the only Telegram-specific code in the system), message template rendering per
  class, and the `TelegramDeliveryProcessor` (the BullMQ worker). Depends on `jobs` and `alerts`
  (reads `Alert.triggerValues`/`ruleSnapshot` to render the message — never calls back into
  `AnalyticsService`/`RuleEngineService`; the message is built entirely from what's already frozen on
  the `Alert` row, consistent with Phase 4's immutability guarantee, §6).
- **`alerts`** (existing, Phase 4) — gains one new call: after `AlertLifecycleService.apply()`
  commits an `Alert`, it also creates the `AlertDelivery` row and attempts the enqueue (§7). This is
  the *only* change to Phase 4 code — everything else in `alerts`/`rules` is untouched.

`AlertLifecycleService.apply()` itself still does not import `telegram` or `jobs` directly — the
enqueue call is a new, separate step invoked by `RuleEngineService` (or a thin
`AlertDeliveryDispatchService` in `telegram` that `alerts` calls) immediately after `apply()` returns,
outside the DB transaction, so a Redis hiccup can never roll back an already-decided alert.

---

## 5. Retry, backoff, dead-letter

BullMQ's built-in job options, not a hand-rolled retry loop:

```ts
{
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },  // 5s, 10s, 20s, 40s, 80s
  removeOnComplete: { age: 86_400 },   // keep 24h for observability, then GC
  removeOnFail: false,                  // failed/exhausted jobs stay visible until handled
}
```

Each processor attempt updates `AlertDelivery.attempts`/`lastError`. On the job's **final** failed
attempt (BullMQ's `failed` event with `attemptsMade === attempts`), the processor sets
`status = DEAD` — this is the dead-letter equivalent: no further automatic retries, and it stays
queryable in Postgres (`SELECT * FROM alert_deliveries WHERE status = 'DEAD'`) rather than only
existing as an opaque failed job in Redis. A `DEAD` row is exactly what a future dashboard's
"failed deliveries" view (or an ops Telegram message via the `SYSTEM_HEALTH` class, once that exists)
reads from — Phase 5 doesn't need to build that view, just make the data land somewhere durable and
queryable.

**Error classification** (decided once, in the processor, not per-call):
- Transient → retry: network errors, Telegram 5xx, Telegram 429 (rate limit — BullMQ's backoff plus
  respecting `retry_after` from the 429 body if present).
- Permanent → fail fast, do not exhaust 5 attempts pointlessly: Telegram 400 (malformed chat id/
  message), 403 (bot blocked by that chat). These set `status = DEAD` on the **first** such response,
  via `Bull.UnrecoverableError` (BullMQ's built-in "don't retry this" signal) rather than waiting out
  4 more doomed attempts.

---

## 6. Idempotency & duplicate-message protection

Two independent layers, because two independent things could otherwise cause a duplicate send:

1. **Job identity.** The BullMQ job's `jobId` is deterministic: `delivery:${alertDelivery.id}`. BullMQ
   refuses to enqueue a second job with a `jobId` already present in the queue — so the direct
   post-`apply()` enqueue and the reconciliation sweep (§7) racing to enqueue the *same* delivery can
   never both succeed; the second is a silent no-op.
2. **Row identity.** `AlertDelivery.alertId` is `@unique` — even outside the queue entirely (e.g. two
   backend instances briefly both handling the same request path in some future multi-instance
   deployment), only one `AlertDelivery` row can ever exist per `Alert`. Combined with Phase 4's own
   dedup (one `Alert` per notify event, §5 of `RULE_ENGINE_SPEC.md`), this means the delivery layer
   never needs its own notion of "is this the same alert" — it inherits Phase 4's guarantee and adds
   "deliver this one row exactly once" on top.

The processor itself is also written idempotently: before calling Telegram, it re-reads
`AlertDelivery.status` inside the job — if another attempt already flipped it to `SENT` (a retried job
that actually succeeded but the worker crashed before acking BullMQ), the processor no-ops instead of
sending a second Telegram message.

---

## 7. Redis outage, backend restart, worker restart

All three reduce to the same recovery mechanism, because of the outbox design in §1:

- **Redis outage at alert-creation time:** the enqueue call is wrapped in try/catch, exactly like
  `evaluateRulesSafely` in Phase 4 (`CollectorIngressController`) — a Redis failure can never fail the
  ingestion request or roll back the `Alert`/`AlertDelivery` rows. The `AlertDelivery` stays `PENDING`
  with no active job.
- **Backend restart / worker restart:** BullMQ jobs already enqueued in Redis (if Redis itself is up
  and was configured with persistence — an explicit deployment requirement, §12) survive a NestJS
  process restart; a new worker process reconnects and resumes consuming the same queue. Nothing
  Phase-5-specific is needed here beyond BullMQ's own reconnect behavior.
- **The gap both of the above can leave — a `PENDING` row with no live job (Redis lost the job, or
  the enqueue attempt itself failed):** a scheduled reconciliation sweep, run via BullMQ's own
  repeatable job (`every: 60_000`, no new cron infrastructure) inside the `jobs` module, queries
  `AlertDelivery WHERE status IN ('PENDING', 'FAILED') AND updatedAt < now() - 2min` and re-enqueues
  each with its deterministic `jobId` — safe by construction per §6 even if a job for it already
  exists. This is the same "re-running produces the same result, never a duplicate" principle Phase
  0 §06 already established for ingestion, applied to delivery.

This sweep is also the answer to **"jobs remaining after restart"**: even in the worst case (Redis
data lost entirely), nothing is lost — Postgres still has every `PENDING` `AlertDelivery`, and the
sweep re-populates Redis from there within one sweep interval.

---

## 8. Telegram API errors & Telegram outage

Covered by §5's classification for per-message errors. A sustained Telegram outage (every send
failing) is not a special case in the delivery code — it just means every job runs out its 5 attempts
and lands `DEAD` (or, if the outage is expected to be long, an operator can later requeue `DEAD` rows
once Telegram recovers — a manual action, not automated infinite retry, matching §29's still-open
"alert-fatigue"-adjacent concern about not needing more automatic machinery than the situation calls
for). What Phase 5 *does* need: the Telegram outage itself should be visible, not just each message's
individual failure — see §11.

---

## 9. Duplicate-message protection vs. Phase 4 cooldown — not the same guarantee

Worth being explicit about the boundary: Phase 4's cooldown (`RULE_ENGINE_SPEC.md` §5) decides *how
many `Alert` rows* a continuously-true condition produces. Phase 5's idempotency (§6) decides that
*each `Alert` row* produces *at most one* Telegram message. Phase 5 has no opinion on alert
frequency — it delivers whatever Phase 4 decided to create, exactly once each.

---

## 10. Structured logging without leaking secrets

Same posture as the collector token guard's allowlist pattern (Phase 2, unchanged): `TELEGRAM_BOT_TOKEN`
is read once into `TelegramBotClient`'s config and never appears in a log line, an error message, or
`AlertDelivery.lastError` — errors from the Bot API SDK/HTTP call are caught and re-stringified through
a redaction step that strips any substring matching the configured bot token before it's persisted or
logged (defense-in-depth beyond just "don't log the config object"). Chat IDs are not secret (they're
routing config) but are still not logged at info level beyond a count Message content (drawdown %,
dollar figures) is not a credential — it's the alert itself, meant to reach Telegram — so it is not
redacted, only the transport credential is.

---

## 11. Health monitoring integration

Phase 5 does **not** build the seven-component health checker (Phase 0 §13) — that's a separate,
larger piece (Redis/DB/AI-provider/Telegram/collector/MT5-terminal/XTB-import checks) that this
message asked me to *design for*, not implement. What Phase 5 **does** provide, so that future
health module has something real to read:

- `AlertDelivery` rows are the queryable ground truth for "is Telegram delivery actually working" —
  a health check can cheaply query `COUNT(*) WHERE status='PENDING' AND createdAt < now() - 5min` (a
  backlog building up) or `COUNT(*) WHERE status='DEAD' AND createdAt > now() - 1h` (recent failures)
  without needing its own separate tracking.
- The BullMQ queue itself exposes depth/oldest-job-age via its own API (`queue.getJobCounts()`),
  which a health check can call directly — no new abstraction needed.

**Open scope question for you (§13 below):** should Phase 5 include a minimal `GET /health` stub that
just reports these two numbers (queue backlog, delivery failure rate), ahead of the full 7-component
checker, or is that entirely deferred to whichever phase builds `health` properly? Flagging rather
than assuming.

---

## 12. Configuration

```
# New in .env (Linux host)
REDIS_URL=redis://redis:6379
TELEGRAM_BOT_TOKEN=...
TELEGRAM_TRADING_CHAT_IDS=...      # comma-separated, Phase 0 §20 (already named there)
TELEGRAM_OPS_CHAT_IDS=...          # unused until SYSTEM_HEALTH exists, but read now so a
                                    # later health module doesn't need a config-shape change
TELEGRAM_DELIVERY_MAX_ATTEMPTS=5
TELEGRAM_DELIVERY_BACKOFF_MS=5000
DELIVERY_RECONCILIATION_INTERVAL_MS=60000
```

`docker-compose.yml` gains a `redis` service (Phase 0 §24 already named Redis as one of local dev's
two containers, alongside Postgres — this is not new infrastructure, just finally used).
**Redis persistence** (`appendonly yes` or periodic RDB snapshots) needs to be an explicit compose
setting, not the image default — otherwise §7's "Redis outage" recovery relies entirely on the
Postgres sweep rather than being a fast path, which still works but is slower to notice/recover than
necessary. Flagging as a required deployment detail, not optional tuning.

---

## 13. Testing strategy (to be implemented alongside Phase 5 code, not now)

Mirroring Phase 4's approach — deterministic, no live Telegram, no live Redis-dependent flakiness
where avoidable:

- **Pure unit tests**: message template rendering per `NotificationClass` (given a fixture `Alert`,
  assert the rendered text/chat routing) — no I/O, same style as the rule evaluators.
- **`TelegramBotClient` tests**: against a fake HTTP layer (an injected `fetch`/axios mock), covering
  the 2xx/4xx/5xx/429 classification in §5 without a real bot token.
- **Processor tests**: against a real (test-only, docker-composed) Redis + BullMQ queue, same
  pattern as the Postgres test DB (`docker-compose.test.yml` gains a `redis-test` service) — covering
  retry counts, backoff timing (with BullMQ's test-friendly clock control), `DEAD` transition on
  `UnrecoverableError`, and the reconciliation sweep actually re-enqueuing a `PENDING` row with no
  live job.
- **Idempotency tests**: two concurrent enqueue attempts for the same `AlertDelivery` never produce
  two Telegram sends (mirrors the Phase 4 concurrency regression test, §6 above).
- **Integration test** (the Phase 5 equivalent of Phase 4's DoD item 12): a real `Alert` created via
  `RuleEngineService.evaluateAccount` against fixture data → `AlertDelivery` created → processor runs
  against a mocked Telegram client → `status = SENT`, `telegramMessageIds` populated. No live Telegram
  bot required for this — a live-bot manual test (posting to a real test Telegram chat) is the
  appropriate *manual* verification step, parallel to how Phase 4 was manually verified against real
  MT5.

---

## AI boundary — unchanged, and Phase 5 doesn't touch it

Phase 5 ships **no** AI code. The message Phase 5 sends to Telegram is built entirely from
`Alert.triggerValues`/`baselineSnapshot`/`ruleSnapshot` — the same deterministic data Phase 4 already
froze — rendered through a fixed template per rule type, not a generated narrative. The architecture
this leaves room for, unchanged from Phase 0 §10 and your instructions:

```
Rule Engine → Alert → AI contextual explanation → Telegram
```

is still `AlertDelivery`'s eventual home for an *optional* AI-narrated variant of the same message
(Phase 6), not something Phase 5 needs to stub out now. AI will never be consulted for whether a rule
triggered (Phase 4, unchanged), whether an alert should be sent (Phase 4's cooldown/dedup decides
that, unchanged), or any trading action (never built, by design, in this entire system).

---

## Open decisions for you before implementation

1. Does Phase 5 include the minimal 2-metric `GET /health` stub from §11, or is all health monitoring
   fully deferred?
2. `AlertDelivery.telegramMessageIds` as a JSON array assumes potentially multiple
   `TELEGRAM_TRADING_CHAT_IDS` recipients per alert, each getting its own Telegram message id — confirm
   that's the intended fan-out (one alert → N chats → N sends, tracked together) rather than a single
   configured chat.
3. `DEAD` deliveries: Phase 5 as designed leaves them queryable but doesn't build an operator-facing
   "resend" action (no dashboard yet). Acceptable for Phase 5, or do you want a minimal
   `POST /alert-deliveries/:id/retry` endpoint even before the dashboard exists?
