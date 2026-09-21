# XAUUSD M1 RSI — operations and recovery

Operating guide for `xauusd-m1-rsi-retest-extremes-v1`, the application's
single enabled entry strategy.

**Revision 2 (current).** Extreme SELL is 98.5. There are two independent
execution slots, so up to two positions can be open at once. XAUUSD is
observed once per second.

The rules themselves are in
[`backend/src/xauusd-rsi/XAUUSD_M1_RSI_RETEST_EXTREMES_V1_SPEC.md`](backend/src/xauusd-rsi/XAUUSD_M1_RSI_RETEST_EXTREMES_V1_SPEC.md),
which is frozen. This document is about running it.

---

## 0. The one thing to understand first

**This application runs only while you have started it by hand.** There is no
Windows service, no scheduled task, no autostart and no supervisor, by
explicit design.

The consequence is not cosmetic:

> **While the stack is stopped, nothing observes RSI, nothing enters, and the
> Friday pre-weekend liquidation does not run.**

If a position is open going into a Friday, the stack must be running **and**
connected to the broker before **23:00 Beirut** for the 23:30 deadline to be
met. If the laptop is asleep, the collector is down, or MT5 is disconnected,
local software cannot close anything, and no amount of code in this repository
changes that. Close the position by hand instead.

---

## 0b. Effective settings at a glance

