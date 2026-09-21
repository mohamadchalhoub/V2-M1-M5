# System health monitoring — Phase 7
> See `../../../PROJECT_STATUS.md` at the repo root for the authoritative build order, phase-numbering crosswalk, and current status of every component.

Status: **Implemented and tested**, built autonomously while you were away — please review, especially
§4's judgment calls (nothing here decides anything about trading, so the risk profile is much lower
than Phases 4–6, but the component-detection heuristics are my own interpretation of Phase 0 §13).

## 1. What this is

A second, independent observer (Phase 0 §13, Req. 6): whether the SYSTEM ITSELF is working, as
distinct from whether a trading rule triggered. It never touches `rules`/`alerts`/`analytics` —
a bug in trading-rule logic can never affect whether the system correctly reports its own health,
and vice versa.

## 2. Architecture

```
HealthCheckProcessor (BullMQ worker, its own queue, its own schedule)
  → 7 component checks, each in its own try/catch
  → Redis (health:status:<COMPONENT>)   — written FIRST, fast path
  → Postgres health_status               — written second, durable
  → Postgres health_incidents            — only on a STATUS CHANGE
```

`GET /health` reads Redis first, falling back to Postgres only if Redis itself is unreachable from
the read side too — the same "don't assume the thing you're checking is up" posture the checks
themselves use. `GET /health/incidents?component=X` lists history.

## 3. The seven components, and exactly how each is derived

| Component | Detection |
|---|---|
| `COLLECTOR` | `collector_heartbeats.last_heartbeat_at` freshness across all accounts vs `HEARTBEAT_STALE_THRESHOLD_SECONDS` (default 300s). No accounts yet → `DEGRADED` ("nothing to report" is a different fact from "healthy" or "broken"). Some-but-not-all accounts stale → `DEGRADED`; all stale → `DOWN`. |
| `MT5_TERMINAL` | `collector_heartbeats.mt5_connected`, same table, same freshness gating — but a genuinely separate signal from COLLECTOR: a collector that's up but whose MT5 login dropped is `COLLECTOR: OK`, `MT5_TERMINAL: DOWN`, never conflated. |
| `DATABASE` | `SELECT 1` — a bare round-trip. |
| `REDIS` | `PING`. |
| `TELEGRAM` | Bot API `getMe` — sends no message, costs nothing, pure reachability probe (`TelegramBotClient.checkConnectivity`) — unreachable is `DOWN` immediately, regardless of delivery history. Otherwise, same consecutive-failure pattern as `AI_PROVIDER`, applied to the most recent `AlertDelivery` terminal outcomes (`SENT`/`DEAD` — `PENDING`/`FAILED` are still retrying, not terminal): 2+ consecutive `DEAD` → `DEGRADED`, 5+ → `DOWN`. Added this pass because `getMe` alone can be OK (valid token, reachable API) while every real delivery over the past N attempts still ended `DEAD` after exhausting retries — a silent-failure gap `getMe` alone can't see. |
| `AI_PROVIDER` | `AI_ENABLED=false` → `OK` with `{enabled:false}` ("off" is not a failure). Enabled → consecutive-failure count from the most recent `AiAnalysis` terminal outcomes (Phase 0 §13's own wording: "degraded after N in a row, not on a single blip") — 2+ consecutive `FAILED` → `DEGRADED`, 5+ → `DOWN`, a `READY` anywhere in the recent window resets the streak. No real, paid Anthropic call is ever made just to answer a health check. |
| `XTB_IMPORT` | Stubbed `OK` until the `xtb-import` module (below) gives it something real to check — a batch-import feature has no meaningful "up/down" between imports. |

## 4. Assumptions made without asking (flag these on review)

- **Incident semantics**: one `health_incidents` row per STATUS CHANGE (not per tick), closed the
  moment status changes again (including back to OK). A component with no prior status row is
  treated as having been `OK` — so a check that's unhealthy the very first time it ever runs still
  gets an incident opened, rather than starting from "unknown."
- **No auth on `GET /health`**: deliberate for now — it's operational status only, no trading data,
  and the dashboard (built alongside this, see `DASHBOARD_SPEC.md`) needs it reachable before any
  login flow exists. Revisit once real auth exists.
- **`AI_PROVIDER`/`TELEGRAM` checks reach into those modules** (`ai`'s `AiConfig`, `telegram`'s
  `TelegramBotClient`) rather than being purely self-contained — Phase 0's module table lists
  `health` as depending on nothing, which I've read as "no dependency on the trading-DECISION
  modules," not literally zero imports; both of these are thin, side-effect-free reads.
- ~~Not implemented: the weekly data-integrity check Phase 0 §26 also mentions~~ — **closed in
  Phase 11**: `DATA_INTEGRITY` is now an eighth component, checked weekly by its own
  `DataIntegrityProcessor` on its own queue (`data-integrity-checks.ts`, `data-integrity.processor.ts`).
  See the addendum below.

## 5. Config

```
HEALTH_CHECK_INTERVAL_SECONDS=60   # how often the worker ticks
HEARTBEAT_STALE_THRESHOLD_SECONDS=300   # 5 min — a 10x margin over the 30s snapshot interval (Phase 0 §28)
DATA_INTEGRITY_CHECK_INTERVAL_SECONDS=604800   # 7 days (Phase 11)
```

All optional — the app runs fine with none of them set.

## Addendum (Phase 11) — DATA_INTEGRITY, the eighth component

Closes the gap flagged in §4 above. `HealthComponent` gained a `DATA_INTEGRITY` value (migration
`20260829185944_data_integrity_component`); `checkDataIntegrity()` (`data-integrity-checks.ts`)
runs three raw-SQL queries Phase 0 §26 names verbatim — orphaned trades, negative trade/position
volumes, alerts with an empty `rule_snapshot` — and reports `DOWN` with the per-check counts in
`detail` if any are nonzero.

It runs on its **own** queue and **own** weekly schedule (`DataIntegrityProcessor`,
`DATA_INTEGRITY_QUEUE`), separate from `HealthCheckProcessor`'s 60-second one — the same reasoning
that gave the original seven checks their own queue applies again: a slow weekly audit must never
delay, or be delayed by, the fast tick. Both processors now share one `HealthStatusWriterService`
(extracted from what were `HealthCheckProcessor`'s private methods) for the Redis-then-Postgres
write and incident-open/close-on-change logic, so that logic is defined once for all eight
components rather than duplicated per processor.

One judgment call worth flagging: the "orphaned trades" query (`trades` with no matching
`trading_accounts` row) should be structurally impossible given the FK on `trades.account_id` —
it's included anyway, verbatim per Phase 0's own wording, on the theory that the audit's whole
point is catching drift that bypassed a guarantee, not assuming the guarantee always held.
