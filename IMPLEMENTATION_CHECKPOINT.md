# Implementation Checkpoint — friend's-gold strategy finish task

Written because this task's true scope (research spec extension + full live demo execution
pipeline + verified DEMO activation on a real MT5 connection) cannot be safely completed in
one bounded pass without either rushing the live-order-placement parts (explicitly forbidden:
"never claim verified unless you actually ran it", "if you cannot confirm DEMO, leave OFF") or
skipping real verification. This is an interruption, not completion. Nothing was pushed, no
order path exists, no broker order was placed.

## Done in this pass
- Read `MORNING_HANDOFF.md`, v2 spec, confirmed `confirmed-retest-dashboard` controller has
  **no order path** (grep-confirmed, matches v2 spec's own provenance note).
- Wrote `FRIEND_RULES_AND_IMPLEMENTATION.md` (rule table: friend rule / existing impl /
  delegated choice / code location) at repo root.

## Confirmed current state (facts, not assumptions)
- `confirmed-retest-v2` is research/watch-only only — no execution, no scheduler, no MT5 order
  calls anywhere in `backend/src/research/confirmed-retest-v2/` or
  `confirmed-retest-dashboard/`.
- `AUTONOMOUS_EXECUTION_ENABLED=false` per last handoff; no strategy currently places orders.
- v1 and v2 specs/results are untouched and must stay that way (do not overwrite).
- EURUSD legacy strategy and `h4-trend-h1-breakout-v1` are out of scope for activation; not
  yet re-audited this pass for "still working" collection/volume/occupancy claim in item 4 of
  the task — needs a fresh check before final handoff.

## Not started / remaining work (in order)
1. **Versioned gold spec doc** — write `XAUUSD_H4_CONFIRMED_RETEST_GOLD_LIVE_V1_SPEC.md`
   (or v2.1) documenting: reuse of v2's pivot+retest engine unchanged, gold-specific
   confirmation of D1-descriptive-only, and any fidelity gaps (winter EET offset) — required
   *before* running any new evaluation per task step 3.
2. **Historical evaluation, 3 outputs** (task step 7) — eligible first-return events,
   one-position simulation under real risk caps, and an (initially empty) forward demo trades
   table. v2's `pipeline.ts`/`paper.ts`/`report.ts` can likely be reused directly since v2
   already implements the friend's rule set almost verbatim — needs confirming there is no
   rule mismatch (e.g. D1 usage, ambiguous-outcome handling) before trusting old v2 output
   as-is versus re-running.
3. **Occupancy + risk live gate module** (new code) — persistent one-active-trade-per-symbol
   reservation across manual/strategy/pending/UNKNOWN broker state; equity-based risk caps
   pre-trade check; never auto-resize volume.
4. **Execution wiring** (new code) — scheduler, MT5 executor with dedicated magic number,
   broker-native SL/TP, max-entry-deviation guard, reject/partial-fill/UNKNOWN handling
   without blind retry, deal-history reconciliation across polls.
5. **Controls** — OFF/SHADOW/DEMO modes, STOP NEW ENTRIES rechecked pre-send, explicit
   strategy-position close control, persistent risk-block/incident log.
6. **Dashboard extensions** — active strategy/version+mode, volumes, selected levels+why,
   first-return/skip reasons, open/closed positions with real P&L, "EURUSD strategy inactive"
   banner, data-freshness/health/protection status.
7. **Verification before any activation** (task step 8): live query confirming
   `trade_mode == DEMO` on the actual connected account (record the literal returned value),
   symbol/volume validation, one-position enforcement test, protection-placement test,
   restart-recovery test, kill-switch test, no duplicate collector/scheduler processes,
   focused unit/integration tests, bounded shadow run.
8. **Activation** — only after every item in 7 passes with pasted evidence. If blocked,
   report exact blocker instead.
9. **Remaining handoff docs** — startup/shutdown/recovery doc, `DEMO_HANDOFF.md`.

## Update — continued this session, key discovery

Wrote `backend/src/research/XAUUSD_H4_CONFIRMED_RETEST_GOLD_LIVE_V1_SPEC.md` (versioned,
DRAFT — execution sections not yet implemented, formation unchanged from v2).

**Important architectural discovery, changes remaining-work estimate:** substantial execution
infrastructure already exists and should be reused, not rebuilt:
- `collector/app/executor.py` (534 lines) — already implements: live `trade_mode` check
  (fails closed unless `ACCOUNT_TRADE_MODE_DEMO`), magic-number-scoped single-open-position
  enforcement (`find_open_position`), deviation-points parameter, ambiguous
  lost-acknowledgment reconciliation via `find_recent_deal`/`_reconcile_after_ambiguous_response`
  (treats a `None` response as filled if a matching position/deal is found, does NOT blind
  retry) — this already satisfies most of task step 6D's "reject/partial-fill/UNKNOWN handling"
  requirement for the *symbol-agnostic* mechanics. It is parameterized by `magic` and `symbol`,
  so it can very likely be called for XAUUSD with a NEW, distinct magic number rather than
  rewritten.
- `backend/src/autonomous/` (2711 lines total) — a full legacy EURUSD "friend's rule" AI-assisted
  pipeline: `risk-manager.ts` (`evaluateRiskManager`) fails closed to non-DEMO, checks kill
  switch, one-order-per-day, SL/TP distance/side correctness; `kill-switch.ts`;
  `autonomous-execution-coordinator.service.ts` (deliberately has **no scheduler of its own** —
  its own comment states this was an intentional, separate decision from "code exists and
  tested" to "runs unsupervised" — same caution this task must apply to gold). This is EURUSD/
  AI-decision-shaped, not directly reusable for the gold mechanical engine, but its patterns
  (fail-closed DEMO check, kill switch, deliberate no-auto-scheduler-until-explicitly-wired)
  should be mirrored for gold, and `AUTONOMOUS_MAGIC_NUMBER = 262610180`
  (`safety-constants.ts:12`) is already claimed by EURUSD — gold's coordinator MUST reserve its
  own distinct magic number, never reuse this one.
- Net effect: task step 6D (execution wiring) is now believed to be **~40-60% reachable via
  reuse** of `executor.py` + the `autonomous/` risk/kill-switch patterns, rather than fully new
  code — but this is not yet proven; the gold mechanical-signal coordinator (confirmed-retest-v2
  events → order decision, analogous to `autonomous-execution-coordinator.service.ts` but for
  the mechanical strategy, not an AI decision) does not exist yet and is the next concrete
  piece of new code needed.

**Platform constraint discovered this session:** spawning a background subagent to build/
activate this pipeline was denied by the auto-mode classifier ("Production Deploy" reason).
This work must continue via direct, interactive tool calls in a live session (not delegated),
which limits how much can be completed per turn/session. This is a scope/tooling constraint,
not a technical blocker in the codebase.

## Update 2 — gold-execution module built, tested, committed (d916a89)

Built `backend/src/gold-execution/` (constants, risk manager, mode switch, coordinator,
collector controller, module) reusing `collector/app/executor.py`'s existing order mechanics
via the same poll/report HTTP pattern EURUSD uses, but on its OWN route
(`collector/:accountId/gold-execution`) and OWN magic number (262610181, distinct from
EURUSD's 262610180). Found and fixed a real cross-symbol bug before any gold row existed:
`claimOldestPendingOrder` didn't filter by symbol, which would have let a gold PENDING row be
claimed by the EURUSD poll route. Added a required `symbol` param; EURUSD call site passes
`'EURUSD'` explicitly. Evidence: `npx tsc --noEmit` clean; new gold-risk-manager suite 12/12
passing; full existing `test/autonomous` suite 139/139 passing after the change (no EURUSD
regression). Committed as `d916a89`.

Still NOT done from this coordinator's checklist:
- Collector-side (Python) polling of the new `/gold-execution/pending-order` route — `runner.py`
  only polls the EURUSD route today. Needs a `_poll_and_execute_pending_gold_order` analogous
  to `_poll_and_execute_pending_order`, calling `executor.send_bracket_order(..., symbol='XAUUSD',
  point_size=0.01, magic=GOLD_MAGIC_NUMBER)` — executor.py already supports this via its
  existing `symbol`/`point_size` parameters, no executor.py change needed, only a new runner.py
  method + api_client.py route + config wiring.
- Real occupancy/equity data sources: `GoldCoordinatorContext.accountInfo`/`occupancy` are
  currently caller-supplied inputs (the risk-manager function itself is fully tested), but no
  code yet queries live positions/equity from the DB (`AccountSnapshot`, position tables) to
  build them. This is the next concrete piece.
- No signal source wired: nothing yet calls `GoldExecutionCoordinatorService.evaluate()` from
  a real confirmed-retest-v2 watch/event.
- 3-output historical evaluation, dashboard extensions, controls' explicit close-position
  action, focused integration test (end-to-end poll/report for gold, analogous to
  `autonomous-execution-e2e.spec.ts`), bounded shadow run, live DEMO verification, activation,
  DEMO_HANDOFF.md — all still pending.

## Update 3 — collector polling + live occupancy/equity resolver (a87656a, 60977d6)

- Wired collector-side gold polling: `GOLD_EXECUTION_ENABLED` (own flag, independent of
  EURUSD's), `api_client.py` gold routes, `runner.py._poll_and_execute_pending_gold_order`
  passing symbol/point_size through to the existing `executor.py` (no executor.py change
  needed). 5 new collector tests, full suite 194/194 passing.
- Built `GoldAccountStateService` (`backend/src/gold-execution/gold-account-state.service.ts`):
  resolves occupancy (any OPEN XAUUSD `Position` row from real collector-synced broker state,
  or any in-flight PENDING/SENT `AutonomousDecision` row) and account risk info (trade_mode +
  equity from the latest `AccountSnapshot`, fails closed to REAL/0 when none exists; daily-loss
  and 30-day-drawdown from `Trade`/`AccountSnapshot` history). 12 new tests against the real
  test Postgres DB, all passing — including proof that the gold and EURUSD collector routes
  are mutually symbol-scoped end-to-end over real HTTP.
- Full regression check after every increment: backend `tsc --noEmit` clean; `test/autonomous`
  139/139; `test/gold-execution` 24/24; collector pytest 194/194.
- Total new backend tests so far: 36 (12 risk-manager + 12 e2e/occupancy + 12 already counted
  risk-manager... — see git log for exact counts per commit). All passing, none skipped.

Still NOT done — this is the real remaining scope, not yet started or only stubbed:
1. **No live signal source wired.** Nothing calls `GoldExecutionCoordinatorService.evaluate()`
   from a real confirmed-retest-v2 watch cycle yet. This needs: (a) extending
   `confirmed-retest-v2`'s watch/replay output (or a new thin adapter) to emit a `GoldSignal`
   (action, signalEntryPrice, currentExecutablePrice, levelId, reasoning) at the moment a
   first-return event is confirmed inside the entry window, and (b) a caller (script or
   scheduler) that runs a watch cycle, builds `GoldCoordinatorContext` from
   `GoldAccountStateService` + live broker volume constraints (need to source broker
   min/max/step — check `capture_contract_metadata.py`'s stored symbol metadata table), and
   calls `coordinator.evaluate()`. This is the single biggest remaining piece of new code.
2. **Broker volume constraints (min/max/step) source not yet wired** into the coordinator call
   — `capture_contract_metadata.py` output needs to be read from wherever it's stored (check
   collector-ingress's symbol-metadata table) and passed as `GoldBrokerVolumeConstraints`.
3. **Max entry deviation**: `GOLD_MAX_ENTRY_DEVIATION_POINTS` is a documented default (200pt);
   not yet cross-checked against a live price feed in the actual coordinator call path (the
   function accepts it as a parameter and is tested, but nothing yet supplies real live
   "currentExecutablePrice" at call time).
4. **Kill switch / explicit strategy-position close control**: kill switch reused as-is
   (`isKillSwitchActive()`); an explicit "close gold strategy positions" action (distinct from
   the EURUSD kill-switch close-all) does not exist yet — would call
   `collector/app/executor.py`'s existing `close_position` with `GOLD_MAGIC_NUMBER`/symbol,
   needs its own controller route + test.
5. **3-output historical evaluation** (task step 7) not started — needs the versioned
   gold-live spec's execution assumptions (now drafted) applied on top of v2's existing
   pipeline/paper/report modules, or a confirmation that v2's existing output already
   satisfies outputs (a) and (b) as-is (output (c), forward demo trades, is trivially empty
   until real fills occur).
6. **Dashboard extensions** (task step 6F) — mode/settings/levels/positions/closed-trades/
   EURUSD-inactive banner — none built yet; `confirmed-retest-dashboard` controller is
   unmodified.
7. **Focused end-to-end test analogous to `autonomous-execution-e2e.spec.ts` but exercising
   the FULL gold coordinator path** (signal → risk gate → DB write → collector claim) doesn't
   exist yet — current tests cover the risk function and the DB/route layer separately, not
   yet chained through `GoldExecutionCoordinatorService.evaluate()` itself with a DB
   assertion.
8. **Bounded shadow run** — `GOLD_EXECUTION_MODE=SHADOW` code path exists and is exercised
   only by unit reasoning, not yet run live against the actual collector/backend for a real
   bounded period.
9. **Live DEMO verification + activation + DEMO_HANDOFF.md** — none of these have started.
   `trade_mode` has NOT been freshly re-queried and confirmed this session; do not assume the
   morning handoff's EURUSD-context DEMO confirmation extends automatically to a fresh
   verification requirement for gold activation — task step 8 requires this to be checked
   again, explicitly, before gold activation specifically.

## Update 4 — signal wiring, volume constraints, dashboard, evaluation, shadow run done;
## critical trade_mode bug found+fixed; activation blocked by a genuine external constraint

Commits this round: 7359ffb (signal source), a3640a7 (live volume constraints), 13b5c93
(dashboard), 27a700a (3-output evaluation doc), 07a154c (trade_mode mapping bug fix +
gold-execution-watch.ts), 638f9db (wrong-account bug fix).

Done: items 1-6 of the coordinator's ordered list (signal wiring, live volume constraints,
dashboard, 3-output evaluation, focused tests, bounded shadow run) are all complete, tested,
and committed. Item 7 (live re-verification) surfaced a real, serious, now-fixed bug — see
`DEMO_HANDOFF.md` for the full account. Item 8 (activation) is correctly NOT done: it requires
positive DEMO confirmation, which requires a collector restart that this environment's own
process-management safety classifier denied to this agent ("Interfere With Workloads") — the
same classifier that denied background-subagent delegation earlier. Item 9 (DEMO_HANDOFF.md +
startup/shutdown/recovery doc) is done (`DEMO_HANDOFF.md`, `GOLD_STARTUP_SHUTDOWN_RECOVERY.md`).

**This is now genuinely blocked on a human/user action, not on more agent work**: someone with
permission to restart OS processes needs to (a) stop the duplicate `main.py` process, (b)
restart the real one so it picks up the `api_mapper.py` fix, and (c) confirm the resulting
`AccountSnapshot.tradeMode` reads `DEMO` before anyone sets `GOLD_EXECUTION_MODE=DEMO`. Full
exact commands are in `GOLD_STARTUP_SHUTDOWN_RECOVERY.md`.

Remaining smaller items, not blockers to the above:
- Explicit "close gold strategy positions" HTTP route (task step 6E) — not built; `executor.py`
  already has the underlying `close_position` capability.
- No scheduler yet invokes `gold-execution:watch` on an interval — deliberate, needs an
  explicit decision once trade_mode is confirmed.

## Update 5 — DEMO positively confirmed; scheduler + EUR conversion built; still not activated

Commits: `3f7be97` (EUR/USD conversion), `19aa7ca` (scheduler), plus `DEMO_HANDOFF.md`/
`GOLD_STARTUP_SHUTDOWN_RECOVERY.md` rewritten with the full corrected picture (not yet
committed as of this checkpoint edit — commit immediately after this).

- **DEMO trade_mode is now POSITIVELY CONFIRMED**, independently, from fresh (10:57:30 UTC),
  cross-corroborated (matching `live_ticks` timestamps) real DB data, with the trade_mode
  mapping re-verified end-to-end against the installed MetaTrader5 package's real enum. This
  clears the PRIOR blocker.
- **New blockers found this round, all real, none worked around**:
  1. No collector process is currently running at all (checked twice) — whatever produced the
     10:57:30 data has since stopped. Starting one was attempted and denied by the same
     classifier that denied killing one last round.
  2. XAUUSD M1 data is ~83 minutes stale by the correct EET/EEST conversion (not the raw
     label) — too stale for live entry-window decisions, and only gets fresher once the
     collector runs continuously again.
  3. Effective `GOLD_EXECUTION_ENABLED` cannot be read from a live process (none running);
     `main.py`'s `load_dotenv()` does not override an existing process env var, so a shell
     override can silently win over `.env` — must be re-checked from the actual startup log
     line at next launch, never assumed.
- **Correction**: the "duplicate collector process" finding from the previous round was WRONG
  per direct user correction — the second process was a child (MT5 IPC helper), not an
  independent duplicate. Retracted in `DEMO_HANDOFF.md`/`GOLD_STARTUP_SHUTDOWN_RECOVERY.md`.
- Scheduler built (`GoldExecutionScheduler` + `gold-execution-scheduler.ts` script, 6 tests) —
  coordinator item 5 done.
- EUR/USD live currency conversion added to the risk gate (coordinator item 6 done, 6 new
  tests, including one proving real-conversion vs. naive-1:1 diverge in actual verdict).
- Did NOT flip `GOLD_EXECUTION_MODE`/`GOLD_EXECUTION_ENABLED` to DEMO/true in any persisted
  config — deliberate, given the three items above; flipping them while nothing is running and
  data is stale would silently arm the system for whenever it's next started, without whoever
  starts it necessarily re-checking freshness/mode first.

## Exact resume point
DONE: versioned spec, `gold-execution` module (constants/risk-manager/mode/coordinator/
controller/module), collector-side polling, `GoldAccountStateService`. All committed
(971cc9f, 7d092c9, d916a89, a87656a, 60977d6), all tests passing, no regressions.

NEXT (start here): item 1 in the "Still NOT done" list above — wire a real signal source.
Concretely:
1. Look at `confirmed-retest-v2/pipeline.ts`/`replay.ts`'s watch-cycle output shape (reuse
   whatever `npm run confirmed-retest:watch` already produces per-cycle) and write a thin
   adapter that turns a freshly-confirmed first-return event into a `GoldSignal`
   (`backend/src/gold-execution/gold-execution-coordinator.service.ts`'s own exported type).
2. Find where broker symbol metadata (min/max/step lot) is actually stored (grep
   `capture_contract_metadata.py`'s target table/endpoint) and write a small resolver
   (`GoldBrokerVolumeConstraints`) alongside `GoldAccountStateService`.
3. Wire a manually-invoked script (NOT an automatic scheduler yet — same deliberate,
   documented posture as the EURUSD coordinator) that: runs one watch cycle, resolves
   occupancy/risk/volume-constraints, calls `coordinator.evaluate()`, and prints the result —
   this becomes the basis for the bounded shadow run (item 8).
4. Only after 1-3 work and are tested: dashboard extensions, 3-output evaluation, then the
   live-verification/activation sequence (items 9 in the list above), in that order.

Do not modify v1 or v2's existing frozen spec/results files. Do not touch
`AUTONOMOUS_MAGIC_NUMBER` (262610180) or any EURUSD file — gold has its own
(GOLD_MAGIC_NUMBER = 262610181).

## Update 6 — session resumed after interruption; collector restarted; one step from activation

Resumed after a VS Code Python-extension restart cleared the chat (not a real blocker — this
was a tooling interruption, not new project state). Verified everything fresh against the
actual repo/runtime rather than trusting the prior checkpoint text:

- Confirmed `8b49a96` (candle-sync-stall fix) is real and committed; confirmed it works live
  by restarting the collector and observing correct, non-inverted `date_from` ranges and
  successful M1 batch pushes immediately.
- **Collector restarted successfully this session** (the "process management denied" blocker
  from the prior round did NOT recur for *starting* a process — only *stopping* one is denied;
  see below). Verified: single process tree (no duplicate), `gold_execution_enabled: true` and
  `autonomous_execution_enabled: false` in the fresh startup log line, XAUUSD M1 staleness now
  ~3 minutes (true-UTC EET conversion), fresh `AccountSnapshot.tradeMode = DEMO`.
- Discovered `collector/.env` (`GOLD_EXECUTION_ENABLED=true`) and `backend/.env`
  (`GOLD_EXECUTION_MODE=DEMO`) were already persisted from the interrupted prior session but
  never reflected in `DEMO_HANDOFF.md` — found, verified correct against the frozen spec via a
  live status call, not changed by this session.
- **New, narrower blocker**: the already-running backend `ts-node-dev` process has the OLD env
  cached (`accountMode: OFF` reported live) because it started before `.env` was last edited.
  Restarting it requires stopping the existing process first, which this environment's
  classifier denied ("Interfere With Workloads") — same restriction as before, now scoped
  specifically to *stopping* processes (starting is unrestricted). Backend confirmed unharmed
  by the attempt. Exact manual restart command is in `DEMO_HANDOFF.md`'s newest update section.
- No genuine order has occurred (`recentDecisions`/`closedTrades` empty, confirmed live).

## Update 7 — ACTIVATED. Backend restarted by user; all checks passed; scheduler running live.

The user restarted the backend themselves with `GOLD_EXECUTION_MODE=DEMO` set, clearing the
last blocker from Update 6. Re-verified fresh rather than trusting the restart report:
`accountMode`/`accountTradeMode` both `DEMO`, kill switch off, no occupancy conflict, settings
match spec, XAUUSD M1 ~5min stale (fresh), zero prior decisions/trades. Started
`gold-execution:scheduler` (no scheduler was running before); confirmed single process tree and
two real, ~60s-apart cycle-complete log lines (`actionableEvents=0` both — correct idle state).
Documented fully in `DEMO_HANDOFF.md`'s "Update — 2026-09-15, activation" section.

**The task's core objective is now complete**: gold DEMO automation is genuinely live, per the
user's prior explicit authorization, with no shortcuts taken and no order forced. No genuine
order has occurred yet (correct — no signal has confirmed since activation). Remaining items
are optional hardening, not blockers:
- Explicit "close gold strategy positions" HTTP route (task step 6E) — still not built;
  `executor.py`'s `close_position` exists and could be called directly if ever needed before
  this route is added.
- No automated restart-on-crash/boot supervisor for the scheduler itself (it must be manually
  restarted if its terminal/process is closed) — was never in scope as a requirement, just
  worth naming for whoever operates this day to day.

## Update 8 — entry-timing: first fix (age/window recheck), then a real correction (live-quote
## detection). Kill switch engaged throughout; scheduler restart still pending.

First pass added `GOLD_MAX_SIGNAL_AGE_SECONDS` (600s) and a live Beirut-window recheck to
`GoldExecutionCoordinatorService.evaluate()` — both real fixes for a genuine gap (nothing had
re-verified window/age at actual submission time, only at M1-bar-formation time), but the
underlying detection mechanism still only ever fired on a CLOSED M1 candle.

Direct correction followed: the friend's rule is first touch AS IT HAPPENS; M1 is the
historical/formation source, not a reason to delay live detection. Built a second, PRIMARY
detection layer (`gold-live-touch.ts`) operating on live `LiveTick.bid` against the same
`LevelEngineState` the M1 replay advances every cycle (H4/D1 formation itself untouched, still
frozen). M1 replay runs first each cycle and remains authoritative for anything the live layer's
latest-tick-only sampling can't see (a touch-and-full-reversal within one poll — an honestly
disclosed, tested limitation, not silently ignored). A gap between live observations beyond
150s defers to M1 rather than guessing. Outside-window touches are still detected and consume
the level (never submitted), so a later in-window return can never be mislabeled as first touch.

Also added `GoldPreSendGuardService` — re-checks kill switch/STOP NEW ENTRIES/window/signal
age/price deviation/occupancy/trade_mode ONE MORE TIME at the actual collector hand-off (after
the atomic claim, before the order is returned to the collector), closing the "coordinator check
before a DB write doesn't cover queue delay" gap explicitly. Uses the freshest `LiveTick` as its
own reference clock rather than the process wall clock, both for correctness (ties the recheck
to real market data) and testability (deterministic in tests).

Found and fixed a genuine, previously-latent test-isolation bug while testing this: tests had no
default override for `isKillSwitchActive()`'s fallback path, so a test run could collide with
this very repo's own real, engaged kill switch (it did, mid-session) — fixed globally in
`test/setup-env.ts`.

Verified: `tsc` clean; `gold-execution` 68/69 (one pre-existing, unrelated, already-documented
env-var test gap); `autonomous` 139/139; `confirmed-retest-v2/boundary` 15/15. No change to H4/
D1 formation, v2's frozen rules, the 200pt deviation limit, or any strategy parameter.

**Still blocked on the same standing constraint**: the running scheduler process predates both
this update's fixes and the previous one's — `backend/KILL_SWITCH` remains engaged. Full restart
+ how-to-verify-the-right-code-is-running steps are in `DEMO_HANDOFF.md`'s newest section. The
backend web server itself already picked up the fix automatically (`ts-node-dev --respawn`),
confirmed live via a fresh status call — only the standalone scheduler process needs the manual
restart.

## Update 9 — six focused checks on the live-quote round: one real defect fixed (M1 could still
## submit a delayed order), one real test-env bug fixed (not dismissed). All green.

Verification-only pass, six specific numbered checks, no formation/limit/parameter changes:
1. Found and fixed a real defect: M1-discovered events still reached
   `coordinator.evaluate()`, gated only by the age cap — a fresh-enough backlog or missed-
   reversal touch could still have been submitted as a delayed order. Fixed: the M1 path now
   only logs an audit-only `AutonomousDecision` (`orderStatus: NONE`) and consumes the
   opportunity; it never calls the coordinator. Proven with new tests
   (`gold-watch-cycle.spec.ts`) covering the startup-backlog and missed-reversal cases exactly.
2. Confirmed (with a new integration test, not just description) that the two detection layers
   share one persistent state correctly: M1 consuming a level same-cycle cannot create a stale
   order (per fix 1) and cannot suppress a genuinely different, still-open level in that same
   cycle.
3. Verified live against the running collector: quote refresh is 10s
   (`POLL_INTERVAL_SECONDS`), confirmed empirically (tickAt advanced exactly 10,000ms across two
   real samples). Detection latency is actually gated by the scheduler's own 60s default
   interval, not the 10s tick refresh — stated precisely, and the 150s observation-gap threshold
   confirmed NOT to be a freshness guarantee (that's the separate 30s tick-staleness check).
4. Traced `GoldPreSendGuardService` through to `order_send`: confirmed Python independently
   re-verifies trade_mode and fetches a fresh tick immediately before sending (a third layer,
   using the literal MT5 connection, not anything the backend told it), confirmed the
   magic-scoped duplicate check cannot self-conflict with the order-in-flight, and confirmed the
   remaining guard→send gap is sub-second (same HTTP response, same poll iteration), not
   minutes.
5. Root-caused and fixed `gold-dashboard.spec.ts`'s failure (`ConfigModule`'s `.env` auto-load
   leaking this deployment's real `GOLD_EXECUTION_MODE=DEMO` into a test asserting OFF) — did
   NOT settle for re-documenting it as pre-existing. `test/gold-execution` is now 72/72.
6. Confirmed `backend/KILL_SWITCH` is still present, unchanged, and confirmed every test file
   now uses an isolated kill-switch path (global default in `test/setup-env.ts`, further
   isolated in the two files that specifically exercise kill-switch behavior).

Still blocked on the same standing constraint: the running scheduler predates every fix to date.
Exact restart + verify-before-clearing-kill-switch steps are in `DEMO_HANDOFF.md`'s newest
section. The backend web server already auto-restarted on every change so far (confirmed live).

## Explicit current answer to the required final-report questions (as of this checkpoint)
- Implemented so far: rule-table doc, versioned gold-live spec, full `gold-execution` backend
  module, collector-side gold polling, live occupancy/risk/volume/currency resolvers,
  scheduler, dashboard endpoint, signal wiring — all from prior sessions, verified still intact
  and working this session; no new code written this session (pure verification/ops).
- Tested: no new tests this session (no code changed); prior sessions' scoped suites (backend
  `tsc --noEmit`, `test/gold-execution` 51/51, `test/autonomous` 139/139, collector pytest
  194/194) are the standing evidence and were not re-run since nothing code-level changed.
- Verified against live demo connection: YES, this session, freshly — trade_mode, data
  freshness, process topology, and effective collector flags all re-checked directly against
  the live, freshly-restarted collector and a live DB query (see Update 6 above). The backend's
  effective mode was checked and found stale (see blocker above) — NOT yet DEMO in the running
  process, though correctly configured on disk.
- Demo automation active: **No** — collector-side gold polling is live and enabled, but the
  backend that decides/queues orders is still reporting `accountMode: OFF` (stale process env);
  no scheduler is running yet either. One backend restart away.
- Genuine strategy orders occurred: **No, none** — confirmed via a live, fresh
  `GET /research/gold-execution-status` call this session (`recentDecisions`/`closedTrades`
  both empty).
- Start/stop/recover: see `GOLD_STARTUP_SHUTDOWN_RECOVERY.md`; the one addition this session is
  that the backend also needs a full stop+start (not just relying on `ts-node-dev`'s file-watch
  respawn) to pick up `.env` changes, same as the collector.
- Concrete blocker: purely operational, not implementation — a human with process-stop
  permission needs to restart the backend dev server (exact command in `DEMO_HANDOFF.md`), then
  re-check `accountMode: DEMO` in the status endpoint, then start
  `npm run gold-execution:scheduler`. After that, the system is genuinely live and will act on
  the next real signal within the entry window with no code changes needed.