| Setting | Value |
|---|---|
| Instrument / timeframe | XAUUSD, M1 |
| RSI | period 5, applied to Close (**verified** against the terminal's own `iRSI`, agreement to 5e-11) |
| Sell 2 / Sell 1 | 91 / 82 |
| Buy 1 / Buy 2 | 18 / 8.9 |
| Extreme SELL | **98.5** (triggering and rearming) |
| Extreme BUY | **1.5** (triggering and rearming) |
| Take profit / stop loss | $5 / $5 of gold price |
| Volume | 0.5 lot per order |
| Execution slots | `RETEST` and `EXTREME`, one entry each — **max 2 positions** |
| Magic numbers | 262610190 (RETEST), 262610191 (EXTREME) |
| Observation cadence | once per second |

### The two execution slots

| Slot | Setups |
|---|---|
| `RETEST` | SELL peak retest, BUY trough retest |
| `EXTREME` | Extreme SELL (>= 98.5), Extreme BUY (<= 1.5) |

- A retest position and an extreme position **may** be open at the same time.
- A second entry in the **same** family is refused while the first is
  unresolved — including an `UNKNOWN` submission, which holds its slot
  precisely because its outcome is not known.
- This is **not** one slot per directional setup: a SELL retest and a BUY
  retest compete for the same slot.
- Exposure the application cannot attribute to a slot — a foreign or manual
  position, or an unresolved submission from a retired strategy — still blocks
  **both** families.

**Broker requirement.** Two independent positions on one symbol exist only on
a hedging account. The application reads `account_info().margin_mode` and
refuses the second concurrent position unless it is `RETAIL_HEDGING`, rather
than emulating it with one net position. This account (MetaQuotes-Demo
5055783885) reports `RETAIL_HEDGING`, so both slots are usable here.

---

## 1. Starting, checking, stopping

```powershell
# start backend + collector + strategy watch (NOT the frontend)
powershell -ExecutionPolicy Bypass -File backend\scripts\start-xauusd-rsi.ps1

# read-only status: processes, ports, controls, watch state, retired processes
powershell -ExecutionPolicy Bypass -File backend\scripts\status-xauusd-rsi.ps1

# graceful stop, kill switch engaged first, positions reported not closed
powershell -ExecutionPolicy Bypass -File backend\scripts\stop-xauusd-rsi.ps1
```

The frontend is separate and manual: `npm run dev` in `frontend/`.

The start script refuses to run if anything conflicts — an untracked backend on
the port, a second watch process, or a retired strategy's scheduler still
running. It builds to `dist/` and runs the **compiled** output, never a
file-watching dev server.

### What to check after starting

1. `status-xauusd-rsi.ps1` shows all three components RUNNING.
2. The first ~20 lines of `.xauusd-rsi-runtime/logs/rsi-scheduler.log` show the
   mode, volume, brackets and state directory it actually resolved.
3. The dashboard at `/xauusd-rsi` shows **Warm-up: complete** and a fresh
   quote. Until warm-up completes, signals are observed and consumed but never
   emitted.

---

## 2. Configuration

| Where | Setting | Meaning |
|---|---|---|
| `backend/.env` | `XAUUSD_RSI_EXECUTION_MODE` | `OFF` (default), `SHADOW`, `DEMO`. Fails closed to OFF. |
| `backend/.env` | `AUTONOMOUS_TRADING_ACCOUNT_ID` | The one DEMO account to trade. |
| `backend/.env` | `XAUUSD_RSI_SCHEDULER_INTERVAL_SECONDS` | Watch cycle, default **1**. The strategy must evaluate at the observation cadence, not merely receive observations at it. |
| `collector/.env` | `XAUUSD_RSI_EXECUTION_ENABLED` | Must be `true` for the collector to run its one-second XAUUSD observation thread and poll for orders. Requires a collector restart. |
| `backend/.env` | `GOLD_TELEGRAM_CHAT_ID` | The owner's Telegram destination. |
| `backend/.env` | `GOLD_TELEGRAM_CHAT_IDS` | Additional destinations, comma separated, each `Label:id`. Added to the owner's, never replacing it. |

Both must be set. With the backend in `DEMO` but the collector flag `false`,
decisions are queued and never sent. With the collector flag `true` but the
backend `OFF`, nothing is ever queued to send.

### Controls that take effect immediately, without a restart

| File (under `backend/`) | Effect |
|---|---|
| `XAUUSD_RSI_KILL_SWITCH` | No new order is queued or sent. |
| `GOLD_KILL_SWITCH` | Same — the pre-existing gold switch is **honoured** by this strategy too. |
| `XAUUSD_RSI_STOP_NEW_ENTRIES` | No new entries. |
| `GOLD_STOP_NEW_ENTRIES` | Same, honoured. |

Creating any of these files stops new entries on the very next check. **None of
them disable protective closures, reconciliation, or the Friday liquidation of
owned positions** — that is deliberate, and it is why stopping entries is safe
to do at any time.

> A note on the current state of this repository: `backend/GOLD_KILL_SWITCH`
> **exists** and was engaged on 2026-09-16 by `stop-gold-demo.ps1`. Because
> this strategy honours it, **no entry will be submitted until it is removed.**

---

## 2b. One-second observation

XAUUSD is read **every second**, on a thread dedicated to it inside the
collector, and the strategy's watch loop evaluates at the same cadence. Both
halves are required: a one-second collector feeding a slower evaluator would
not deliver one-second reaction.

- The collector fetches **incremental ticks** since a cursor, so movement
  between polls is captured rather than only the instant each poll lands on.
- The cursor's boundary tick is never re-pushed, and an unchanged quote
  produces no synthetic observation — a poll having happened is not itself
  market information.
- A failed push does not advance the cursor, so nothing is silently lost.
- The main collector poll loop keeps its own interval, so unrelated EURUSD
  collection is unchanged.

**Cadence is measured, not assumed.** The dashboard reports the median, p95
and worst observed interval against the one-second target, and marks it
DEGRADED rather than quietly reporting the configured value. Check it after
starting:

```bash
# median / p95 / worst, plus how many cycles were measured
curl -s -H "Authorization: Bearer $DASHBOARD_API_TOKEN" \
  http://localhost:8420/research/xauusd-rsi-status | jq .observation.cadence
```

Honest limitation: an entry still has to pass through the backend queue and
the collector's order poll, which runs on the main loop. One-second detection
does not by itself mean one-second submission, and the decision's own
signal-age and price-deviation guards will refuse an entry that arrived too
late to still be the event the rules described.

---

## 3. The daily pause is NOT the Friday liquidation

These two are easy to confuse and behave completely differently.

|  | Daily entry pause | Friday liquidation |
|---|---|---|
| When | 23:30 → 01:00 Beirut, **every day** | Friday, from 23:00 Beirut |
| Affects | **New entries only** | **Open positions and pending orders** |
| Open position | **Stays open.** Neither boundary closes it. | **Must be closed** before 23:30 Beirut |
| Protection/reconciliation | Continues | Continues |
| After it ends | Entries resume at 01:00 | Entries stay disabled until the broker session is confirmed open again |

An ordinary weekday position opened at 22:00 may run through the pause, past
01:00, and for days afterwards. Only Friday forces a close.

---

## 4. Friday, in order

| Beirut time | What happens |
|---|---|
| before 23:00 | Entries allowed, subject to every other gate. |
| **23:00:00** | Entry cutoff. Strictly before 23:00 is allowed; at and after, nothing new is submitted. Queued-but-unsent decisions are cancelled at the pre-send check. Liquidation **starts now**, not at 23:29. |
| 23:00 → 23:30 | Close requests are submitted for owned positions and retried, bounded, until the broker confirms. |
| **23:30:00** | Deadline. Owned exposure must be gone. |
| after 23:30 | If anything remains, it becomes a durable `FAILED` liquidation row and a critical incident naming the remaining exposure. |

**Success requires broker evidence.** A submitted close request is never
treated as a closure. An item is only `CONFIRMED_CLEARED` once it has
disappeared from real broker-derived position data.

### Scope — what gets closed and what does not

- **Closed:** positions carrying this strategy's magic number (`262610190`),
  and positions carrying the retired H4 gold strategy's (`262610181`), because
  this application still owns and manages those.
- **Never closed:** anything else. A manual trade or another system's position
  is displayed separately, counted for the one-position occupancy rule, and
  left completely alone.

This is why the dashboard says *"owned exposure flat"* and never *"the account
is flat"*.

---

## 5. Recovery scenarios

### Starting up after the Friday cutoff, or during the weekend

Just start the stack normally. The watch process reconciles before it does
anything else:

1. Any `PENDING` decision it left behind is **retired** with an audit reason —
   it was never sent, and an intrabar signal is not valid to submit later.
2. Any `SENT` or `UNKNOWN` decision is matched against real broker positions.
   A match becomes `FILLED`. **No match does not become `FAILED`** — it stays
   `UNKNOWN`, because the order may have filled and already closed. Entries
   stay blocked until an operator resolves it.
3. If owned exposure remains and the deadline has passed, liquidation resumes
   immediately and the miss is reported.

Nothing depends on a scheduled callback having fired while the machine was off.

### An `UNKNOWN` decision is blocking entries

This is deliberate: the application will not guess. Resolve it against the
broker's own deal history in MT5:

- **It did fill** → the position will appear in the next collector snapshot and
  reconciliation will mark it `FILLED` on the next start.
- **It never filled** → mark that decision resolved in the database, after
  confirming in the terminal. Do not guess from the absence of a position.

### The Friday deadline was missed

1. `status-xauusd-rsi.ps1` and the dashboard both show
   `FRIDAY_CLOSURE_DEADLINE_MISSED` with the remaining tickets named.
2. A critical Telegram incident was raised on the gold channel.
3. **Close the remaining position manually in MT5**, if the market is still
   open. If it is closed, the exposure carries over the weekend — that is the
   real outcome, and the application reports it rather than papering over it.
4. Entries stay disabled until the broker session is confirmed open again.

The application never reports success it cannot prove, and never assumes a
position disappeared.

### The watch process will not start: "another watch process holds the lock"

Two watch processes would both claim decisions and could both submit, so
starting a second is refused.

1. Run `status-xauusd-rsi.ps1` and confirm no watch process is actually
   running.
2. Only then delete `backend/xauusd-rsi-runtime/xauusd-rsi-watch.lock`.
3. The lock also goes stale on its own after 15 minutes.

### The watch process will not start: spec hash mismatch

The persisted state was written under different rules. This is refused rather
than migrated, because reinterpreting old state under new thresholds produces
decisions no audit can explain.

Archive `backend/xauusd-rsi-runtime/` and start fresh. Warm-up runs again.

### A data gap or a restart

Pattern state is discarded across any gap longer than 90 seconds — a peak whose
pullback happened unobserved is not a peak this strategy may trade. The
**indicator is not** discarded: RSI carries across session breaks exactly as
MetaTrader's does, so Monday morning agrees with the terminal.

---

## 6. Ownership and history

Nothing in this migration deleted trading history. `trades`,
`autonomous_decisions`, `trend_breakout_decisions` and every migration are
intact. The retired strategies' code remains readable; only their ability to
generate or submit an entry was removed.

| Magic | Owner | Protective distance | Can it enter? |
|---|---|---|---|
| `262610190` | **Active** RSI strategy, RETEST slot | $5 / $5 | Yes |
| `262610191` | **Active** RSI strategy, EXTREME slot | $5 / $5 | Yes |
| `262610181` | Retired H4 confirmed-retest gold | **$10 / $10, unchanged** | No |
| `262610180` | Retired legacy EURUSD autonomous | n/a | No |
| anything else | Foreign / manual | Never modified | No |

An old position is never adopted, never relabelled, and never re-protected at
the new strategy's $5.

To inspect all of this at any time, read-only:

```bash
cd backend && npm run xauusd-rsi:migrate
```

---

## 6b. Telegram recipients

Notifications go to every configured recipient, with **one delivery record
each**. A retry re-sends only the recipient that failed, and one recipient's
success never hides another's failure.

Verify the audience, and optionally send a labelled test:

```bash
cd backend
npm run xauusd-rsi:telegram-test             # verify only, sends nothing
npm run xauusd-rsi:telegram-test -- --send   # verify, then send one test each
```

The verification step calls Telegram's own `getChat` for every destination
before anything is sent. If a recipient fails, the usual cause is that the
person has never started a conversation with the bot — a bot cannot message
someone who has not pressed Start. The error names the chat and says so.

The test message is clearly labelled as a delivery test, reports the actual
current execution state, and goes out through a dedicated event type so its
audit record can never be mistaken for a trading notification. It creates no
trade, position, signal or incident.

API acceptance confirms Telegram accepted the message. It does not confirm
anyone read it.

---

## 6c. Quote freshness, and why cadence is not freshness

**Processing cadence and quote age are different numbers and are reported
separately.** A one-second loop guarantees a one-second *read*, never a
one-second-old *market price*. If the broker sends no tick for ten seconds,
the newest quote is ten seconds old no matter how often it is read. A
reported quote age larger than the cadence is normal and is not a fault.

The configured limit is **30 seconds** (`observation.maxStalenessMs` in the
frozen spec). It is enforced at three points, each of which can refuse:

| Point | What it checks |
|---|---|
| Detection (`engine.ts`) | The observation's own age against wall clock; a stale one is consumed and logged, never queued |
| Backend pre-send (`decision.service.ts`) | The quote's age against wall clock, before anything else uses its timestamp |
| **Send boundary** (`collector/app/executor.py`) | A **newly fetched** MT5 tick's age, immediately before `order_send`, on every attempt including the retry |

The send boundary is the one that cannot be skipped or approximated. The
backend approves against the quote it was last pushed; the order then travels
to the collector, which reads MT5 directly. `symbol_info_tick` returns the
last tick the terminal ever saw, so a halted feed yields a brand-new read of
a very old price — a fresh read is not a fresh quote. An expired quote there
drops the order. It is never repriced to make it sendable.

Re-reading or re-ingesting a tick never refreshes it. `live_ticks.tick_at`
carries the broker's own timestamp through ingest unchanged (only
`updated_at` moves), and the collector's age is derived from the tick's own
timestamp rather than from when it was read, so a frozen feed only ever gets
staler.

