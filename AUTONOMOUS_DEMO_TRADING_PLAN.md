# Autonomous Demo Trading System (v2) — Technical & Operational Plan

**Status:** Planning only. No production code has been written against this plan. Nothing in
this document authorizes connecting to a real-money account.

**Relationship to v1:** This is `trading-monitor-autonomous`, a separate repository forked from
the v1 Trading Behavior Monitor's codebase. v1 remains untouched, read-only, and running on its
own infrastructure. This plan does not modify, redeploy, or depend on v1 in any way. Where this
plan reuses v1 patterns or modules, it means "copy/adapt the code in *this* repo," never "call
out to the live v1 system."

Repo check performed before writing this plan: `git remote -v` in this workspace points to
`trading-monitor-autonomous` (not v1's repo), and the only commit is "Initial v2 fork from v1
(autonomous demo project)." Setup looks correct.

---

## 1. Scope & Boundaries

### What v2 will do
- Read live EURUSD market data (ticks + H4/D1 candles) from an MT5 **demo** account.
- Evaluate the friend's H4 weekly support/resistance rule against current price.
- Ask an AI model to confirm/reject the setup and produce a structured decision.
- Validate that decision against hardcoded constraints.
- If valid, place a bracketed order (entry + SL + TP) on the demo account.
- Monitor open positions, close them per rule or on kill-switch trigger.
- Log every decision, verdict, and order for audit.
- Send Telegram alerts and expose a dashboard.
- Run a backtest before any live demo activity, and a 1-month demo test after.

### What v2 will **never** do (hardcoded, enforced in code, not just policy)
- **Never connect to a real-money account.** On startup, and before every single order, verify
  `mt5.account_info().trade_mode == ACCOUNT_TRADE_MODE_DEMO`. If this check fails, or if
  `account_info()` returns `None`, or if the check throws, the system refuses to start / halts
  immediately. This check is duplicated at both the collector/execution layer (Python, closest to
  MT5) and the backend risk manager (TypeScript), so no single bug disables it.
- **Never trade any symbol other than `EURUSD`.** The symbol is a compile-time constant, not a
  config value read from an environment variable or database row that something could edit.
- **Never exceed a hardcoded max position size** — 0.01 lots (the minimum lot on nearly all
  brokers), also compile-time constant.
- **Never place more than one order per calendar day** (the friend's own Rule 3 — see below).
- **Never place an order without an attached stop-loss.** SL is part of the same `order_send`
  call that opens the position — there is no code path that sends a bare market/limit order and
  attaches SL afterward.
- **Never let the AI bypass the risk manager.** The AI proposes; deterministic code in §4 disposes.

Beyond these absolute safety boundaries, this plan deliberately does **not** layer on a separate
set of invented risk-management numbers (a daily loss cap, a trading-hours window, a
consecutive-loss circuit breaker, and similar) on top of the friend's strategy. The **only**
trading logic this system runs is the friend's rules, in full, as given — see §2 for how that rule
set is kept as editable configuration rather than hardcoded constants, since the friend is
expected to revise it (add, remove, or change rules) over time.

This system is for **demo testing only**. No section of this plan describes, enables, or
recommends trading real money. Any future decision to do so is explicitly out of scope and would
require a new plan, new legal review (§11), and the user's separate, explicit sign-off.

---

## 2. Architecture

### Diagram

```
                         ┌─────────────────────────────┐
                         │   MT5 Terminal (DEMO acct)   │
                         │   Windows host, 24/5 uptime  │
                         └───────────────┬─────────────┘
                                         │ MetaTrader5 Python API
                                         ▼
                ┌───────────────────────────────────────────────┐
                │        Collector/Executor (Python)             │
                │  - reads ticks, H4/D1 candles, account state    │
                │  - ★ NEW: order_send() wrapper (bracketed)      │
                │  - ★ NEW: demo-account gate (checked every call)│
                │  - ★ NEW: position monitor loop (10s poll)      │
                │  - ★ NEW: file-based kill switch check          │
                └───────────────┬─────────────────────────────┬──┘
                                │ push (idempotent)             │ poll for
                                ▼                               │ pending orders
                ┌───────────────────────────────────────────────┐
                │              Backend (NestJS)                  │
                │                                                 │
                │  Weekly S/R Rule Engine  ──►  AI Decision Layer │
                │  (friend's rules, H4)         (Claude, temp=0)  │
                │         │                            │          │
                │         ▼                            ▼          │
                │   ┌─────────────────────────────────────────┐  │
                │   │   Risk Manager (deterministic, §4 —       │ │
                │   │   safety bounds + friend's frequency rule)│ │
                │   │   — can veto any AI decision               │ │
                │   └──────────────────┬──────────────────────┘  │
                │                      ▼                          │
                │              Decision + Order Queue              │
                │              (BullMQ, reused from v1)            │
                │                                                 │
                │  Also: Market Events (FRED/Finnhub/Marketaux,    │
                │  reused as-is), Historical Pattern Summary       │
                │  (friend's 865 closed positions, reused as-is), Health │
                │  Monitor (reused, extended with kill-switch      │
                │  status components), Telegram                    │
                │  (reused, extended with /stop command)           │
                └───────────────┬───────────────────┬─────────────┘
                                │                    │
                                ▼                    ▼
                    ┌───────────────────┐   ┌──────────────────┐
                    │  Postgres (Prisma) │   │  Telegram Bot     │
                    │  full decision +   │   │  trade alerts,    │
                    │  order audit trail │   │  /stop command    │
                    └───────────────────┘   └──────────────────┘
                                │
                                ▼
                    ┌───────────────────────────┐
                    │  Dashboard (Next.js, reused│
                    │  frontend, new /autonomous │
                    │  section) + kill-switch    │
                    │  button                    │
                    └───────────────────────────┘
```

### The friend's rules are configuration, not hardcoded logic

Because the friend's rule set is explicitly expected to change over time (rules added, removed, or
tweaked as the strategy evolves), its tunable parameters (SL/TP distance, entry-proximity
tolerance, reference timeframe, max orders/day) are read from `.env` config
(`autonomous-rules.config.ts`), not baked in as literals inside the rule engine's `if` statements —
**implemented**, following the precedent this repo's own `technical-analysis.config.ts` already
set for this exact situation: "there is only ever one EURUSD market to analyze, so these are
system-wide settings, not something that varies per rule instance," documented in that file's own
comment. That precedent turned out to be a better match than the `RuleDefinition`/DB-row pattern
originally proposed here — `RuleDefinition` rows are for *behavior-monitoring* rules that vary
per-account, which the friend's single, system-wide EURUSD strategy is not. Changing a tunable
parameter is an `.env` edit and a restart; changing the rule's actual *structure* (e.g. the friend
adds an entirely new condition) is a small, isolated code change to one evaluator function, the
same way this codebase has grown its other rule types over time (new evaluator files, not rewrites
of existing ones). See `backend/src/autonomous/AUTONOMOUS_RULE_ENGINE_SPEC.md` for the concrete
parameters and every placeholder default's reasoning. The **risk manager** (§4) is a separate, much
smaller thing: it only enforces the absolute safety boundaries from §1 (symbol lock, demo-account
gate, max position size, mandatory SL, kill switch) plus the friend's own one-order-per-day rule —
it is intentionally not where extra, independently-invented numeric limits live.

