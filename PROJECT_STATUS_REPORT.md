# Project Status Report — trading-monitor-autonomous (v2)

**Report date:** 2026-09-12
**Prepared by:** Claude Sonnet 5, direct source/DB/runtime inspection (no prior report content trusted without re-verification)
**Branch inspected:** `audit/strategy-and-data-integrity`
**HEAD commit:** `75177a18462d262b4b2717de968658432c6d9a47` — "Implement new h4-trend-h1-breakout-v1 strategy, archive weekly-h4-sr-v1" (2026-09-12 14:09 +0300)
**Working tree:** clean, no uncommitted changes
**Relative to `master`:** this branch is **129 files / +12,646 / −177 lines ahead of `master` and not merged**. Every trend-breakout file, its tests, the new collector executor, and the new frontend pages exist **only on this branch**. `master` (and, as far as this sandbox can determine, any deployed VPS pulling from `origin/master`) does not have any of this work.

> **Evidence-quality key used throughout this report:**
> **RUNTIME** = implemented and actually connected to something that runs today · **DISCONNECTED** = implemented, correct-looking, but nothing calls it in production · **UNIT/INTEGRATION-TESTED ONLY** = passes tests against mocks/synthetic data or a disposable test DB, never run against real conditions · **LIVE-VERIFIED** = observed running against real infrastructure (a real MT5 terminal, a real DB, a real broker) · **MISSING** = not built · **UNKNOWN** = this sandbox has no access to determine the answer (e.g., no SSH to the VPS).

---

## 1. Executive assessment

**What the application can do today (code-level capability):** Two independent strategy engines exist in this codebase. The **legacy `weekly-h4-sr-v1`** system (`backend/src/autonomous/`) is an AI-assisted rule engine with a genuinely wired, end-to-end decision→collector→MT5 order-placement path, including a real database-level atomic claim step and unconditional demo-account enforcement inside the order-sending code itself. The **new `h4-trend-h1-breakout-v1`** system (`backend/src/trend-breakout/`) is a deterministic (no AI), extensively unit/integration-tested signal engine, risk-gate stack, and slot-locking scheme — but it has **zero execution wiring of any kind**: no scheduler ever evaluates it, no collector code ever polls for or sends its orders, and its own spec file says so explicitly.

**What it is actually doing right now:** Nothing. No backend process, no Python collector process, and no MT5-connected process are currently running (confirmed via `tasklist`/`docker ps` — only two unrelated VS Code language-server Python processes are alive). The most recent runtime log entry (`collector/.run-collector.log`, `backend/.run-backend.log`) is from **2026-09-10, ~16:35**, roughly 46 hours before this report, and — critically — that log run was against a database account row (`82cd5b46-…`) that **no longer exists** in the current database. The account currently configured in `.env` (`753b3a50-…`, MT5 login `5055783885`) was created in the database at **19:42 the same day**, after that log stopped, and has **zero observed runtime evidence** — zero `AccountSnapshot` rows exist for it or for any account. Market data is ~3 days stale for the same reason.

**Can any path submit broker orders right now?** No, for two independent, stacked reasons: (1) `AUTONOMOUS_EXECUTION_ENABLED=false` in `collector/.env`, and (2) even if that flag were flipped, nothing in the running system ever creates a decision for the collector to execute — the only thing that can produce one is a human manually running `npm run evaluate-autonomous-rule` from a terminal. The new trend-breakout strategy has no order-submission code path at all yet (confirmed: its controller exposes zero execution/order endpoints).

**Is execution enabled, disabled, or unverified?** **Disabled**, by an explicit config flag, for the only strategy that has any execution wiring at all. The new strategy is not merely "disabled" — it has nothing to disable yet.

**Is the current account verified as demo?** Partially. The MT5 server name (`MetaQuotes-Demo`) is a strong signal, and the executor code independently re-verifies `trade_mode == DEMO` against the live broker connection before every order (not just trusting config) — this is a real, code-enforced safety property. However, the *currently configured* account (`5055783885`) has never actually been connected to in an observed run in this sandbox; the only real observed connection (Sept 9–10 logs) was to a *different* account (`10012425443`, also `MetaQuotes-Demo`) that predates the isolation fix described in `.env`'s own comments. So: demo-ness is enforced by code whenever a connection happens, but there is no fresh evidence the currently-configured account has been connected to at all.

**Most important remaining blockers**, in order:
1. No live collector session has ever run against the currently-configured, isolated demo account — so `SymbolMetadata` and `AccountSnapshot` are both empty, and every metadata- or equity-dependent risk gate fails closed by construction.
2. Gold (`XAUUSD`) has zero historical candle data — `CANDLE_SYMBOLS` is EURUSD-only — so gold cannot be backtested or (later) traded against real data yet.
3. The new strategy's evaluation function has no scheduler; the legacy strategy's decision-creation function has no scheduler either — both require a human to manually trigger a script. Nothing runs "on its own."
4. The trend-breakout strategy's emergency stop-loss handler, slot-release logic, and the account-wide (manual-position-aware) position check are all either unwired or not built — safe today only because nothing executes yet, but real gaps for whenever execution is added.
5. A material, currently-unresolved discrepancy: documentation claims the XTB historical import went through the batch-tracked API path (which should have left `ImportBatch` rows behind), but the live database's `import_batches` table is empty. The trade data itself is intact and matches previously-reported totals exactly; only the import-provenance metadata is missing, and why is unknown.

**Exact next development milestone:** Run one real, supervised collector session against the currently-configured dedicated demo account (`5055783885`) with `AUTONOMOUS_EXECUTION_ENABLED` left `false`, long enough to populate `AccountSnapshot` and (once the missing wiring is added) `SymbolMetadata` for both EURUSD and gold, and to backfill gold candle history. This is pure data-collection groundwork, requires no execution, and directly unblocks the account-risk-gated backtest and the shadow-operation phase. See §10.

Do not read any single component's status as representative of the whole system — the legacy strategy's execution *plumbing* is more mature than the new strategy's, while the new strategy's *signal logic* has received far deeper, more recent scrutiny (see §3). Neither is "done."

---

## 2. Project identity and architecture