**Timestamps use one conversion, applied once.** MT5 reports times as an
epoch built from the broker server's wall-clock components (EET/EEST), not
true UTC. The collector converts with `_mt5_time_to_utc`; the backend's RSI
path converts stored tick and candle times at the read boundary via
`src/xauusd-rsi/tick-time.ts`, reusing the same conversion the research layer
uses. A quote that decodes to the future is refused rather than treated as
very fresh, because that is the signature of the offset being applied twice
or not at all.

---

## 7. Historical evaluation is archived, not operational

Historical evaluation, backtesting, trade simulation and historical
win-rate or profitability analysis are **out of scope**. Nothing in normal
operation runs them, and no simulated figure is an activation criterion.

The material produced before the scope narrowed now lives in
`backend/research-archive/xauusd-rsi/`, with a README stating plainly what it
is. The evaluation script there is no longer exposed as an npm script.

Two figures have circulated and must not be misread: **+$513.50** and a
**$4,500** maximum drawdown. Both are simulation output over stored candles.
Neither is a DEMO result, a realised P&L, or a broker balance. Real
performance is whatever the live account and the recorded decision, fill and
closure rows say it is.

The strategy's rules are fixed by
`backend/src/xauusd-rsi/XAUUSD_M1_RSI_RETEST_EXTREMES_V1_SPEC.md` and are not
adjusted on the basis of any simulated result.