### Infrastructure separation — implemented, with one residual step in v1's own repo

v2 now has its own dedicated local Postgres/Redis (dev: `autonomous-trading-postgres`/`autonomous-trading-redis`, ports 5443/6480; test: their `-test` twins, ports 5444/6481), fully distinct names/ports/volumes/credentials from v1's. Both `backend/docker-compose.yml` and `backend/docker-compose.test.yml` now set an explicit `name:` field.

That explicit name is a **root-cause fix**, not cosmetic: Docker Compose derives its project identity from the current directory's basename by default, not its full path, and v1's real project folder and this repo's `backend/` directory happen to share that basename ("backend"). The first `docker compose up` run in this repo (before that fix existed) matched and **recreated** v1's real local-dev `trading-monitor-postgres`/`trading-monitor-redis` containers under that shared default project name. The underlying named volumes survived (Compose recreate doesn't delete volumes), so no data was lost, and both containers were restored under their original names, ports, and volumes. v1's own test containers were never touched.

**One residual step, in v1's own repo (inaccessible from this session)**: the restored `trading-monitor-postgres`/`trading-monitor-redis` containers were recreated as plain `docker run` containers, outside Compose's tracking, specifically so they can never again be silently adopted by a project-name collision. This means the next time v1's real local dev environment runs `docker compose up` from v1's actual folder, Compose will likely find those container names already in use by containers it doesn't recognize as its own, and refuse to start with a "name already in use" error. The fix, in v1's own repo: either add the same explicit `name:` field to v1's `docker-compose.yml`/`docker-compose.test.yml`, or simply `docker stop`/`docker rm` the two restored containers first and let v1's own `docker compose up` recreate them fresh — they'll reattach to the same named volumes automatically since the volume names are unchanged, so no data loss either way.

### Reuse vs. divergence (grounded in what's actually in this repo today)

| Component | Reuse from v1 as-is | Must build new |
|---|---|---|
| MT5 collector | `collector/app/mt5_client.py` connection/read patterns | `order_send` wrapper, demo-gate, position monitor loop — collector is currently **read-only**, this is the single biggest safety-relevant divergence |
| Support/Resistance | `technical-analysis/support-resistance.service.ts` utilities (`point-value.ts`, `CandleData`, proximity-match types) | The service itself uses **fractal-pivot** detection for the monitoring product — that is a *different* definition of "support/resistance" than the friend's rule ("highest/lowest H4 print of the previous completed week"). A new, much simpler `WeeklyRangeLevels` calculator is needed; it can borrow the surrounding utilities but not the fractal-pivot algorithm |
| AI layer | `ai/ai-provider.interface.ts`, multi-provider setup (Anthropic/Gemini/Groq/OpenRouter/mock/fallback), `validate-ai-result.ts`, `safety-filter.ts` patterns | A new decision schema (§3), new validation rules specific to trade orders (points, symbol, frequency), and running at `temperature=0` for reproducibility |
| Market events (FRED/Finnhub/Marketaux, central bank calendar) | Reused unmodified — this already produces the "upcoming economic calendar" input the AI needs | Nothing — direct reuse |
| Historical pattern data | The friend's **865 closed positions are already imported** into Postgres, under a second `XTB 50283640` account, via the existing XTB importer, and already consumed by `HistoricalPatternSummaryService`. **Correction from an earlier draft of this table (twice over)**: only 648 of those are EURUSD (the rest are GOLD/OIL/EURCHF/GBPUSD/NATGAS — this is the friend's general trading history, not exclusively EURUSD), and only 249 EURUSD entries have both SL and TP recorded. An EARLIER version of this same correction said "1,730 trades / 1,296 EURUSD" — those were exactly double the real counts, a confirmed reporting defect (raw `trades`-table row count, which is 2 rows — an IN leg and an OUT leg — per closed position by the XTB importer's own design, not 1,730/1,296 actual positions); see the reconciliation audit for the full root-cause trace. Still directly reusable as the AI's "experience" input and as a rough sanity check for backtest ground truth (§7), just not as strong a validation source as "865 EURUSD trades" would have implied | Nothing structural — a query scoped specifically to this account and `symbol='EURUSD'` |
| Telegram | Bot client, delivery processor, message templates | `/stop` command handler, new trade-open/close/daily-summary templates |
| Rules/evaluators pattern | `technical-analysis.config.ts`'s `.env`-driven, system-wide-single-symbol config pattern (a closer match than `RuleDefinition`, which is for *per-account* behavior-monitoring rules) | A new, isolated evaluator (`autonomous-rule-engine.service.ts`) that reads the friend's tunable parameters from that config and computes the actual entry decision, plus a much smaller risk-manager evaluator for the safety bounds in §4 |
| Historical candles | `market-data/historical-candle.service.ts`, `HistoricalCandle` model | Backfill 2+ years of EURUSD H4 if not already fully populated |
| Dashboard | Next.js app, existing auth pattern | New `/autonomous` route: equity curve, open position, AI reasoning, risk manager state, kill switch |
| Database | Prisma/Postgres conventions | New tables, kept separate from v1-style tables so they can't collide: `AutonomousDecision`, `AutonomousOrder`, `RiskManagerState`, `KillSwitchEvent` |
| Deployment | Docker Compose + Caddy pattern | A **separate** `docker-compose.autonomous.yml`, separate `.env`, separate Postgres database (or at minimum separate schema), separate Telegram bot token, and strong recommendation (§13.2) to run this on separate infrastructure from v1 entirely — not just separate containers on the same box |

---

## 3. The AI Decision Layer

### Inputs to the AI (assembled by the backend before every decision cycle)
1. Current EURUSD bid/ask (live tick).
2. This week's active reference levels: highest H4 high and lowest H4 low of the previous
   completed week (or the recalculated reference week if a break occurred — see rule text below).
3. Current price's position relative to those levels, and distance in points.
4. Whether either level has been broken since it was established, and if so, what the new
   candidate levels are.
5. The friend's historical trade patterns (the 865-position dataset, via the existing
   `HistoricalPatternSummaryService`) — win rate / avg P&L context, not literal replay.
