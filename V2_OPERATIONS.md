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
| MT5 terminal / Wine prefix | its own | its own | **not yet provisioned** |
| DEMO account | its own | its own | **not yet provisioned** |
| Telegram bot / chats | its own | its own | **not yet provisioned** |

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
hold. This is the intended behaviour of §2, not a regression — and
`test/xauusd-m1m5/legacy-entries-disabled.spec.ts` asserts the replacement
property directly: that no legacy gate can reach an active mode whatever the
environment says.

## Remaining setup

None of these can be completed from this machine without credentials, and
**execution stays OFF until every one is done and verified**.

1. **A dedicated MT5 DEMO account** for this application, with its own
   terminal installation and Wine prefix. The running bot's terminal must not
   be switched to it.
2. **Collector credentials** bound to that account — `COLLECTOR_API_KEY` and
   `COLLECTOR_ACCOUNT_ID` from `npm run bootstrap` in this project.
3. **A Telegram bot token and chat ids** for this application. The existing
   bot's routing must not be modified.
4. **A dashboard hostname** distinct from the existing bot's.
5. **Confirmation that the broker account supports hedging**
   (`RETAIL_HEDGING`). Without it, independent simultaneous M1 and M5
   positions are not possible, and that is a structural blocker on the core
   design rather than a configuration detail — netting or unknown
   compatibility must be reported explicitly, never silently emulated.
6. **A real `.env`** for this project, built from `backend/.env.example`,
   pointing at port 5453 / 6490 and the new account.

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