Broker-history queries remain in use where reconciliation needs them —
matching recorded decisions against actual orders, positions, fills and
closures. That is operational reconciliation, not evaluation, and it stays.

---

## 8. Warm-up history

RSI(5) cannot be computed from nothing, so the watch loop seeds the indicator
from stored closed M1 bars before it observes anything live. The amount is
fixed by the specification: **period 5 + 1 + 250 warm-up bars = 256**
contiguous closed M1 bars, and only the most recent *contiguous* run is used,
so a gap is never bridged.

That history initialises the indicator and nothing else:

- The seeding path applies closed bars only. `applyClosedBar` emits no
  signals at all, so no historical bar can become a live entry.
- Pattern state is not built from the seed. `previousRsi` is still `null`
  when live observation begins, and every crossing and retest test requires a
  previous *live* reading. An already-extreme first reading therefore cannot
  produce a startup order; the strategy must watch an actual live crossing.
- Until the full 256 bars are in place, signals are suppressed and logged
  rather than queued.

### How long warm-up takes, and how to know

**Read the counter, do not predict from a formula.** The dashboard reports
`indicator.closedBarsApplied` against `indicator.warmupBarsRequired`, and
that counter is the only authoritative answer. Any stated completion time is
an **approximation derived from the current counter** — remaining bars times
one minute — and it drifts whenever the feed gaps, the market is thin, or
candle sync falls behind. Treat it as an estimate, never as a schedule.