6. Upcoming economic calendar events (FRED + Finnhub + Marketaux + central bank calendar — reused
   as-is from the existing `market-events` module).
7. Current account state: equity, open positions, and whether an order has already been placed
   today (needed to enforce the friend's one-order-per-day rule).
8. The friend's rules, verbatim, as static text in the prompt — not paraphrased, not summarized.

### AI's task
Given all of the above, produce exactly this structure:

```json
{
  "action": "OPEN_BUY" | "OPEN_SELL" | "CLOSE_POSITION" | "HOLD",
  "confidence": 0.0,
  "symbol": "EURUSD",
  "entry_price": 0.00000,
  "stop_loss": 0.00000,
  "take_profit": 0.00000,
  "position_size": 0.01,
  "sr_reference_week_start": "2026-09-01",
  "level_used": "RESISTANCE" | "SUPPORT" | null,
  "reasoning": "Must explicitly reference the friend's rule text and the specific H4 level used."
}
```

`sr_reference_week_start` and `level_used` are additions beyond the minimum schema in the original
brief — they exist purely so the audit log (§10) can prove, after the fact, exactly which week's
levels a given decision was based on, which matters a lot given the break/recalculation rule is
stateful (see §13.3 for why this rule's exact semantics need clarifying with the friend first).

### Constraints enforced by validation, not just prompt wording
The AI is asked nicely in the prompt to follow these; none of them are trusted until re-checked in
code against the raw MT5 price feed and the DB:
- `stop_loss` and `take_profit` must each be exactly 180 points from `entry_price` (tolerance: 0,
  pending the points-vs-pips clarification in §13.3 — whatever the final unit is, it is exact, not
  "about 180").
- `symbol` must be `"EURUSD"` — anything else is an automatic reject, not a downgrade.
- Only one `OPEN_*` decision may be *acted on* per calendar day, regardless of how many times the
  decision loop runs that day.
- `action` must be one of the four literal enum values above; anything else is rejected as a
  malformed response.
- If any required field is missing, non-numeric where a number is expected, or the reasoning field
  is empty, the decision is rejected and logged — the order is never placed on a best-effort
  parse of a broken response.

### Which model, and an honest framing of what the AI is (and isn't) for
An LLM is not a market-prediction engine, and this plan does not treat it as one. Its job here is
narrow: read a fully-specified, deterministic rule plus the current market state, and say whether
today's setup matches that rule — the same kind of "does X satisfy condition Y, explain why" task
the existing `ai` module already does for alert narration, just applied to entries instead of
after-the-fact explanations. Recommended model: reuse the existing `anthropic-provider.ts` as
primary (a current Claude model), with the existing `fallback-provider.ts` pattern providing
redundancy if the primary call fails or times out — not for a "second opinion," purely for
uptime. Run at `temperature=0` for reproducibility (see §13.3). See §13.1 for a stronger opinion
on whether the AI should even be in the price-math path at all, versus a pure veto role over a
deterministic calculator.

---

## 4. Risk Manager (deterministic, separate from the AI)

The risk manager is plain, hardcoded, unit-tested TypeScript — not a prompt, not configurable by
the AI, and not overridable by anything short of a code change and a new deploy. It sits between
the AI's decision and the execution module and can veto anything. Its job is deliberately narrow:
enforce the absolute safety boundaries from §1, plus the friend's own trading-frequency rule —
nothing else. It is not the place for additional, independently-invented risk limits (no daily
loss cap, no circuit breaker, no trading-hours window): the friend's rules (kept as editable
configuration, §2) are the strategy, and this layer exists to make sure the system can never
violate the non-negotiable safety boundaries no matter what the strategy configuration says.

Hardcoded rules:
- Symbol: `EURUSD` only — reject anything else outright.
- Max position size: `0.01` lots.
- Demo-account gate: re-verified immediately before every order, not just at startup (§1).
- One order per calendar day maximum — the friend's own Rule 3, enforced here independently of
  whether the AI remembered it.
- Every order must carry a stop-loss at submission time, at exactly the distance the friend's
  rules specify; if the AI's decision omits one, or the SL it supplies isn't exactly right, the
  order is rejected before it ever reaches the execution module.
- Kill switch state is checked here too (§6), not only in the execution module — defense in depth.

Two related notes that are implementation consequences, not separate hardcoded risk rules:
- Since only one order per day is allowed, and the friend's rules don't currently say what to do
  if a previous day's position is still open when a new valid setup appears, the simplest
  reading — don't open a second position while one is already open — follows directly from "one
  order per day," not from an extra concurrency limit invented on top of it. This should be
  confirmed with the friend (§13.3) rather than assumed indefinitely.
- Broker-side technical constraints — chiefly the minimum distance a broker will accept between
  the current price and SL/TP (the "freeze"/stops level) — will simply cause `order_send` to fail
  if the friend's specified SL/TP distance is tighter than the broker allows on the demo account
  used. The execution module (§5) needs to handle that failure gracefully; this is a broker
  mechanics issue to plan for, not a risk policy this plan is separately imposing.

---

## 5. Execution Module

- Uses MT5's `order_send` via the Python API, from the same collector process that already has an
  authenticated MT5 session (extending it, not standing up a second connection).
- Every order is submitted with: `symbol=EURUSD`, `volume`, `type`, `price`, `sl` (180 points),
  `tp` (180 points), a fixed `magic number` unique to this system (so these trades are
  distinguishable from any manual or other-EA activity on the same demo account), and a `comment`
  referencing the decision ID for traceability.
- On failure (requote, timeout, transient broker error): retry exactly once with a fresh price
  quote; if the retry also fails, abort and log — never loop indefinitely, never fall back to a
  "close enough" price or size.
- Partial fills: if the broker's fill is for less than the requested volume (uncommon at 0.01 lots
  but possible), the difference is logged and no follow-up order is auto-placed to "complete" it —
  a human reviews it.
