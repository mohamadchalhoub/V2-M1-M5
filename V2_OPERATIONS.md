# xauusd-m1-m5-rsi-threshold-v2 — operations

Everything an operator needs to run, inspect, recover and eventually activate
this application. The rules themselves live in the frozen specification,
[`backend/src/xauusd-m1m5/XAUUSD_M1_M5_RSI_THRESHOLD_V2_SPEC.md`](backend/src/xauusd-m1m5/XAUUSD_M1_M5_RSI_THRESHOLD_V2_SPEC.md).

> **Execution is OFF.** This application has never placed an order and cannot
> place one until the setup in [Remaining setup](#remaining-setup) is
> complete. Nothing in this document should be read as a claim that it is
> running or verified against a broker.

---

## Source provenance

| | |
|---|---|
| Ultimate source | `trading-monitor-autonomous`, commit `bf083c8` |
| This repository's initial commit | `4103332` — *Start from trading-monitor-autonomous at bf083c8* |
| Git remote | none — this repository is local only |

Full detail, including what was excluded from the copy and why, is in
[`PROVENANCE.md`](PROVENANCE.md).

## Resource isolation mapping

Three generations of this codebase exist on this machine. **Two of them are
running and must not be touched.** Every resource below is dedicated to this
application.

| Resource | Legacy deployment | M1 revision-5 bot (running) | **This application** |
|---|---|---|---|
| Compose project | — | `autonomous-trading` | `trading-monitor-m1m5-v2` |
| Dev Postgres | `trading-monitor-postgres` :5433 | `autonomous-trading-postgres` :5443 | `m1m5-v2-postgres` :5453 |
| Dev Redis | `trading-monitor-redis` :6380 | `autonomous-trading-redis` :6480 | `m1m5-v2-redis` :6490 |
| Test Postgres | — | `autonomous-trading-postgres-test` :5444 | `m1m5-v2-postgres-test` :5454 |
| Test Redis | — | `autonomous-trading-redis-test` :6481 | `m1m5-v2-redis-test` :6491 |
| DB user / database | `trading_monitor` | `autonomous_trading` | `m1m5_v2` (test `m1m5_v2_test`) |
| Named volumes | `backend_trading_monitor_*` | `autonomous_trading_*` | `m1m5_v2_*` |
| Backend API port | 8410 | 8420 | **8430** |
| Prod compose project | — | `autonomous-trading` | `trading-monitor-m1m5-v2-prod` |
| Magic numbers | 262610180 | 262610181, 262610190, 262610191 | **262610200 (M1), 262610201 (M5)** |
| MT5 terminal / Wine prefix | its own | its own | **still to provision** |
| DEMO account | its own | its own | its own (MetaQuotes-Demo, Forex Hedged USD); login in `collector/.env.production` |
| Telegram bot | its own | its own | **@M1M5Trade_bot** (id 8736831653) |
| Telegram chat | its own | its own | 7434107396, delivery verified |
| Collector token | its own | its own | minted against this project's backend |

The magic-number split is asserted at startup by
`assertMagicNumbersAreDisjoint()`, which refuses to start on a collision
rather than trading into one.

### Why the compose project name matters

Docker Compose derives its project identity from the current directory's
**basename**, not its full path. Several sibling checkouts here each have a
`backend/` directory, so without an explicit `name:` they would share one
project and adopt each other's containers. This copy inherited the source
project's identity verbatim; running it unchanged would have recreated the
running bot's live containers, and `npm run test:db:down` (`docker compose
down -v`) would have destroyed that project's test containers and volumes.

`backend/test/global-setup.ts` additionally refuses to run migrations unless
`DATABASE_URL` names `m1m5_v2_test`. **Widening that check is never the right
fix for a connection error.**

## The strategy in one screen

- **XAUUSD only**, two independent execution paths: **M1** and **M5**.
- **SELL** when `previous RSI < 91` and `current RSI >= 91`.
- **BUY** when `previous RSI > 8.9` and `current RSI <= 8.9`.
- RSI(5), PRICE_CLOSE, Wilder, computed independently per timeframe, compared
  at full precision, evaluated intrabar.
- **One exposure per timeframe**, so at most two positions at once.
- After a **SELL** loss on a timeframe, that timeframe's SELL is locked until
  `RSI <= 25` or `RSI >= 98.5`.
- After a **BUY** loss on a timeframe, that timeframe's BUY is locked until
  `RSI >= 75` or `RSI <= 1.5`.
- **Unlocking is never an entry.** A fresh normal crossing is required
  afterwards.
- **0.5 lot**, TP and SL each **$5.00** of gold price.
- Entry pauses **23:30–01:00** and **14:00–19:00** Beirut, daily, both
  timeframes. Friday cutoff 23:00, liquidation from 23:00, flat before 23:30.

**98.5 and 1.5 are post-loss unlock thresholds only.** They have no standalone
entry meaning anywhere in this strategy, and no surface may present them as
entry levels.

## Running it

Startup is **manual only**. No Windows startup task, reboot autostart or
unattended supervisor is installed, and none may be added without explicit
authorization.

```bash
# 1. This application's own containers. Run from backend/.
cd backend
docker compose up -d --wait

# 2. Schema. Applies only to this application's database.
npx prisma migrate deploy

# 3. Build, then run the compiled output — never claim new code is live
#    while an old build is running.
npm run build
npm start
```

Verify which project the compose commands resolve to before the first run:

```bash
docker compose config --format json | head -3     # expect trading-monitor-m1m5-v2
docker compose ps                                  # expect only m1m5-v2-* containers
```

### Tests

```bash
# Rule set only — no database, no broker, no clock. Runs anywhere.
npx vitest run --config vitest.v2-pure.config.ts

# Full suite, against this application's disposable test database.
npm test
```

`npm test` starts `m1m5-v2-postgres-test` and `m1m5-v2-redis-test`. It cannot
reach any other project's database: the guard in `test/global-setup.ts` fails
closed on the database name.

## Controls

Entry pauses and kill switches block **new entries only**. They never disable
reconciliation, protective management or Friday liquidation — an open position
must still be protected and still be closed on a Friday regardless of whether
new entries are permitted.

## Recovery

On startup or reconnect the application warms its indicators from closed
historical bars **without producing entries**, re-establishes continuity,
reconciles decisions and exposure against the broker, and preserves all four
post-loss locks.

State is refused rather than migrated in two cases, both of which rebuild from
history instead of continuing on a wrong basis:

- the persisted **spec hash** does not match the current rules, so arming and
  continuity decisions recorded under different rules cannot be reinterpreted;
- the persisted **clock is implausibly ahead** of wall clock, which would
  otherwise reject every incoming tick as out-of-order and freeze RSI while
  the loop still reported a healthy cadence.

A restart never clears a lock, never invents an unlock, and never adopts a
position it did not open.

## What this copy has disabled

Every earlier entry route is switched off **here only**, in code rather than
by configuration, so no environment value can start a second strategy trading
on this application's account:

| Disabled entry route | Gate |
|---|---|
| XAUUSD M1 RSI retest + standalone extremes | `getRsiExecutionMode()` → `OFF` |
| XAUUSD H4 confirmed-retest gold | `getGoldExecutionMode()` → `OFF` |
| H4-trend / H1-breakout, both instruments | `getTrendBreakoutExecutionMode()` → `OFF` |
| Legacy EURUSD autonomous rule engine | no enabled entry path in this copy |
| AI-assisted trading approval or veto | informational only; never gates execution |

Setting `XAUUSD_RSI_EXECUTION_MODE=DEMO` in this project has **no effect**.
The rationale, and what deliberately remains enabled, is in
[`backend/src/xauusd-m1m5/legacy-entries-disabled.ts`](backend/src/xauusd-m1m5/legacy-entries-disabled.ts).

No code, table or historical row was deleted. The separate deployment of the
M1 revision-5 bot runs from its own checkout and is unaffected.

### Consequence for the retired strategy's own test suites

`test/xauusd-rsi/execution-e2e.spec.ts` and `test/xauusd-rsi/two-slot.spec.ts`
exercise the retired strategy's entry pipeline end to end, setting
`XAUUSD_RSI_EXECUTION_MODE=DEMO` and asserting that orders are queued. That
pipeline is deliberately dead in this copy, so those assertions no longer
hold. This is the intended behaviour of §2, not a regression.

Measured, not assumed: with the gate temporarily reverted both files pass
41/41; with it in place 26 of those 41 fail, every one of them on "no order
was queued". No other suite in the repository is affected — the three mode
getters are imported only by `gold-execution/`, `trend-breakout/` and
`xauusd-rsi/`.

Both files are therefore **excluded** in `vitest.config.ts`, with that
reasoning recorded at the exclusion. They are not deleted: the retired
strategy's code, tests and history stay readable, which is also what §1
requires. The replacement is
`test/xauusd-m1m5/legacy-entries-disabled.spec.ts`, which asserts the
property that actually matters — that no legacy gate can reach an active mode
whatever the environment says.

Re-enabling one of those strategies means editing its mode getter, and the
exclusion should be removed in the same change.

## Remaining setup

Execution stays OFF until every item below is done and verified.

### Done

- **A dedicated DEMO account** on MetaQuotes-Demo, opened specifically for this
  application. Account type **Forex Hedged USD**, which is what makes
  simultaneous independent M1 and M5 positions possible at all. Credentials
  live in `collector/.env` (gitignored); the master password is used for
  trading and the investor password is deliberately not stored, since it
  cannot place orders.
- **Telegram**: `@M1M5Trade_bot` (id 8736831653), a different bot from the one
  the existing system uses, so that bot's routing is untouched. Chat
  7434107396, confirmed by an actually delivered message.
- **Collector credentials** minted against this project's own backend, bound
  to this account. Never reuse the other project's.
- **Database**: all 36 migrations applied to `m1m5_v2` on port 5453.

- **A dedicated MT5 terminal installation and Wine prefix**, at
  `/home/deploy/.mt5-m1m5-v2` on the VPS, verified distinct from `.mt5` and
  `.mt5-v2`. `MT5_TERMINAL_PATH` is set explicitly so this collector can never
  auto-discover another bot's terminal.
- **Runtime MT5 verification passing**, on 2026-09-22, against the live
  terminal. All 17 checks green, including the one that mattered most:
  `margin_mode=2` (**RETAIL_HEDGING**) as MT5 itself reports it, not as the
  signup screen labels it. Independent simultaneous M1 and M5 positions are
  therefore genuinely possible on this account. See `V2_MT5_RUNTIME.md` for
  every verified value.

### Still required

1. **A SHADOW soak.** SHADOW runs every gate and records every decision
   exactly as a live run would, and queues nothing. A session or two in SHADOW
   shows what would have been traded, at no risk, and is the cheapest way to
   find a disagreement between intent and behaviour.
2. **Enable execution**, only after the checklist below passes: set
   `XAUUSD_M1M5_EXECUTION_MODE=DEMO` in `backend/.env` AND
   `XAUUSD_M1M5_EXECUTION_ENABLED=true` in `collector/.env`. Both are required;
   with only one set, nothing is ever sent.

### Pre-activation checklist (§14)

- [ ] Resource isolation verified against the mapping above
- [ ] Migrations applied to **this** database only
- [ ] Separate DEMO account confirmed, and confirmed to be a DEMO account
- [ ] Terminal and account permissions confirmed through this application's
      own collector: connected, `trade_allowed`, `tradeapi_disabled`,
      account `trade_allowed`, account `trade_expert`
- [ ] Hedging compatibility confirmed
- [ ] Magic numbers 262610200 / 262610201 confirmed unused on the account
- [ ] Exactly one execution instance running
- [ ] Old entry paths confirmed disabled here
- [ ] M1/M5 state and occupancy isolation confirmed
- [ ] Schedule and controls confirmed, including both daily pauses
- [ ] Running build confirmed to match the intended commit

Fresh market quotes are **not** evidence of permission to trade. A missing or
disabled permission is an explicit execution blocker.

## How an order actually reaches the broker

The backend cannot talk to MetaTrader. The terminal lives inside the
collector's container, behind a poll, so every instruction to the broker is a
durable row the collector claims and reports back on. Four separate queues,
deliberately not one table with a `kind` column:

| Queue | Table | What it does |
|---|---|---|
| Entries | `xauusd_m1m5_decisions` at `PENDING` | places an approved order |
| Closes | `xauusd_m1m5_close_requests` | closes a position this strategy owns |
| Protection repairs | `xauusd_m1m5_protection_requests` | re-attaches a missing SL/TP |
| Permissions | `xauusd_m1m5_mt5_snapshots` | what the terminal says it may do |

Closes and protection repairs are separate tables on purpose. They are
superficially the same shape — a ticket, a poll, a result — and exactly one
mis-taken branch away from a repair that *closes* the position it meant to
protect. Separate tables make that mistake unwriteable rather than merely
unlikely.

Every claim is an `updateMany` guarded on the row still being `PENDING`, so two
collectors polling the same instant cannot both act on it.

### Three outcomes, never two

A broker answer is `FILLED`, `FAILED`, or **`UNKNOWN`** — and the third is not
a variant of the second. An ambiguous or lost response may be a live position,
so the timeframe slot **stays held** until reconciliation sees real broker
state. Collapsing UNKNOWN into FAILED would free the slot and let the next
signal open a second position on a timeframe that already has one.

### What runs regardless of execution mode

Friday liquidation, reconciliation and protection remediation run whether
execution is ON or OFF. A position that is already open does not stop needing
to be flat before the weekend because entries were switched off.

That is also why the way to stop new entries is the **kill switch**, not the
collector's execution flag: the kill switch blocks entries while leaving
protective management running, whereas turning the collector flag off leaves an
open position unmanaged, including through a Friday.

### Recovery is a gate, not a formality

`recoveryComplete` starts false and only becomes true after a reconciliation
pass has actually run against fresh broker state. Until then the loop observes
and refuses to enter, retrying each cycle. A snapshot older than 60 seconds is
treated as incomplete, because "this position is missing" and "the collector
has not reported recently" look identical otherwise — and concluding closure
from stale data would record a phantom loss, fire a post-loss lock, and free a
slot that still holds a live position.

## Execution latency

The collector evaluates queued V2 orders **every second**, inside its
one-second loop. Previously it did so once per ten-second main-loop cycle, and
the first real trade waited 22.5 s between being queued and being sent.

Every order records four instants and three latencies, on the decision row, in
the FILLED Telegram message and on the dashboard:

| Instant | Recorded by |
|---|---|
| `detectedAt`: the scheduler's cycle formed the crossing | backend |
| `executionEvaluatedAt`: the final pre-send checks began | collector |
| `submittedAt`: immediately before `order_send` | collector |
| `acknowledgedAt`: `order_send` returned | collector |

| Latency | Whose |
|---|---|
| detection -> submission | **ours**: scheduling, queueing, checks |
| submission -> fill | **the broker's and the network's** |
| signal -> fill | the total |

The one-second cadence bounds only the first. **It does not make the broker
fill in a second**, and nothing here claims so.

### What still runs at send time

Faster evaluation changes none of the safeguards. At queue time the backend
runs the full pre-send check; at claim time it re-checks schedule, controls and
**signal age**; at send time the collector re-checks **signal age** and **entry
drift** against the terminal's own live price, using limits sent with the order
so there is one definition of each. The executor's quote-age gate, DEMO check
and MT5 slippage limit are unchanged.

### One crossing, at most one order

- The crossing's identity is a unique constraint: evaluating it again, even
  concurrently, returns `SKIPPED_DUPLICATE` and never reaches the broker.
- The claim is an atomic guarded update: a queued order is handed out once.
- The collector takes the MT5 lock **before** claiming, so it never claims an
  order it cannot place, and no two passes execute at once.
- A result that may be a live position, including an exception during the
  broker call, is **UNKNOWN** and keeps its slot. Only a refusal *before*
  `order_send` is reported as not sent, and only that frees the slot.