Warm-up is only slow when there genuinely is not enough recent contiguous
history. The worst case is a weekend or a long outage: the contiguous run
restarts at the session open, so shortly after a Sunday open there may be
only a couple of hundred bars and the remainder has to accumulate in real
time. Mid-session, with history already present, warm-up is effectively
immediate.

### Starting up elsewhere, including a server deployment

**A new deployment does not automatically owe you a 256-minute wait.** There
are three initialisation routes, and only the third is slow:

1. **Valid persisted state.** `RsiWatchStore.load` returns the persisted
   engine untouched — recursive average, bar count and clock intact — and
   only re-arms recovery. A restart that carries its state directory across
   resumes warm, with no re-warm at all. State is rebuilt only when it is
   invalid or incompatible: a different `SPEC_HASH` refuses outright, an
   unreadable file refuses rather than silently cold-starting, and the watch
   cycle rebuilds only if the engine clock is more than two minutes ahead of
   wall clock or the cursor carries an older time basis.
2. **Available recent bars.** With no usable state file, the indicator seeds
   from whatever contiguous closed M1 history the database already holds. If
   256 contiguous bars are present, warm-up completes on the first cycle.
   This is the ordinary case for a host whose collector has been storing
   candles, and it is why a fresh process usually starts warm.
3. **Accumulating live.** Only when neither of the above supplies 256
   contiguous bars does the strategy wait for the market to produce them.

In every route, the history initialises the indicator and nothing else. No
historical bar is ever executed: `applyClosedBar` emits no signals, seeding
leaves `previousRsi` null, and the first live reading cannot itself complete
a crossing. Warming up is never a source of orders.


---

## 9. Known issues

### Intermittent Postgres connection failure during the full test suite — UNRESOLVED

During long full-suite runs, an occasional test fails with:

```
Can't reach database server at `127.0.0.1:5444`
```

**This is recorded as an open test-infrastructure failure, not a resolved
one.** What is established: it is a connection failure rather than an
assertion failure, so the test never reaches its assertion; it strikes a
different, unrelated file each time it appears (`health-check-resilience`,
`rules/technical-analysis-integration`, `rules/rule-engine`), never the
XAUUSD RSI suites; and a full run has completed with 1613/1613 passing and
zero failures, so it is not deterministic. The container reports `restarts=0`
and `OOMKilled=false`.

Observed frequency across four full runs of the same commit range: one run
clean at 1613/1613; one with a single failure; one with two. Affected files
so far: `health-check-resilience`, `rules/technical-analysis-integration`,
`rules/rule-engine`, `ai/ai-pipeline`.

**What is NOT established: the cause.** It has not been reproduced
deliberately, and no mechanism has been confirmed. Connection-pool
exhaustion under load, a Docker port-forward hiccup and a client-side
timeout all remain open possibilities.

Measured at idle, which neither confirms nor rules anything out:
`max_connections` is 100 with 6 in use, and the container has no memory
limit, no restarts and no OOM kill. The untested hypothesis worth trying
first is connection accumulation across the run — the suite has 175 files
and each creates its own `PrismaClient`, so the interesting measurement is
`pg_stat_activity` sampled *during* a full run rather than at rest. Nobody
has taken that measurement yet.