- Position monitoring loop: polls open positions every 10 seconds to detect fills, SL/TP hits,
  manual intervention on the account, or an MT5 terminal/connection drop.
- Every fill is written to a `trades`-equivalent table with the originating `AutonomousDecision`
  row's ID attached, so every position can be traced back to the exact AI output and risk-manager
  verdict that produced it.
- A load-bearing resilience property worth stating explicitly: SL/TP submitted as part of the
  order are enforced by the **broker's server**, not by this system's uptime. If the whole
  pipeline crashes after a position is opened, the position is still protected by its broker-side
  stops — the position monitor and kill switch are for *new* risk-taking and visibility, not the
  last line of defense against an already-open position running unprotected.

---

## 6. Kill Switch (mandatory)

Three independent paths, any one of which halts the system:

1. **Telegram command** — `/stop`, handled by the existing Telegram bot client. Effect: close all
   open positions at market, cancel any pending orders, set the system's trading-enabled flag to
   false, and confirm back to the chat.
2. **Dashboard button** — a single, unambiguous "STOP" control in the `/autonomous` dashboard
   section, calling a backend endpoint with the same effect as `/stop`.
3. **File-based kill switch** — if a `KILL_SWITCH` file exists on the server/VPS filesystem, the
   collector/executor loop refuses to place new orders and the backend refuses to emit new
   decisions. This path deliberately does not depend on the backend, Telegram, or the database
   being healthy — it's the one that still works if everything else is degraded.

All three are checked **before every decision cycle and before every order submission**, at both
the backend (decision loop) and the collector/executor (order-placement loop) — defense in depth,
so a bug in one layer's kill-switch check doesn't leave the other layer unguarded.

On trigger: close all open positions, cancel pending orders, stop emitting new signals, log the
event (which path triggered it, timestamp, account/position state at the moment of trigger).
Resuming after a kill-switch trigger is **always manual** — there is no auto-resume, ever,
regardless of which path triggered it.

---

## 7. Backtest Framework (required before any live demo activity)

1. **Data**: minimum 2 years of EURUSD H4 candles, sourced via the existing
   `historical-candle.service.ts` / `HistoricalCandle` table (backfilled further if current
   coverage is shorter).
2. **Rules-only baseline**: implement the friend's rule exactly as written (§ below on ambiguities
   to resolve first) with **no AI involved at all**, run it mechanically over the full history,
   and record: total trades, win rate, average win, average loss, profit factor, max drawdown,
   Sharpe ratio.
3. **With AI**: run the same historical window through the full pipeline (rule engine → AI
   confirmation → risk manager), and record the same metrics.
4. **Compare**: if the rules-only baseline outperforms (or matches) the AI-assisted version, the
   AI is not adding value in this design, and that must be reported honestly rather than buried —
   see §13.1 for why this is actually the *expected* outcome for a fully-specified mechanical rule.
5. **Replay validation against the friend's own trades** (this repo's specific advantage): the
   friend's actual 648 historical EURUSD closed positions are already in this database. Before trusting
   the mechanical rule engine's backtest numbers, check whether the codified rule, run
   mechanically over history, produces entries that resemble the friend's real ones (similar
   timing, similar levels, similar frequency). If the mechanical version and the friend's real
   trading diverge substantially, that's a sign the rule has been mis-codified (see the
   points-vs-pips and "near" ambiguities in §13.3) before it's a sign the friend's discretion adds
   value the rule can't capture — both are possible, but the codification bug should be ruled out
   first.
6. **Cost modeling**: include realistic spread and (if the demo broker charges one) commission per
   trade — not a zero-cost fill. See §13.3 for why this matters more than it looks given the
   180-point SL/TP size.
7. **Walk-forward, not a single in-sample run**: split the 2-year window into successive
   train/validate slices for any parameter that isn't fully specified by the friend (chiefly the
   "near the level" entry-proximity threshold) so that threshold isn't quietly overfit to the
   whole history.