- **Repository / branch:** `trading-monitor-autonomous`, branch `audit/strategy-and-data-integrity`, HEAD `75177a1`, clean working tree.
- **This repo is a fork ("v2")** of an unrelated, separately-deployed "v1" project (a general MT5 trading-behavior monitor, live on a Hostinger VPS at `jokertrade.tech`, per `DEPLOYMENT_SESSION_2026-09-09.md`). **Five of the root-level markdown docs — `PROJECT_STATUS.md`, `PROJECT_SUMMARY_FOR_REVIEW.md`, `DEPLOYMENT_SESSION_2026-09-09.md`, `DEPLOYMENT.md`, `DEPLOYMENT_SINGLE_VPS.md` — were all introduced in the single "Initial v2 fork from v1" commit (`19a9721`, 2026-09-10) and describe v1's own history, deployment, and MT5 accounts (`10012425443` dev / `10012608757` production), not this v2 codebase.** Treat them as inherited reference material, not current status. **`AUTONOMOUS_DEMO_TRADING_PLAN.md` and `backend/src/trend-breakout/TREND_BREAKOUT_SPEC.md` are the only two docs genuinely native to v2's own development.** This is a documentation-hygiene issue worth fixing (e.g., moving the five stale docs into a clearly-labeled `docs/inherited-from-v1/` folder) so a future reviewer doesn't repeat this confusion.
- **Infrastructure isolation from v1:** verified real, not just claimed. v2 uses its own Postgres (port 5443, db `autonomous_trading`, container `autonomous-trading-postgres`) and Redis (port 6380/`autonomous-trading-redis`), distinct from v1's own dev instances (ports 5433/6380 — see `backend/docker-compose.yml` comments), and a dedicated MT5 demo account (`5055783885`) separate from whatever v1's own collector watches. This matches the project's standing requirement (see memory) that a forked project needs fully dedicated infrastructure, and it has been done correctly here.
- **Strategy identifiers** (`backend/src/strategy-versions.ts`):
  - `LEGACY_WEEKLY_H4_SR_STRATEGY_ID = 'weekly-h4-sr-v1'` — **archived**, code/tables/decisions left untouched, no longer under active development, but its execution plumbing is the only one currently wired end-to-end (see §5).
  - `TREND_BREAKOUT_STRATEGY_VERSION = 'h4-trend-h1-breakout-v1'` — **active development**, deterministic, no execution wiring at all yet.
- **Components:**
  - **Backend** — NestJS/TypeScript, Prisma/PostgreSQL, BullMQ/Redis for recurring jobs, Fastify HTTP.
  - **Frontend** — Next.js/React dashboard, account-bound bearer-token auth (`DashboardTokenGuard`).
  - **Collector** — Python, talks to a local MT5 terminal (native or RPyC bridge under Wine), pushes account snapshots/trades/candles to the backend and (only for the legacy strategy, only if enabled) polls for and executes orders.
  - **Database** — single PostgreSQL instance, 29 tables, schema in `backend/prisma/schema.prisma`.
  - **Messaging** — Redis + BullMQ, used for Telegram delivery, health checks, market-event/news ingestion. **Not used for either trading strategy's evaluation or execution** — those are plain CLI scripts or an inline collector poll, not queue jobs.
  - **AI** — used **only** by the legacy strategy (`autonomous-ai-decision.service.ts`, providers: Gemini/OpenRouter/Groq/mock, `backend/src/ai/`) and by unrelated features (AI-narrated Telegram alerts, health-check AI-provider monitoring). **The new trend-breakout strategy makes zero AI calls anywhere** — confirmed by grep across the entire module; every gate is a deterministic arithmetic/comparison function.
  - **Broker** — MetaTrader5, via the Python `MetaTrader5` package or an RPyC bridge (for non-Windows/Wine hosting).

### Data → decision → execution → reconciliation flow (as actually wired today)

```
┌─────────────┐   snapshot/trade/candle push (every 10s/60s/300s)   ┌──────────────────┐
│  MT5        │ ─────────────────────────────────────────────────► │  Backend         │
│  terminal   │        collector/app/runner.py (CollectorApp.run)   │  (collector-      │
│  (Python    │                                                     │   ingress module) │
│  collector) │                                                     └────────┬─────────┘
└──────┬──────┘                                                              │ writes
       │ IF AUTONOMOUS_EXECUTION_ENABLED=true (currently false):             ▼
       │  poll GET pending-order ──────────────────────────────►  AccountSnapshot, Trade,
       │  send_bracket_order() via executor.py ◄──── order payload  HistoricalCandle rows
       │  post_execution_result() ─────────────────────────────►  AutonomousDecision.orderStatus
       │                                                             (atomic PENDING→SENT claim)
       └── NO equivalent poll exists for trend-breakout ──X──►  TrendBreakoutDecision
                                                                  (written only by manual
                                                                   CLI scripts / tests —
                                                                   0 rows in the live DB)

Legacy decision creation:  human runs `npm run evaluate-autonomous-rule` (manual CLI only,
                            no scheduler) → AI call → risk-manager gate → kill-switch check
                            → AutonomousDecision row (PENDING)

Trend-breakout evaluation: `TrendBreakoutCoordinatorService.evaluateAll()` exists and is
                            fully unit/integration-tested, but has ZERO scheduler/queue/CLI
                            caller found anywhere in backend/src — it never runs unless a
                            test or a person calls it directly.

Recurring automation that DOES run on its own (BullMQ upsertJobScheduler, no @Cron/@Interval
anywhere in the codebase): health checks, data-integrity sweep, Telegram delivery/reconciliation,
FRED/Finnhub/Marketaux market-event & news ingestion, central-bank calendar. NONE of these
touch either trading strategy.
```

- **Shadow decisions:** the trend-breakout coordinator logs *every* signal evaluation — including HOLDs — with a full gate-by-gate breakdown to `TrendBreakoutDecision`. This is real, tested code (§3), but since nothing schedules the coordinator, **zero shadow decisions have ever actually been logged** (`trend_breakout_decisions` count = 0 in the live DB, confirmed by direct query).
- **Demo order execution:** only the legacy strategy has any code path capable of it, and it is currently disabled by config (§5).
- **General account monitoring** (snapshots, analytics, rule-engine alerts, health monitoring, Telegram) is the most mature, most-previously-verified part of the system, but per §1 it is not currently running either.

---

## 3. Approved rules versus current implementation

This table reflects a full read of every file in `backend/src/trend-breakout/` (20 files) and its 11 test files, cross-checked against the live database. All "connected" claims were independently confirmed by grepping for callers across `backend/src`, not inferred from comments.