**A separate finding does NOT explain it.** The test container's Docker
healthcheck runs `pg_isready -U autonomous_trading` without `-d`, so it
defaults the database name to the username while the actual database is
`autonomous_trading_test`. That produces a `FATAL: database
"autonomous_trading" does not exist` line every three seconds. It accounts
for the **log noise only**. `pg_isready` still finds the server reachable,
those connections are rejected at authentication and hold no resources, and
nothing links them to the dropped connections. Do not treat the healthcheck
as the explanation.

**Strongest lead so far (2026-09-21): Docker Desktop on the Windows
development machine.** A full-suite run failed with this error while
`docker ps` reported the daemon itself unreachable, and both test containers
were found `Exited (0)` — a clean stop, not a crash, consistent with Docker
Desktop shutting down or restarting underneath the run rather than with
anything Postgres did. Starting the containers again made the same tests pass
immediately. That fits every observation recorded above: a connection failure
rather than an assertion failure, striking whichever file happened to be
running, with no pattern in the code. It is a lead, not a conclusion — nobody
has yet correlated a failure with a Docker Desktop restart in its logs.

This affects the development machine only. The server runs Docker Engine on
Linux, where this failure mode has not been seen.

Anyone touching this should reproduce it deliberately before claiming a fix.

---

## 10. Deploying to a server

Nothing here has been pushed or deployed. This section records what a
deployment actually requires, so the constraints are written down before
anyone acts on them.

### The MT5 terminal has to be where the collector is

The collector does not talk to a broker API over the network. It imports the
`MetaTrader5` Python package, which drives a **locally installed, running,
logged-in MT5 terminal through that terminal's own process on the same
machine**. There is no remote mode. Consequences:

- The server must run Windows (or a working Wine/MT5 arrangement), with the
  terminal installed, logged in to the DEMO account, and left running.
- The terminal must keep XAUUSD selected in Market Watch. `symbol_info_tick`
  returns a stale cached tick for a symbol the calling session has not kept
  selected — already investigated and documented in `mt5_client.py`.
- The MQL5 parity script and its exported reference CSV live under the
  terminal's own data directory, so a new host produces its own copy rather
  than inheriting this machine's.
- If the terminal is closed, sleeps, or logs out, the collector reads
  nothing. Because a failed position read now refuses rather than reporting
  an empty list, that degrades into "no snapshot" rather than into positions
  being wrongly marked closed.

### Exactly one execution against one account

**Two copies of this strategy must never run against the same MT5 account.**
Both would poll for pending orders, both could claim and submit, and the
two-slot reservation cannot arbitrate across machines — the partial unique
index protects one database, not one broker account.

What exists today protects a single host only:

- A lock file at `backend/xauusd-rsi-runtime/xauusd-rsi-watch.lock`, holding
  the pid and a heartbeat, refuses a second watch process on that machine.
- `start-xauusd-rsi.ps1` refuses to start when it finds an untracked
  collector for this repository already running.

Neither of these crosses machines. Before starting on a server, stop the
local stack (`stop-xauusd-rsi.ps1`, which engages the kill switch first), and
confirm with `status-xauusd-rsi.ps1` that backend, collector and watch are
all down. Running both would not be caught automatically.

The separate version 1 VPS deployment is out of scope: do not modify its
processes, configuration, databases, credentials or Telegram routing. It uses
its own account and must keep doing so.

### Checklist

1. Apply migrations — `npx prisma migrate deploy`. The 34th,
   `20260921010000_rsi_ticket_bigint`, is required: without it an 11-digit
   broker ticket cannot be recorded at all.
2. Provide the environment: `DATABASE_URL`, `AUTONOMOUS_TRADING_ACCOUNT_ID`,
   `XAUUSD_RSI_EXECUTION_MODE=DEMO`, `XAUUSD_RSI_SCHEDULER_INTERVAL_SECONDS=1`,
   `MT5_BROKER_TIMEZONE=EET`, and the Telegram bot token and chat ids. Keep
   all of them out of the repository.
3. Carry over `backend/xauusd-rsi-runtime/settings.json` to keep 0.5 lot an
   explicitly recorded setting rather than a fallback, or re-save it through
   the volume endpoint so it carries its own audit entry.
4. Start with `XAUUSD_RSI_KILL_SWITCH` engaged, verify, then remove only
   that file.
5. Verify on the server exactly as §0b and §2b describe: DEMO and hedging
   mode, effective thresholds and volume, measured cadence and quote age
   reported separately, warm-up counter, slot state against real broker
   exposure, and schedule enforcement.