8. **Gate**: if the rules-only backtest is not at least breakeven after realistic costs, **stop
   here** — do not proceed to building the AI layer, execution layer, or dashboard. Report the
   result to the user and revisit the rule's parameters with the friend.

---

## 8. The 1-Month Demo Test Plan

- Demo account, starting balance $10,000 (fake), opened specifically for this test.
- Start date: the first Monday after backtest sign-off (§7) and full kill-switch verification
  (§6). End date: 4 calendar weeks later.
- **Daily**: equity curve point, trades taken (if any), win/loss, P&L, drawdown from the month's
  peak equity.
- **Weekly**: rolling win rate, AI-vs-rules-only comparison (the rule engine's rules-only decision
  is computed and logged in parallel even when the AI/risk-manager pipeline is what actually
  trades, so the two can be compared after the fact without needing a second live account).
- **End of test**: profit factor, Sharpe ratio, max drawdown, biggest single win, biggest single
  loss, total trades taken vs. theoretical maximum (20 trading days × 1/day = 20 max).
- **Honest statistical caveat, stated plainly**: at most one trade per day and five per week, a
  4-week demo yields on the order of 10–20 trades at most. That is far too small a sample to
  distinguish a real edge from noise for *any* trading strategy — this test can validate that the
  *system* (pipeline, risk manager, kill switch, logging) works correctly under live conditions;
  it cannot validate that the *strategy* is profitable. Treat it as an operational shakedown, not
  a profitability trial (expanded on in §13.1).
- **Automatic stop conditions — any one of these stops the test immediately, not at the next
  weekly review, and indicates a bug rather than just bad luck**:
  - Any order executes outside the risk manager's bounds (wrong symbol, wrong size, missing or
    wrong-distance SL, more than one order placed in a calendar day).
  - Any connection to a non-demo account, at any point.
  - Any code path bypasses the kill switch.
  - Any trade on a symbol other than EURUSD.
- **Manual review triggers** — §4 deliberately doesn't hardcode a daily-loss cap or a
  consecutive-loss circuit breaker on top of the friend's rules, so these aren't automated stop
  conditions, but they should prompt you to pause and look rather than let the test run on
  unattended:
  - Drawdown exceeds 5% of the demo balance.
  - 3 or more consecutive losing trades.

---

## 9. Dashboard & Monitoring

New `/autonomous` section on the existing Next.js dashboard:
- Live demo equity curve.
- Open position (if any): entry, SL, TP, current unrealized P&L.
- The AI's most recent decision and its full reasoning text.
- Risk manager state: whether today's one order has already been placed, and the status of each
  safety check (demo-account verified, symbol lock, kill-switch armed).
- Kill switch status, and the STOP button (§6).
- Telegram alerts: every trade open, every trade close, and a daily summary — reusing the existing
  delivery processor and message-template pattern, with new templates for these event types.

---

## 10. Logging & Audit

- Every AI decision logged with: timestamp, the full assembled prompt/inputs, the AI's raw output,
  the risk manager's verdict (approved / rejected + reason), and the execution result (if any).
- Every order logged with: MT5 order ID, the `AutonomousDecision` ID it came from, fill price, SL,
  TP, volume, and outcome (filled / rejected / retried-then-aborted / closed, and how it closed).
- This audit trail exists specifically so that if the system ever produces an unexpected trade,
  the full causal chain — input data → AI output → risk-manager check → order sent — can be
  reconstructed after the fact, not reconstructed from guesswork.
- New Prisma models needed: `AutonomousDecision`, `AutonomousOrder`, `RiskManagerState`,
  `KillSwitchEvent` — deliberately named/namespaced apart from the existing `Trade`/`Position`
  models used for read-only monitoring, so the two systems' tables can't collide or be confused
  for each other even though they may eventually live in the same database.

---

## 11. Legal & Ethical Warnings

- Nothing in this plan authorizes trading real money, at any point, under any condition.
- The AI is not a predictor of market direction. It follows the friend's stated rules; it does not
  design or improvise its own strategy.
- If this system is ever considered for production use with real money, the user must consult a
  lawyer about licensing and regulatory obligations before doing so — potentially including MiFID
  II (EU), FCA (UK), SEC/CFTC (US), or Banque du Liban (Lebanon), depending on where the account,
  the user, and any counterparties are based. This plan does not attempt that analysis; it only
  flags that it would be required.
- Renting or offering this system's decisions to other people is a legal and regulatory project on
  its own, entirely separate from the engineering in this plan, and is out of scope here.

---

## 12. Deliverables & Phasing