| # | Approved requirement | Current behavior | Source | Effective setting | Runtime connection | Verification | Mismatch / open issue |
|---|---|---|---|---|---|---|---|
| 1 | EURUSD + gold-vs-USD only, explicit validated symbol mapping | Implemented exactly as specified; rejects ambiguous/cross mappings and duplicate-symbol mappings | `instrument-config.ts:41-116` | Default broker symbols `EURUSD`→`EURUSD`, `XAUUSD`→`XAUUSD` (env-overridable, not currently overridden) | Called from coordinator | `instrument-config.spec.ts` (9 tests, passing) | Same-symbol collision check is provably unreachable given current logic (harmless dead branch) |
| 2 | EURUSD 0.12 lot / gold 0.01 lot, **initial** values, user-changeable only | Implemented; constants only ever seed the DB row once | `instrument-config.ts:91-94`, `volume-settings.service.ts:40-51` | 0.12 / 0.01 | Bootstrap-only read | Confirmed via `db-integration.spec.ts` | — |
| 3 | Only the user changes volume; never auto-resized/rounded/split | Implemented — the only mutator is the user-facing `updateVolume()`; every risk gate **skips**, never rewrites, volume | `volume-settings.service.ts:68-101`; `risk-policy.ts:50-56` | — | `POST /accounts/:id/trend-breakout/volume/:instrument`, real, DB-audited (see §9) | Frontend agent confirmed live | — |
| 4 | Volume changes affect future entries only | Structural, not just documented: the update path never touches any trade/position row | `volume-settings.service.ts:57-67` | — | RUNTIME (reachable via UI today) | — | — |
| 5 | Max one active position per instrument; both may be open simultaneously | Implemented via a DB primary key `(accountId, instrument)`, survives restarts/multi-worker by construction | `slot-lock.service.ts:33-53`; `schema.prisma:906` | — | DISCONNECTED end-to-end (see #7) | `db-integration.spec.ts` (real Postgres) | — |
| 6 | Slot occupied by pending/in-flight/UNKNOWN outcomes too | `SlotState = PENDING \| OPEN \| UNKNOWN`; **any** row presence = occupied | `slot-lock.service.ts:18,33-36` | — | Same as above | Unit-tested | — |
| 7 | Manual/other-strategy positions on the instrument also block entries | **Not implemented.** `isOccupied()` only ever queries this module's own lock table | `slot-lock.service.ts:33-36` | — | MISSING | — | **A manually-opened MT5 position would not block a new signal.** Flagged directly by code audit; real gap for whenever execution exists |
| 8 | No averaging down/pyramiding/hedging/reversal | True today, but **only as a side effect** of the slot lock's exclusivity — no independent rule exists | `slot-lock.service.ts` | — | Same as #5 | — | Guarantee is only as strong as the slot-lock's own correctness; no defense-in-depth |
| 9 | No one-trade-per-day cap; same-day re-trade after confirmed closure | `release()` has no date/time check at all — logically correct | `slot-lock.service.ts:66-69` | — | **DISCONNECTED — zero production callers of `release()`/`updateState()` found anywhere.** A slot claimed today would never free itself in the live system | Unit-tested (next-day case only; same-day inferred, not directly tested) | Harmless now (nothing claims slots in production), but a real completeness gap once execution exists |
| 10 | Entries only 03:00:00 inclusive–12:00:00 exclusive, Asia/Beirut, DST-aware | Correctly implemented: `secondsOfDay >= START && < END`, genuine IANA `Intl.DateTimeFormat` with `timeZone:'Asia/Beirut'`, explicit `hourCycle:'h23'` to avoid a midnight-as-"24:00" bug | `schedule.ts:24-25,38-52,75-79` | 03:00–12:00 Beirut | One live call site (see next row) | `schedule.spec.ts` incl. winter/summer DST cases | — |
| 11 | Checked at signal time **and** immediately before submission | **Spec overstates current code**: only ONE live call site exists (`trend-breakout-coordinator.service.ts:114`); there is no submission step yet to check "immediately before" | `schedule.ts` callers | — | Partial | — | `TREND_BREAKOUT_SPEC.md:41-42`'s "checked...AND again" claim is not true of the runtime code today; will become true once execution exists, but should be corrected/caveated now |
| 12 | Existing positions unaffected by the schedule gate | True (no position-management code exists yet to be affected) | — | — | N/A | — | — |
| 13 | No deferred execution of an expired/blocked HOLD | Implemented — every failing gate returns immediately via `logHold`, keyed uniquely per signal candle; re-evaluating returns the same terminal row, never a new attempt | `trend-breakout-coordinator.service.ts:97-117,340-345` | — | RUNTIME (within the unscheduled function) | `db-integration.spec.ts:239-249` | — |
| 14 | H4 trend: EMA50 vs EMA200 **and** close vs EMA200, "all three" same side | Code literally implements only 2 comparisons (close-vs-EMA200, EMA50-vs-EMA200) — never a direct close-vs-EMA50 check | `signal-engine.ts:101,104` | — | RUNTIME (within unscheduled function) | `signal-engine.spec.ts` — but all fixtures are monotonic, so this ambiguity is untested | A close between EMA50 and EMA200 in an unusual order could still pass; needs a decision from whoever owns the spec on whether "2-of-3" was intended |
| 15 | Indicator warm-up / fail-closed | EMA200 needs 1000 H4 candles, ATR14 needs 42 H1 candles before settling; returns `direction:null` + explicit warm-up gate before that | `signal-engine.ts:84-93,116-127`; `indicators.ts:69-72,121-123` | — | RUNTIME | Unit-tested | — |
| 16 | H1 breakout vs preceding 20 candles, excluding S | `slice(sIndex-20, sIndex)` — correctly exclusive | `signal-engine.ts:139` | — | RUNTIME | `signal-engine.spec.ts:109-117` | — |
| 17 | "Fresh breakout": previous candle's **own** preceding-20 window, not S's | Correct — independently computed slice at `prevIndex`, not reused from S's window (the classic off-by-one bug is **not present**) | `signal-engine.ts:163` | — | RUNTIME | `signal-engine.spec.ts:119-141` | — |
| 18 | ATR14 Wilder smoothing (RMA, α=1/14) | Correctly implemented Wilder recurrence, distinct from the EMA's α=2/(n+1) | `indicators.ts:104-119` | — | RUNTIME | `indicators.spec.ts:44-62` | — |
| 19 | ATR frozen through the H1 candle preceding S, never recomputed | Computed once, stored on the result, only ever read downstream | `signal-engine.ts:121-133` | — | RUNTIME | — | — |
| 20 | Signal range ≤ 2×frozen ATR | Implemented | `signal-engine.ts:180-187` | — | RUNTIME | — | — |
| 21 | Buy at ask / sell at bid | Implemented | `entry-timing.ts:24-26` | — | RUNTIME (unscheduled) | — | — |
| 22 | 60-second expiry from signal close | Implemented, strict `>=` | `entry-timing.ts:8,12-14`; coordinator `:107-111` | 60s | RUNTIME (unscheduled) | — | — |
| 23 | Executable price within 0.25×frozen ATR of signal close | Implemented | `entry-timing.ts:41-48`; coordinator `:142-147` | 0.25×A | RUNTIME (unscheduled) | — | — |
| 24 | SL = 1.5×ATR, TP = 3×ATR, rounded to real broker increment | Implemented; uses `SymbolMetadata.point` (currently empty for both instruments, so this gate fails closed today) | `sl-tp.ts:13-18,30-46` | 1.5× / 3× | RUNTIME (unscheduled), **fails closed today for lack of metadata** | `sl-tp.spec.ts` | — |
| 25 | Collapsed/inverted rounding is rejected, never widened | Implemented — explicit rejection, no silent adjustment | `sl-tp.ts:88-95` | — | RUNTIME | `sl-tp.spec.ts:53-57` | — |
| 26 | No trailing/breakeven/partial/time/Friday/noon exits | Confirmed absent — grep across the module found no such logic; only `hitStop`/`hitTarget` ever close a position in the backtest engine | `backtest.ts:154-184` | — | N/A (no live exit code exists yet at all) | `backtest.spec.ts:67-78` (position spans weekends/noons, closes only on SL/TP) | — |
| 27 | Risk caps: 0.5% per-trade, 1% combined, 2% daily loss, 5% drawdown, 10%-of-D max spread, 5s max quote age | All six implemented as literal defaults and called in order | `risk-policy.ts:24-31`; coordinator `:135-228` | 0.5/1/2/5/10/5 | RUNTIME (unscheduled) | `risk-policy.spec.ts` (15 tests) | — |
| 28 | Daily-loss cash-flow adjustment (deposits/withdrawals) | `recordCashFlow()` exists and is unit-tested but has **zero production callers** anywhere in `backend/src` | `risk-state.service.ts:104-110` | `dailyNetCashFlow` permanently 0 in practice | **DISCONNECTED**, disclosed in the spec itself | Unit-tested only | Confirmed exactly as the spec discloses — an honest stub, not a hidden gap |
| 29 | Drawdown block cleared only by explicit reset | Implemented; the reset is the only code path that ever clears `drawdownTriggered` | `risk-state.service.ts:99-102` | — | RUNTIME, reachable via authenticated API | `db-integration.spec.ts:210-222` (persists across restart) | Reset action is logged only (`Logger.warn`), **no DB audit row** — see §9 |
| 30 | Every risk gate fails closed on missing equity/metadata/conversion-rate | Individually traced: quote, metadata, account/equity, snapshot, and conversion-rate each have their own explicit null-check → HOLD | `trend-breakout-coordinator.service.ts:150-199` | — | RUNTIME (unscheduled) | — | — |
| 31 | Missing/unverifiable stop → 1 re-establish attempt → verify → close if unprotected → always block entries → record incident | Correctly implemented as a pure 5-step function | `emergency-handler.ts:71-140` | — | **DISCONNECTED — the only caller in the entire codebase is its own test file.** No position-health monitor, cron, or coordinator hook invokes it | `emergency-handler.spec.ts` (8 tests) | Dead code today (harmless — nothing opens positions yet), but "always blocks entries" is currently theoretical |

**Deviations that matter most, ranked:** (1) the emergency stop-loss handler being fully unwired, (2) the slot lock's blindness to manual/other-strategy MT5 positions, (3) the entry-window gate having one call site instead of the two the spec claims, (4) the H4 trend filter's literal 2-of-3 comparison count. None of these currently produce a wrong trade, because nothing trades yet — but all four should be resolved or explicitly re-scoped before execution is ever turned on.

**Implementation decisions beyond the spec (disclosed, low-risk):** the SL/TP rounding function applies an extra floating-point-noise correction (`sl-tp.ts:30-40`) beyond the literal "round to increment" instruction — reasonable, but worth an explicit sign-off since it's an added safeguard the spec text didn't ask for.

---

## 4. Data and collector readiness

| Item | EURUSD | Gold (XAUUSD) |
|---|---|---|
| Canonical id | `EURUSD` | `XAUUSD` |
| Mapped broker symbol (default, unconfirmed against a live terminal) | `EURUSD` | `XAUUSD` |
| `SymbolMetadata` row exists? | **No — 0 rows** (direct query) | **No — 0 rows** |
| H1/H4/M5/M15/M30/D1/W1/MN1 history | Yes — see below | **Zero rows, every timeframe** |
| Tick data (`live_ticks`) | Only ever populated live, best-effort per snapshot tick; not backfillable historically | none |

**EURUSD historical candle inventory** (direct `historical_candles` query, this session):

| Timeframe | Rows | Range |
|---|---|---|
| M5 | 100,752 | 2025-05-02 → 2026-09-09 |
| M15 | 68,037 | 2023-12-11 → 2026-09-09 |
| H1 | 17,018 | 2023-12-11 → 2026-09-09 |
| M30 | 33,998 | 2023-12-12 → 2026-09-09 |
| H4 | 4,258 | 2023-12-12 → 2026-09-09 |
| D1 | 711 | 2023-12-13 → 2026-09-08 |
| W1 | 256 | 2021-10-10 → 2026-08-30 |
| MN1 | 179 | 2011-10-01 → 2026-08-01 |

This is **zero records found**, definitively — not a DB access problem (the database is reachable and every other query above returned real data). No suspicious gaps were flagged in this session (a full interval-continuity audit was out of scope for this pass and would need a dedicated script).

- **Freshness:** most recent EURUSD H1 candle is 2026-09-09 14:00 UTC — **~3 days stale** as of this report, because no collector process is running (§1), not because of any code defect.
- **Are collector methods actually called by the runner?** `Mt5Client.get_symbol_info()` exists (`mt5_client.py:226`) and is fully implemented, but a full-repo grep found **zero callers** in `runner.py` — it is never invoked on any schedule. The backend already has a receiving endpoint ready (`POST /collector/symbol-metadata`, `collector-ingress.controller.ts:160`), so this is a small, well-scoped "wire it up" task, not a design gap.
- **Account snapshots / equity / margin / free-margin:** `account_snapshots` has **0 rows for every account** in the live database right now. This is not a bug — it is the direct, expected consequence of no collector session ever having completed against the currently-configured account.
- **Deposit/withdrawal ingestion & cash-flow adjustment:** not built for live ingestion; `recordCashFlow()` is a tested but uncalled function (§3, item 28).
- **Broker session / margin-calculation integration:** `AccountSnapshot` carries `balance/equity/margin/freeMargin/marginLevel/profit/tradeMode` but **no leverage field and no per-symbol trading-session state** — full margin-requirement and session/permission checks are not implemented, exactly as `TREND_BREAKOUT_SPEC.md` §9 discloses.
- **Can data collection be completed with execution disabled?** **Yes.** `runner.py`'s snapshot/trade-sync/candle-sync steps run unconditionally every tick; only the execution-poll step is gated by `AUTONOMOUS_EXECUTION_ENABLED` (`runner.py:108-114`). What is actually preventing full data readiness right now is: (1) no collector process is currently started (an operational action, zero code needed), (2) `CANDLE_SYMBOLS=EURUSD` in `collector/.env` excludes gold (a one-line config change, but still requires a live terminal session to backfill history), (3) the symbol-metadata push wiring described above doesn't exist yet (small, real code task), (4) the currently-configured account has simply never been run.

---

## 5. Execution and safety readiness

Full trace of the **only** route with any execution wiring — the legacy `weekly-h4-sr-v1` strategy. The new strategy has no equivalent route to trace (confirmed: `trend-breakout.controller.ts` exposes only `GET settings`, `GET volume-audit/:instrument`, `POST volume/:instrument`, `GET decisions`, `POST drawdown-reset` — no order/execution endpoint of any kind).

| Item | Implemented? | Wired to runtime? | Tested? | Unverified / gap |
|---|---|---|---|---|
| Execution flag | `AUTONOMOUS_EXECUTION_ENABLED` in `collector/.env`, currently **`false`** | Yes — gates `runner.py`'s execution-poll step only, not snapshot/trade/candle sync | — | — |
| Demo-account enforcement | `verify_demo_account()` checks live `account_info().trade_mode == DEMO`, called unconditionally at the top of every order-sending method, independent of the enable flag | RUNTIME (would run on any real order attempt) | `test_executor.py` | Trusts whatever terminal/account is actually connected; cannot detect "right demo account, but not the intended one" beyond trade_mode itself |
| Request claiming / polling | `GET /collector/:accountId/autonomous/pending-order` + `POST .../result` | RUNTIME (only reachable if the flag is on) | Yes | — |
| Atomic claim | `updateMany({ where: { id, orderStatus:'PENDING' } })` — a genuine DB-enforced compare-and-swap, not in-memory | RUNTIME | Yes | A backend crash *after* the claim flips a row to `SENT` but *before* the collector receives it leaves that decision **stuck forever** — no retry/timeout exists |
| Dedicated strategy magic number | `AUTONOMOUS_MAGIC_NUMBER = 262610180` (`safety-constants.ts:12`), hardcoded, forwarded through the decision payload | RUNTIME | — | Trend-breakout's own distinct magic number is documented as a future requirement, not yet chosen/implemented (moot — it has no execution to need one yet) |
| Per-symbol durable slot locking | Legacy strategy: `find_open_position(magic, symbol)`, a **live MT5 query**, not a DB lock | RUNTIME | `test_executor.py` | **Real TOCTOU race under genuine multi-process concurrency** — the executor's own lock is `threading.Lock()`, explicitly scoped to one process only (its own docstring says so) |
| Account-level risk reservation across simultaneous signals | The daily-order-count cap counts the legacy strategy's **own** `AutonomousDecision` rows, not live broker state | RUNTIME | Yes | **Do not read this as account-wide protection** — it is entirely blind to manual trades or any other strategy's positions |
| Pending-order / manual-position checks | `find_any_position()` (magic-agnostic, built for this exact purpose) exists in `executor.py` but **has zero production callers** — only test files call it | DISCONNECTED | `test_executor.py` | — |
| Broker margin/session/permission checks | Not implemented (see §4) | MISSING | — | — |
| Duplicate prevention | Yes, at the executor level (see slot-locking row above) — real, but process-scoped only | RUNTIME | Yes | — |
| UNKNOWN outcomes / query failures | `_result_from_response` only reports FILLED on `TRADE_RETCODE_DONE`; an ambiguous `None` triggers reconciliation via live positions + deal history before ever resolving; a failed/ambiguous result is **never** silently upgraded to "ok" | RUNTIME | `test_executor.py` | — |
| Reconciliation with positions/orders/deal history | `find_recent_deal`, `_reconcile_after_ambiguous_response`, `_verify_protective_stop` — all run **inline, synchronously, at the moment of order placement only** | RUNTIME | Yes | **No standalone, ongoing reconciliation service exists** — nothing periodically re-diffs live broker state against recorded decisions after the fact |
| Process restart / multiple-worker behavior | Backend claim is safe across processes (DB-enforced); **the broker-side duplicate check is not** (see slot-locking row) | Mixed | Partial | Two concurrent collector processes could both pass the "no existing position" check before either has actually placed one |
| Actual-fill SL/TP reconciliation | `_verify_protective_stop` reads back the live position's attached SL | RUNTIME | Yes | Only fires around order placement, not ongoing |
| Protective-stop verification | Same as above — computes `sl_confirmed` | RUNTIME (computed) | Yes | **`sl_confirmed` is computed and then discarded** — never transmitted to the backend (no field in `ExecutionResultDto`), never persisted, only logged as an ERROR line |
| Missing-stop recovery & failed emergency closure | **Does not exist for the legacy strategy.** `close_position()` — the only code that could forcibly close a position — is called nowhere in production, only in tests, despite being described in comments/spec as "the kill switch's future close-everything action" | MISSING (legacy) / **DISCONNECTED** (trend-breakout's own correct implementation, §3 item 31) | — | This is a real gap for the strategy that actually has execution wiring |
| Daily-loss / drawdown persistence & reset | Trend-breakout: real, DB-persisted, restart-safe (§3 item 29). Legacy: has its own separate risk-manager cap, DB-persisted via `AutonomousDecision` counts | RUNTIME (trend-breakout: unscheduled; legacy: only reachable via manual script) | Yes | — |
| Kill-switch semantics | A filesystem flag file, checked **only** at decision-creation time inside `AutonomousExecutionCoordinatorService.run()` | **Not re-checked at claim/execution time** | `kill-switch.spec.ts` | A decision already `PENDING` before the switch is flipped on will still be claimed and executed. The switch also **cannot close existing positions** — it only blocks new decision creation |
| Alerts & durable incident records | Trend-breakout has `TrendBreakoutEmergencyIncident` (real table, unused today since nothing calls the handler); legacy strategy has no equivalent incident table | Mixed | — | — |

**Direct answers to the report's specific cautions:**
- **Do not claim exactly-once broker execution from a local lock alone** — correct concern, and confirmed real: the executor's duplicate-prevention is a live-state check plus an in-process lock, not a broker-side or DB-side lock, so it would not hold under genuine multi-collector-process concurrency.
- **Do not claim account-wide protection if checks only cover one strategy's magic number** — confirmed true here: every check in the legacy path is scoped to `AUTONOMOUS_MAGIC_NUMBER` / its own decision table. There is no account-wide check anywhere in the live system.
- **Can opening orders be disabled while monitoring/protective management stay operational?** **Yes, cleanly** — `AUTONOMOUS_EXECUTION_ENABLED=false` disables only the `_poll_and_execute_pending_order()` step; snapshot, trade-sync, and candle-sync all continue unconditionally (`runner.py:108-114`). There is, however, no "protective management" of open positions to speak of for either strategy today (see missing-stop-recovery row above) — so this is really "monitoring stays operational; there is no active position-management loop to separately preserve."

**Can any code path today submit a real broker order?** Only if a human does two separate manual things: flip `AUTONOMOUS_EXECUTION_ENABLED=true`, **and** run `npm run evaluate-autonomous-rule` to manually produce a `PENDING` decision (nothing else in the codebase can create one — confirmed no scheduler/queue calls `AutonomousExecutionCoordinatorService.run()`). Neither has happened in this session, and the flag is currently `false`.

---

## 6. Historical import status

- **Source:** a real XTB/xStation5 "closed positions" `.xlsx` export (`account_50283640_fr_xlsx_2005-12-31_2026-08-25.xlsx`), for a friend's account, held purely for historical/analytical reference — never live-monitored.
- **Position vs. deal-leg representation, verified directly against the live database:**
  - `trades` table (deal-leg level): **1,730 rows** for this account, split `865 × IN` + `865 × OUT` (perfectly paired — no orphans).
  - Grouping by `position_id`: **865 distinct closed positions**, of which **648 are EURUSD** — this **exactly matches** the previously-reported 865/648 figures. Confirmed by direct query in this session, not taken on faith from prior docs.
  - Net P&L by symbol (direct query): EURUSD +3,366.15, GOLD −1,254.24, EURCHF −571.68, OIL.WTI −32.47, OIL −15.57, NATGAS +1.39, GBPUSD 0.00 (account currency EUR).
- **Repeat-import / overlapping-export behavior:** the real importer (`XtbImportService`, behind `POST /xtb-import`) dedups on the existing unique constraint `(accountId, platform, externalTradeId)` and on a whole-file `fileSha256` short-circuit for an already-`COMPLETED` batch — a naive re-run does **not** duplicate rows.
- **Corrected/late-changed records (e.g., a swap correction in a later export):** **silently NOT applied.** The dedup key does not consider row content, only the trade-id — a later export with a corrected value for an already-imported trade is skipped, keeping the original value. This is explicitly unit-tested and disclosed in the code's own comments as "a real, current limitation, not a hidden bug" (`xtb-import-e2e.spec.ts`), which directly confirms the report's concern about late swap changes: **conflicts are not surfaced, they are silently discarded.**
- **Source parser vs. independent verification:** the CSV-path parser's own comment is honest that it has never been verified against a real export. The xlsx-path parser's comment **claims** verification against a real file and cites "`XTB_IMPORT_SPEC.md` §4's addendum" — **that addendum does not exist** in the current spec file; §4 there still describes the mapping as an unverified guess. This is a real, unresolved discrepancy between a code comment and the document it cites — treat xlsx column-mapping correctness as **unverified** until that addendum is found or written.
- **`reconcile-xtb-workbook.ts` does not write to the database at all** — it is a separate, read-only verification/reconciliation script (its own header says so explicitly) that computes a cash-reconciliation total (`deposits + withdrawals + trading P&L + swap + rollover + interest`) and only prints it — there is no automated comparison against a known ending balance anywhere in code.
- **Unresolved discrepancy (flagged, not explained away):** two prior session documents (`DEPLOYMENT_SESSION_2026-09-09.md`, `AUTONOMOUS_DEMO_TRADING_PLAN.md`) describe this exact data being loaded through the real, `ImportBatch`-backed `POST /xtb-import` endpoint — twice, with matching row counts (866 total / 865 imported / 1 skipped) each time. **The live database's `import_batches` table currently has zero rows.** The trade data is intact and the totals match exactly; only the import-provenance audit trail is missing. This sandbox cannot determine why (no access to whatever process last touched that table) — report this to whoever has operational history/logs from that period as a genuine open question, not a fabricated explanation.

---

## 7. Backtest evidence

### `h4-trend-h1-breakout-v1`, EURUSD, full available history

The only backtest artifact for this strategy is the run documented in `backend/src/trend-breakout/TREND_BREAKOUT_SPEC.md` §3: **76 trades, 38.16% win rate, profit factor 1.28, +$316.32 total P&L, $335.40 max drawdown**, over 2023-12-11 → 2026-09-09.

**I attempted to independently reproduce this figure in this session** by running `npm run backtest-trend-breakout` (`backend/scripts/backtest-trend-breakout.ts`). I first read the full script to confirm it is safe: it performs only read-only Prisma queries against the local database, no network calls, no AI calls, and no order placement — the only in-memory `.delete()` calls in `backtest.ts` operate on plain JS `Map`/`Set` objects, not the database. **This command was blocked by this session's own permission controls** ("Modify Shared Resources") before it could run, and I did not attempt to work around that block. As a result:
- **I cannot independently confirm the 76/38.16%/1.28/+316.32/335.40 figures were reproduced during this audit.** They rest entirely on the earlier session's self-reported output in the spec file.
- I *can* independently confirm, by direct database query, that the EURUSD H1/H4 candle history the script would read (2023-12-11/2023-12-12 → 2026-09-09) is genuinely present in the exact date range the spec describes — consistent with, though not proof of, the specific reported trade-by-trade result.
- **Recommendation:** re-run `npm run backtest-trend-breakout` yourself (or grant permission for it to be rerun) to get a fresh, independently-timestamped confirmation before treating these numbers as validated.

What the script's own code and comments establish about methodology, regardless of the exact figures:
- **Symbol/timeframe:** EURUSD H4 + H1 only, from the earliest available candle through the latest.
- **Account currency / starting equity:** **not modeled.** The script's own printed caveats state plainly that no account-level risk gates (per-trade/combined/daily-loss/drawdown) are applied in this run, because the database has zero `AccountSnapshot` rows for the account — **this run cannot be described as validating equity-based risk limits**, and the spec text does not claim otherwise.
- **Volume / contract size:** fixed 0.12 lots, $100,000 contract size (standard forex lot) — an explicitly documented placeholder, not this account's own broker-verified `SymbolMetadata` (which is empty).
- **Costs modeled:** a 15-point assumed spread only. **No commission, swap, or slippage is modeled**, and no gap logic beyond the entry-timing gap/chase filter described next.
- **Beirut schedule / DST and one-position rules:** the schedule gate and per-instrument signal logic are the same pure functions the live coordinator uses (not a parallel reimplementation), so schedule enforcement is exercised; the one-position-per-instrument rule is not separately relevant to a single-instrument, single-strategy backtest.
- **Next-H1-open timing, addressed directly by the script's own module comment:** the live/operational code (`entry-timing.ts`) enforces the literal 60-second expiry against real sub-minute quotes. A bar-only backtest **cannot** model that — the earliest a bar-only backtest can fill is up to 3,600 seconds after signal close — so `backtest.ts` fills at the **next H1 candle's open** instead, for contiguous bars exactly at the signal bar's closing boundary, and still applies the real 0.25×ATR gap/chase filter at that fill price, rejecting fills that drifted too far. This is a **disclosed approximation**, not a silent one, and does **not** apply to the live code path. The report's specific concern about a missing/session-gap next bar improperly preserving a setup past 60 seconds was not independently re-verified in this session (would require reading `backtest.ts`'s gap-handling branch line-by-line against a synthetic session-gap fixture) — flagged as **unknown, needs a targeted follow-up test**, not confirmed either way.
- **Closed vs. open-at-end trades, signal/rejection counts:** the script's `report()` function does print `openAtEnd`, `gateRejectionCounts`, `gapChaseRejections`, and `scheduleRejections` — these breakdowns exist and would have been available had the run completed in this session; they are not reproduced here since the run did not execute.
- **Realized vs. equity-based drawdown:** this run's max-drawdown figure is a **realized** money drawdown across the sequence of closed trades — there is no equity curve to speak of, since no account equity was modeled.

**Gold and combined (shared-account) backtests:** confirmed **do not exist against real data**, for the simplest possible reason — zero `XAUUSD` candles exist in the database (direct query, this session), and `CANDLE_SYMBOLS` was never configured to include gold. `runCombinedTrendBreakoutBacktest` exists and is unit-tested against **synthetic** two-instrument data (`backtest.spec.ts`, 5 tests, verified passing fresh in this session) but has never run against real gold data. Missing prerequisite: a live MT5 terminal session with gold added to `CANDLE_SYMBOLS`, run long enough to backfill meaningful history.

**Is any data genuinely untouched by prior strategy choices?** Yes — the EURUSD H1/H4 candle history itself is raw broker data, unaffected by any strategy logic. What is *not* untouched is the fact that only EURUSD was ever configured for candle collection in the first place — that configuration choice (made for the legacy strategy, inherited here) is why gold has no history at all, not a limitation of the new strategy's own design.

### Legacy `weekly-h4-sr-v1` backtest

Out of scope for this report's headline figures (the task's verification target was the new strategy's EURUSD numbers specifically); `backend/scripts/backtest-autonomous-rule.ts` exists for the legacy strategy but was not exercised in this session. Do not mix its results with the trend-breakout figures above.

---

## 8. Tests and runtime evidence

All commands below were actually run in this session (2026-09-12) against the project's disposable, purpose-built test infrastructure — never the shared dev database, never a real broker, no AI API calls, no order placement.

| Command | Scope | Result (this session) |
|---|---|---|
| `cd backend && npx vitest run test/trend-breakout/` | 11 spec files, the entire new-strategy test surface | **11/11 files passed, 93/93 tests passed** |
| `cd backend && npx vitest run test/trend-breakout/ test/autonomous/` | Adds the legacy strategy's 12 spec files | **24/25 files passed, 224/232 tests passed, 8 skipped** — the one failure (`test/autonomous/autonomous-execution-e2e.spec.ts`) is a `Hook timed out` / `ECONNREFUSED 127.0.0.1:6481` — **a missing local Redis on that specific port in this session's environment, not a logic failure.** All 8 skips are inside that same file, cascading from the same setup failure |
| `cd backend && npx vitest run` (full suite, all directories) | Every backend spec file — 119 files, 953 tests | **90/119 files fully passed; 29 files "failed."** But: **744/953 individual tests passed, 209 skipped, and zero individual test assertions actually failed** — every one of the 29 "failed" files is 100% skipped tests behind a 30-second hook timeout, not a real logic failure. Root cause identified directly: `.env.test`'s `REDIS_URL` points to `127.0.0.1:6481`, and the `autonomous-trading-redis-test` Docker container exists but is in `Created` (never started) state — so any test that boots the full Nest app (which wires up BullMQ/Redis in `JobsModule`) times out in its setup hook before running anything. This affects every e2e-style spec (`auth.spec.ts`, `dashboard-auth.spec.ts`, `dashboard-isolation.spec.ts`, `dashboard-api-e2e.spec.ts`, `health-e2e.spec.ts`, `historical-charts-e2e.spec.ts`, `technical-analysis-e2e.spec.ts`, `xtb-import-e2e.spec.ts`, `xtb-import-xlsx-e2e.spec.ts`, `snapshot-ingestion.spec.ts`, `trade-ingestion.spec.ts`, `position-sync.spec.ts`, `idempotency.spec.ts`, `isolation.spec.ts`, `heartbeat.spec.ts`, `cursor.spec.ts`, several `test/rules/*.spec.ts`, `test/ai/ai-pipeline.spec.ts`, `test/ai/ai-enqueue-resilience.spec.ts`, `test/telegram/delivery.spec.ts`, `autonomous-execution-e2e.spec.ts`, `data-integrity-e2e.spec.ts`, `ingestion-resilience.spec.ts`) — one common environment gap, not 29 separate bugs. **Every pure unit/service-level test — including the entire trend-breakout suite, all autonomous-strategy unit tests, all AI-provider tests, all analytics/technical-analysis/rules-evaluator tests — passed cleanly.** Starting the test Redis container (`docker compose -f docker-compose.test.yml up -d --wait`, i.e. actually running `npm run test:db:up` to completion) would very likely turn most or all of these 29 into passes; this was not attempted further in this session |
| `cd collector && ./.venv/Scripts/python.exe -m pytest -q` | Entire Python collector test suite (fully mocked MT5, no real terminal or broker needed) | **121/121 passed** |
| `npm run backtest-trend-breakout` | Read-only backtest reproduction | **Blocked by this session's own permission controls before running** — not attempted further (§7) |

**Distinctions requested by the task:**
- **Existing saved test results vs. rerun this session:** every number above was generated fresh, in this session, against a disposable test database (`autonomous_trading_test`, port 5444) — none are copied from a prior report.
- **Unit vs. integration:** the trend-breakout and autonomous suites mix pure unit tests (indicators, schedule, sl-tp, currency-conversion) with real-Postgres integration tests (`db-integration.spec.ts` runs against the actual disposable test DB via Prisma, not a mock).
- **Broker mocks vs. real broker integration:** every passing test uses either synthetic in-memory data or a fully mocked `MetaTrader5` module (collector pytest suite) — **there is no integration test anywhere in this codebase that talks to a real MT5 terminal.** Any real-broker verification would have to be a manual, supervised collector run, not an automated test.
- **Actual order execution — any historical evidence?** None found. The `positions` table (live open-position tracking) is empty. The `trades` table's only content is the XTB historical import (a different broker, a different account, imported after the fact) — it contains no rows that could represent an order this system itself placed. No `AutonomousDecision` or `TrendBreakoutDecision` rows exist that reached a filled state. **This sandbox found zero evidence, in either direction, of any real order this system ever placed** — not "it never happened," but "no evidence was found," which is the honest, verifiable claim.

**Skipped, failing, flaky, or untested critical paths, named explicitly:**
- `test/autonomous/autonomous-execution-e2e.spec.ts` and 28 other e2e-style spec files — all fail/skip in this environment due to one shared missing local Redis dependency (test Redis container never started, port 6481 unreachable), not a code defect; starting that container would very likely resolve most or all of them.
- Every one of the 744 tests that *did* run (all pure unit/service-level tests, including the full trend-breakout and autonomous-strategy suites) passed with zero failures — the full-suite run found no genuine logic regressions, only the one environmental gap above.
- No test exists (or could safely be run) against a real MT5 terminal or real broker fills — this is inherently untestable in an automated CI sense and remains a manual-verification-only gap.
- `emergency-handler.ts` and `slot-lock.service.ts`'s `release()`/`updateState()` are unit-tested in isolation but have **zero integration test exercising them via any real caller**, because no real caller exists yet (§3).

---

## 9. Settings and user experience

What a user can actually do today, verified by tracing the frontend call through to the backend controller and service:

| Capability | Status |
|---|---|
| Edit EURUSD/gold volume | **Real, wired, DB-audited.** `VolumeForm.tsx` → `POST /accounts/:id/trend-breakout/volume/:instrument` → `volume-settings.service.ts`, which validates, writes a `TrendBreakoutVolumeAudit` row, and updates the setting in one transaction. Cannot retroactively resize an open position (no such code path exists to do so). |
| See effective settings/strategy version | Partial. `page.tsx` shows strategy version, entry window, risk **policy** thresholds, and a static execution-mode string. **Risk *state*** (whether daily-loss or drawdown is currently triggered) is **not** included in the settings response — the drawdown-reset button is shown unconditionally with no visibility into whether a block is actually active. |
| See execution state and blocking reasons | Partial. `executionMode` is a hardcoded string (`'DISABLED — collector execution and any scheduler for this strategy remain off'`) — accurate today, but it is source code, not a live-computed flag, so it will not automatically reflect a future change without a code edit. |
| Inspect decisions | Yes — `GET decisions` is real and rendered, including HOLD/rejection reasons. Currently empty (0 rows in the DB, §2). |
| Inspect positions, exits, risk, incidents | **No dedicated view exists for any of these** for the trend-breakout strategy. A generic `/health/incidents` endpoint exists elsewhere in the app but this page never calls it. There is no open-positions or exits list (moot today, since there are none, but the surface doesn't exist for when there are). |
| Reset eligible safety blocks | Yes — drawdown reset is real, authenticated, and DB-persisted. **However, the reset action itself is audited only via an application log line (`Logger.warn`), with no database audit row** — contrast this with volume changes, which have a full DB-backed audit trail and a dedicated read endpoint (`GET volume-audit/:instrument`). This is a real, fixable gap: "who reset it and when" is not queryable via the API today. |
| Distinguish historical research from current account activity | Yes, structurally — the XTB reference account and the live MT5 account are separate `TradingAccount` rows; the dashboard is account-scoped throughout. |
| Auth on settings changes | Both routes sit behind `DashboardTokenGuard`, the same account-bound bearer-token pattern used elsewhere in the app — not weaker, not missing. |

**Settings with no frontend surface at all today** (can only be changed by editing source/DB/env directly): risk **policy** thresholds (0.5%/1%/2%/5%/spread/quote-age — read-only in the API, no `POST` route exists), `SymbolMetadata` (no admin UI to enter/override broker limits), `executionMode` (hardcoded in source, not a toggle).

---

## 10. Remaining work and recommended order

| Task | Why it matters | Current evidence | Dependency | Owner | Acceptance criterion | Completable with execution disabled? |
|---|---|---|---|---|---|---|
| Run one supervised collector session against the configured demo account (`5055783885`) | Populates `AccountSnapshot`/refreshes candle data; nothing downstream can be equity-gated without this | 0 `AccountSnapshot` rows currently exist for any account | A running MT5 terminal + collector process | Terminal/broker access (user) | ≥1 `AccountSnapshot` row exists for account `753b3a50-…`; EURUSD candles advance past 2026-09-09 | **Yes** |
| Wire `get_symbol_info()` into `runner.py` on a schedule, push via the existing `POST /collector/symbol-metadata` route | Every SL/TP/volume rounding gate fails closed without it | Function exists, zero callers (confirmed by grep) | Above collector session | Claude implementation | `symbol_metadata` has 1 row per instrument once run | **Yes** |
| Add gold to `CANDLE_SYMBOLS`, backfill history | Blocks gold backtest and any future gold trading entirely | `historical_candles` has 0 XAUUSD rows (confirmed) | Live terminal session with the config change | User decision (config value) + Claude (if code change needed) — config-only, no new mechanism required | XAUUSD H1/H4 rows exist with a real date range | **Yes** |
| Re-run and independently confirm the EURUSD backtest figures | The only existing figures are self-reported from an earlier, un-reproduced session (§7) | Blocked this session by permission controls | None — script is already safe and ready | User (grant permission) or Claude (rerun) | A freshly-timestamped run reproduces or corrects the 76/38.16%/1.28/+316.32/335.40 figures | **Yes** |
| Wire `TrendBreakoutCoordinatorService.evaluateAll()` to a schedule (shadow mode: log decisions, take no action) | Currently zero shadow decisions have ever been logged; this is the actual next milestone toward eventual execution | 0 `trend_breakout_decisions` rows; confirmed no scheduler anywhere | Symbol metadata + account snapshot both populated (else everything HOLDs on missing data) | Claude implementation | Coordinator runs on a real cadence and logs real HOLD/would-trade decisions against live data for several days | **Yes — this is exactly the "still disabled" milestone** |
| Give the slot lock a manual/other-strategy MT5 position check (`find_any_position`-style) | Headline safety property ("max one position per instrument") is currently blind to manual trades | Confirmed no broker-position lookup exists in `slot-lock.service.ts` | Live position-query capability in the collector (already exists via `find_any_position`, just needs a caller path) | Claude implementation | A manually-opened position on an instrument is shown to block a new signal in a test/shadow run | **Yes** |
| Wire `emergency-handler.ts`'s `handleMissingStopLoss()` to something real | "Always blocks entries after an emergency" is currently a theoretical guarantee (zero callers) | Confirmed zero production callers | An actual open position must exist to detect a missing stop on | Claude implementation | A deliberately-broken-stop scenario in a controlled test triggers the full 5-step handler | **Yes** (can be exercised against a manually-created test position without this system opening one itself) |
| Give the legacy strategy's kill switch equivalent teeth (re-check at claim time, or add position-closing capability) | Currently only blocks new decision creation; cannot close an existing position; not re-checked once a decision is already `PENDING` | Confirmed via code trace (§5) | None | Claude implementation | Flipping the kill switch after a decision is `PENDING` prevents the collector from executing it | **Yes** |
| Add a DB-backed audit row for drawdown resets | "Who reset it and when" is currently only in application logs, not queryable | Confirmed log-only (§9) | None | Claude implementation | `GET` endpoint returns a real audit history, mirroring the existing volume-audit pattern | **Yes** |
| Resolve the `import_batches` discrepancy | Documented import history doesn't match the current database's audit trail | Confirmed empty table vs. documented batch-tracked imports (§6) | Access to whoever has operational history from that period | User decision (needs institutional memory, not code) | Either the missing batch rows are explained/restored, or the discrepancy is formally accepted as unresolved | **Yes** |
| Choose a distinct magic number for trend-breakout, build its collector execution-poll step | Required before any trend-breakout order can ever be sent | Confirmed no such wiring exists (spec §9, item 6) | Everything above (shadow mode proven first) | Claude implementation + user decision (the magic number value itself, if it matters to the user) | A test order round-trips through a dedicated poll step distinct from the legacy strategy's | **No — this specifically builds toward execution, though it can itself be built/tested with the flag left off** |
| Controlled demo-execution readiness review | Final gate before ever enabling live order placement | N/A — depends on everything above | All of the above, plus a clean multi-day shadow run | User decision (go/no-go) | Explicit, informed user sign-off after reviewing a shadow-mode track record | **This is the transition point itself** |
| Any real-money assessment | Explicitly out of scope | N/A | Full demo track record | User decision — **explicitly outside current authorization** | N/A | N/A |

### Milestone grouping

1. **Read-only data integration** — collector session, symbol metadata wiring, gold backfill. *(top three rows above)*
2. **Complete and verified execution infrastructure, still disabled** — shadow-mode scheduling, manual-position slot check, emergency-handler wiring, kill-switch hardening, audit-row gap. *(middle rows above)*
3. **Realistic EURUSD/gold/combined evaluation** — reproduce the backtest with fresh permission, then extend to gold once data exists, then combined.
4. **Scheduled shadow operation** — the coordinator running continuously, logging real decisions, execution still off.
5. **Controlled demo-execution readiness** — the go/no-go review row above.
6. **Real-money assessment** — explicitly outside current authorization; not addressed further here.

**The single most useful next milestone:** getting the trend-breakout coordinator into **scheduled shadow mode** — logging real HOLD/would-trade decisions against live data, with execution still off. Concretely, that requires (in order): one supervised collector run to populate account/symbol data, the symbol-metadata push wiring, and a scheduler hook for `evaluateAll()`. Everything else in this report (the backtest re-run, the manual-position check, the emergency-handler wiring) can proceed in parallel or immediately after, but this is the one step that converts the strategy from "tested in isolation" to "observed against real, current market conditions" without taking on any execution risk.

---

## Appendix: key raw evidence referenced above

- Git: `git log --oneline -5`, `git diff master --stat`, `git status` (clean).
- Processes: `tasklist`, `docker ps -a` — no backend/collector process running; log files last written 2026-09-10 16:34–16:35.
- Database (`autonomous_trading`, port 5443, via `docker exec ... psql`): `trading_accounts`, `account_snapshots`, `historical_candles`, `symbol_metadata`, `trend_breakout_decisions`, `trend_breakout_slot_locks`, `positions`, `trades`, `import_batches` — all queried directly, row counts and ranges as stated throughout.
- Config: `collector/.env` and `backend/.env` non-secret keys inspected directly (credentials/API keys never printed).
- Three independent code-audit passes performed by sub-agents in this session, each citing file:line evidence, covering: (a) the full trend-breakout module against the approved rule list, (b) the complete legacy execution/broker-safety route, (c) frontend wiring and the XTB import module — findings integrated throughout §§3, 5, 6, 9.