| Phase | Deliverable | Demo only? |
|---|---|---|
| 1 | Separate repo (done). **Implemented**: dedicated Docker Compose (dev + test), dedicated Postgres/Redis containers and ports, dedicated database seeded with a one-time copy of the friend's 865 closed positions and the EURUSD candle history (see "Infrastructure separation" above). Still open: a real dedicated Telegram bot/chat (v1's real token was found in the copied `.env` and replaced with an inert placeholder — needs the user to create a new bot via @BotFather) | Yes |
| 2 | **Implemented and rebuilt around the friend's direct answers** (`backend/src/autonomous/` — see `AUTONOMOUS_RULE_ENGINE_SPEC.md` §2 for the full detail): a touch-then-confirm-retrace entry model (not the original simple-proximity placeholder), a volatility filter, and an H4/D1 confluence filter, all confirmed or reconciled against what the friend actually said, not guessed. Two small details remain this project's own placeholder reconciliations (the exact "broken" overshoot threshold, and the confluence tolerance) — flagged in the spec, not hidden. Manually triggerable via `npm run evaluate-autonomous-rule`. Still open: a live scheduled loop (no cron/scheduler wired yet) and the narrow safety-bounds risk manager (§4) — nothing in this phase can place an order regardless, since no execution module exists | Yes |
| 3 | **Implemented and rerun against the friend's confirmed rules** (`backend/scripts/backtest-autonomous-rule.ts`) over the full 2.75 years of EURUSD H4/D1/M15 data in this database. **Result: a clear FAIL of the go/no-go gate.** 61 trades, 31–34% win rate, profit factor 0.45–0.53, total P&L -3,420 to -4,140 points (losing) depending on the assumed spread. A parameter sensitivity sweep (retrace 30/50/75pt × confluence tolerance 30/50/100pt × spread 0/10/15/20pt) is **negative in every single cell**. **The user reviewed this and chose to proceed anyway, trusting the friend's rules and opinion** — recorded here as a deliberate, informed override of this phase's own gate, not a silent pass. | Yes |
| 4 | **Implemented**: `AutonomousAiDecisionService` + `AutonomousGeminiProvider` + `validate-autonomous-ai-decision.ts` (`backend/src/autonomous/`) — an AI confirm/veto layer strictly on top of the mechanical engine's own candidates (never originates a trade), every numeric output independently re-validated. Verified against a real live Gemini call. See `AUTONOMOUS_RULE_ENGINE_SPEC.md` §4 for the full design | Yes |
| 5 | **Implemented, real result obtained.** Gemini's free daily quota proved exhausted at the Google Cloud project level (a new API key didn't help), so the AI decision layer now falls back to Groq then OpenRouter (`autonomous-ai-provider.factory.ts`) when Gemini is down — with a `max_tokens` fix (1024 was too low for these reasoning-model fallbacks, causing 100% truncated-JSON failures until raised to 4096) and Groq tried before OpenRouter (OpenRouter's free tier took 60-70+ seconds per call, Groq answered in a few seconds). Real comparison over 2.75 years of data: **AI-assisted: 36 trades (36/63 candidates confirmed, 19 vetoed), 44.44% win rate, profit factor 0.80, total P&L -720 points — vs. rules-only's -4,140 points / 31.15% win rate / profit factor 0.45 (Phase 3)**. The AI layer roughly halved the trade count and cut the loss ~6x, but the result is still net negative (profit factor below 1.0) — read as "the AI filters out a lot of the worst signals," not "the AI makes this profitable." Side-finding: the friend's own 249 real EURUSD trades with recorded SL/TP average ~123pt stop / ~244pt target (~1:2), not this rule's flat 180/180 (1:1) — worth confirming with him directly. See `AUTONOMOUS_RULE_ENGINE_SPEC.md` §4 | Yes |
| 6 | **End-to-end wiring complete, deliberately not turned on.** A genuinely separate demo MT5 account provisioned and wired in (`bootstrap.ts`), a dedicated Telegram bot wired in, the deterministic Risk Manager (`risk-manager.ts`) using REAL account/kill-switch/order-count data, the file-based kill switch (`kill-switch.ts`), the Python execution module (`collector/app/executor.py` — points-based SL/TP computed from the live price at the moment of each attempt, not a stale decision-time price; gated by a live `account_info().trade_mode` check on every call; retry-once-then-abort per plan §5), and the full backend↔collector loop (an atomic claim-on-poll endpoint, so an order can never be executed twice) — all tested (105+ backend + 91 collector tests). **Two things are deliberately still off**: no backend scheduler calls the decision pipeline automatically (a human runs `npm run evaluate-autonomous-rule`), and the collector's own execution step is behind an explicit `AUTONOMOUS_EXECUTION_ENABLED=false` default — turning either on is a decision for the user to make deliberately, not a side effect of this build. Still missing: the position-monitoring loop, the Telegram `/stop` and dashboard-button kill-switch paths, and the dashboard/Telegram-alerts UI. See `AUTONOMOUS_RULE_ENGINE_SPEC.md` §5 | Yes |
| 7 | 1-month demo test (§8) | Yes |
| 8 | Review + go/no-go decision on whether to continue, extend the demo, or stop | Yes |

---

## 13. Professional Opinion & Technology Recommendations

### 13.1 — My opinion on the project

**Is the friend's strategy sound and implementable as specified?** Mechanically, yes — it's a
fully specifiable, deterministic rule (compute last week's H4 high/low, trade the fade near those
levels, symmetric 180-point bracket, one trade/day). But "as specified" is doing some work: two
details in the friend's original description — whether "180 points" means broker points or pips,
and how close "near" a level has to be to count as a valid entry — are genuinely ambiguous and
change the strategy's risk/cost profile enormously (see §13.3, first two items). I'd treat
resolving those with the friend, in writing, with concrete price examples, as a blocking
prerequisite, not a nice-to-have. As a strategy family, a weekly-range fade at the prior week's
extremes is a well-known, fairly crowded retail concept (it's a variant of weekly-pivot fading) —
that doesn't make it wrong, but it means there's no obvious untapped edge here; whatever edge
exists is likely thin and highly sensitive to exact parameters and costs.

**Is an LLM-driven decision layer viable here, or would a pure rules-based bot be better?** For a
rule this fully specified, I'd lean toward a pure deterministic rule engine computing the actual
entry/SL/TP math, with the AI used only as an optional secondary layer that can *downgrade* a
rule-valid setup to `HOLD` for qualitative reasons a mechanical rule can't see (e.g., a valid
level-touch happening 10 minutes before an NFP release) — never as the thing computing prices.
This plan follows the brief's requested design (§3–4: AI proposes a full decision, risk manager
validates it) because that's what was asked for, and it's safe as designed since every number the
AI proposes is independently re-derived and checked against the raw feed before anything is sent
to the broker. But if I were choosing the design from scratch, I'd make the rule engine the sole
author of entry/SL/TP, and give the AI (and, separately, a hardcoded news-blackout window) veto
power only — cheaper, more reproducible, and removes an entire class of "the model quietly did
arithmetic wrong" failure modes.

**Realistic probability of profitability?** I don't think I can give an honest number here, and I'd
be doing the user a disservice by inventing one. What I can say: at most ~20 trades in a one-month
demo is not enough data to distinguish a real edge from noise for *any* strategy, so the honest
answer to "will it be profitable in demo" is *unknown, and not really knowable from this test
design alone* — the demo is much better suited to proving the system behaves correctly than to
proving the strategy has an edge. Whether it would ever be profitable in production is a separate,
harder question this plan doesn't attempt to answer, since it depends on real slippage, real
psychology, and a sample size an order of magnitude larger than one month can provide.

**What I'd change if I were the project lead:**
1. Get the points-vs-pips and "near the level" ambiguities (§13.3) resolved with the friend
   *before* writing the rule engine — everything downstream depends on getting this right.
2. Run the rules-only backtest (§7, Phase 3) before building the AI or execution layers at all. If
   it's not at least breakeven after realistic costs, stop there — that's a few days of Python
   against data this repo can already pull, versus weeks of pipeline engineering.
3. Use the replay-validation step (§7.5) against the friend's real 865 closed positions as a sanity check
   that the codified rule matches what the friend actually does, not just what the rule's English
   description literally says.
4. Keep the AI out of the entry/SL/TP price-math path; use it for narration and qualitative veto
   only (see above).
5. Frame the 1-month demo internally as a systems/ops shakedown (does the pipeline run reliably
   for a month, do the kill switches actually work, is the audit trail complete) rather than a
   profitability trial, and plan on a much longer demo window (3–6 months) before profitability is
   even a fair question to ask.

### 13.2 — Technology recommendations

| Layer | Recommended technology | Why |
|---|---|---|
| MT5 integration | Extend the existing `collector/app/mt5_client.py` (Python `MetaTrader5` package) | Already authenticated, already reading account/tick/candle data — extending beats standing up a second connection |
| Execution / order management | New `order_send` wrapper in the same collector process, orchestrated by BullMQ jobs from the NestJS backend (reused queue infra) | Keeps one MT5 session as the single source of truth for order state; reuses the job-queue pattern already proven in v1 |
| Risk manager | Plain TypeScript service in NestJS, same shape as `rules/evaluators` | Deterministic, unit-testable in isolation from the AI and from MT5 |
| AI decision layer | Reuse `ai/ai-provider.interface.ts` + Anthropic provider as primary, existing fallback-provider pattern for redundancy; extend `validate-ai-result.ts`/`safety-filter.ts` for the new decision schema; `temperature=0` | Reuses a provider abstraction and validation pattern that already exists and is already tested, rather than building a new one |
| Backtesting engine | Standalone Python script/notebook (pandas + a small event-driven loop, or `vectorbt`) reading `HistoricalCandle` data exported from Postgres | Deliberately kept out of the live NestJS backend so backtest iteration doesn't require touching production code paths |
| Data storage | Postgres via Prisma, new tables (`AutonomousDecision`, `AutonomousOrder`, `RiskManagerState`, `KillSwitchEvent`) kept separate from v1-style monitoring tables | Reuses proven infra; namespacing avoids any confusion between "trades we're watching" and "trades we placed" |
| Dashboard | Existing Next.js app, new `/autonomous` route | Avoids standing up and auth-ing a second frontend |
| Monitoring / alerting | Existing Telegram bot + existing 8-component health monitor, extended with a kill-switch status component and the friend's one-order-per-day flag | Direct reuse; the existing heartbeat/health-check design (`CollectorHeartbeat`) is exactly the right shape for "has the executor gone silent" detection |
| Deployment | Separate `docker-compose.autonomous.yml`, separate `.env`, separate Postgres DB/schema, separate Telegram bot token — and ideally **separate infrastructure entirely** from v1 (own VPS, or at minimum fully isolated containers/DB), not just a second compose file on the same box | The "never touch v1" requirement is best enforced by physical/resource separation, not just by code discipline |

### 13.3 — What's missing from the user's idea

**Update — the friend has since answered directly** (`AUTONOMOUS_RULE_ENGINE_SPEC.md` §2 has the
full detail and worked examples). Resolved: points-vs-pips (confirmed: points, with a worked
example), the entry mechanism (not a proximity tolerance at all — a touch-then-retrace-50pt
confirmation pattern, which also confirms the fade/bounce direction), and level-break handling
(confirmed: once broken, stop trading it, wait for the next opportunity — no mid-week
recalculation needed). His answers also surfaced two rules not in the original list at all: a
volatility filter (no entries if price moves >500pt within 1-2h) and a multi-timeframe confluence
filter (only trade an H4 level corroborated by a nearby D1 level). Two details are still this
project's own placeholder reconciliations, not his stated numbers: exactly how far past a level
counts as "broken" rather than a normal pre-bounce overshoot, and exactly how close the D1 level
needs to be for confluence — both currently default to 50 points, unconfirmed. The items below are
kept for the historical record of the original review; see the spec doc for the current state.

- ~~Direction — fade vs. breakout~~ — confirmed fade, see above.
- ~~Points vs. pips~~ — confirmed points, see above.
- ~~"At or near these levels" has no defined tolerance~~ — superseded by the touch-and-retrace
  model, see above.
- ~~The break/recalculation rule's exact semantics~~ — confirmed simpler than the original text
  suggested, see above.
- **Spread/slippage modeling** in the backtest — a zero-cost backtest will look far better than
  live results ever will. (Already modeled in the current backtest script via an assumed spread —
  see `AUTONOMOUS_RULE_ENGINE_SPEC.md` §3's result.)
- **Broker constraints**: minimum lot size and the freeze/stops level (minimum distance from
  current price a broker will accept for SL/TP) need real numbers from the specific demo broker
  before go-live (§4). Wide spreads around rollover/news are a cost and slippage factor to model
  in the backtest (§7), not something this plan hardcodes a rejection ceiling for — that would be
  exactly the kind of invented extra risk rule §4 deliberately avoids layering onto the friend's
  strategy.
- **What happens if a new valid setup appears while a position from a prior day is still open?**
  The friend's rules don't say. §4's working assumption — don't open a second position while one
  is open — is the simplest reading of "one order per day," but should be confirmed with the
  friend rather than left as an assumption baked silently into the rule engine.
- **Weekend gap handling**: price can gap straight through a level between Friday close and
  Sunday/Monday open, skipping the "approaching" entry window entirely. The plan's answer is: a
  missed trade is fine and expected; what must never happen is a stale pending order left over the
  weekend that fills badly at Monday's open — orders should be market-executed intraweek only, not
  queued as pending orders across the weekend.
- **Reproducibility of AI decisions**: `temperature=0`, and the exact prompt version pinned/hashed
  and logged with every decision, so a given day's decision can be exactly explained later — this
  is already noted in §3/§10 but is easy to lose track of during implementation.
- **Model cost**: likely small in absolute terms for this call volume (at most one evaluation
  cycle's worth of tokens per day of actual trading, plus periodic HOLD checks), but worth
  budgeting explicitly and picking a model/tier that won't hit rate limits mid-test — a free tier
  surviving a month of polling shouldn't be assumed without checking.
- **What happens if a level is already within the "near" band right at the start of the week?**
  Needs the friend's input: is that an immediately valid setup, or does the rule require price to
  visibly approach from outside the band first? This interacts directly with the tolerance
  question above.
- **Timezone/clock consistency**: MT5 server time, the broker's own time, and Beirut time can all
  differ and shift on different DST schedules. Every place this plan says "week boundary" or
  "trading hours," one single canonical clock must be chosen and used everywhere — mixing clocks
  between the rule engine and the risk manager is a realistic source of subtle bugs.
- **Windows-host uptime**: the MT5 terminal has to stay logged into the demo account 24/5 on a
  Windows machine, per the existing collector design — that machine's own uptime/monitoring is a
  dependency this plan hasn't separately budgeted for.
- **Idempotency of order placement**: a process restart or a decision-loop re-run must not
  double-submit the same day's order — reuse the same idempotent-ingestion mindset the existing
  collector already applies to data pushes, applied here to order submission (e.g., a per-trading-
  day idempotency key checked before every `order_send`).
- **A deterministic news blackout, not just an AI-visible calendar.** Feeding calendar events to
  the AI as context is good, but a hardcoded rule (e.g., no new entries within N minutes of a
  high-impact USD/EUR release) is safer than relying on the AI to always catch it.

### 13.4 — Realistic risk assessment

- **Single biggest risk**: an unresolved ambiguity (points vs. pips, or the "near" threshold)
  gets silently guessed at during implementation, and the system ends up faithfully, confidently
  trading a strategy that isn't actually the friend's rule — a "successful" demo month would then
  prove nothing about the friend's real edge, and a "failed" one would unfairly indict a strategy
  that was never actually tested.
- **Most likely failure mode**: not a dramatic loss, but a quiet infrastructure failure — an MT5
  disconnect, a Windows update rebooting the host, an expired demo session, or a hung process that
  silently stops evaluating setups (or, worse, stops monitoring an already-open position). This is
  exactly why the heartbeat/health-monitor reuse and the broker-side-SL/TP resilience property in
  §5 matter more than they might first appear to.
- **Cheapest way to fail fast**: the rules-only backtest (§7, Phase 3) — a few days of scripting
  against data this repo can already pull, run *before* any AI, execution, or dashboard code
  exists, versus weeks of pipeline engineering that would be wasted if the underlying rule isn't
  even breakeven after costs.

### 13.5 — Final recommendation

**Updated after the friend's answers and the rerun backtest: do not proceed to Phase 4.** The
friend directly answered the open questions (§13.3, `AUTONOMOUS_RULE_ENGINE_SPEC.md` §2), the rule
engine was rebuilt around his actual described logic, and the rules-only backtest was rerun against
2.75 years of real EURUSD data. The result is a clear fail of the go/no-go gate — negative P&L
across every cell of a parameter sensitivity sweep, not a marginal or ambiguous result. This is no
longer a "clarify and retest" situation; it's a "this specific mechanical codification doesn't have
a validated edge" situation. Two small implementation details remain this project's own
placeholder reconciliations (the "broken" overshoot threshold and the confluence tolerance,
§13.3), but the sensitivity sweep already varied both and found no combination that turns the
result positive, so re-guessing those two numbers differently is unlikely to change this
conclusion on its own.

**The one thing to do next**: share this result with the friend. Either he sees something in it
that suggests the mechanical codification still doesn't match his real trading (in which case more
worked examples, not more parameter tuning, are the right next step), or this specific rule
genuinely doesn't have the edge his discretionary trading might have — in which case the honest
outcome is to stop here rather than build the AI layer, execution module, or demo test on top of a
strategy that has now been tested and found unprofitable.

**The one thing to do first**: get those four clarifications from the friend, with concrete
worked examples, then run the rules-only backtest (Phase 3) using the now-implemented rule engine.
Don't write a line of AI, execution, or dashboard code before that backtest result exists and has
been reviewed with the user.

---

## What This System Is NOT

- Not a guarantee of profit, in demo or otherwise.
- Not a replacement for the friend's judgment — it is a rigid, literal codification of the rules
  as stated, nothing more.
- Not a market predictor, and not "smart money" or institutional-style analysis.
- Not tested with real money at any point covered by this plan.
- Not connected to, dependent on, or capable of modifying v1 in any way.
- Not currently a legal product that can be rented or sold to others as an investment service.
- Not immune to technology risk just because it has a kill switch — the kill switch reduces risk,
  it does not eliminate MT5 disconnects, VPS downtime, or API outages as real failure modes.
- Not validated, and not intended to ever be validated within this plan, for any symbol other than
  EURUSD.
