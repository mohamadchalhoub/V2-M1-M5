# xauusd-m1-m5-rsi-threshold-v2 — MT5 runtime

How this application gets its own MetaTrader 5 terminal on a VPS that already
runs other trading bots, and why the design is what it is.

> **Execution is OFF.** Nothing here has traded. The runtime verification in
> [Runtime verification](#runtime-verification) is what decides whether it may.

---

## The constraint that forces this design

This is not isolation for tidiness. It is forced by a specific, tested fact:

> The MetaTrader5 Python package's IPC connection to `terminal64.exe` binds a
> **fixed, non-configurable local port** under Wine (observed: 22346), and that
> bind is **per-host, not per-WINEPREFIX**.

Two Wine-hosted MT5 terminals sharing one network namespace therefore collide
on that port regardless of separate prefixes, `/portable` mode, or an RPyC
bridge — a bridge wraps the same constraint rather than removing it. That was
established by direct testing in the deployment this project was copied from,
and the finding is recorded in that project's own Dockerfile.

A container has its **own network namespace**. This container's internal
`127.0.0.1:22346` is a different address space from the host's and from any
other bot's, so no collision is possible — and, usefully, no host port is
involved at all.

That is also why the collector runs **inside the same container** as the
terminal rather than beside it. The MT5 Python IPC is not designed to cross a
network boundary; co-locating them is what makes the container boundary the
isolation boundary.

## Architecture

```
  Compose project: trading-monitor-m1m5-v2-prod
  |
  +-- m1m5-v2-mt5-collector        (no host ports)
  |     Wine  ->  /wineprefix  ->  bind: /home/deploy/.mt5-m1m5-v2
  |                                 |
  |                                 +-- MetaTrader 5 terminal (this project's own)
  |                                 +-- Windows Python 3.12 + collector deps
  |                                 +-- collector  ->  http://api:3000  (internal network)
  |
  +-- api                          127.0.0.1:3020 -> 3000
  +-- web                          127.0.0.1:3021 -> 3001
  +-- m1m5-v2-scheduler            (no host ports)  the M1/M5 observation loop
  +-- m1m5-v2-postgres-prod        (no host ports)
  +-- redis                        (no host ports)
```

Everything except `api` and `web` is reachable only on this project's own
internal Docker network, by service name.

## Resource mapping

| Resource | Value |
|---|---|
| Compose project | `trading-monitor-m1m5-v2-prod` |
| MT5 container | `m1m5-v2-mt5-collector` |
| MT5 image | built from `deploy/docker/m1m5-mt5-collector/Dockerfile` (its own image, not shared) |
| Wine prefix (host) | `${M1M5_WINEPREFIX_PATH:-/home/deploy/.mt5-m1m5-v2}` |
| Wine prefix (container) | `/wineprefix` |
| MT5 terminal path | `C:\Program Files\MetaTrader 5\terminal64.exe` *inside this prefix* |
| DEMO account | server `MetaQuotes-Demo`; login in `collector/.env.production` (gitignored) |
| Scheduler container | `m1m5-v2-scheduler` |
| Postgres container | `m1m5-v2-postgres-prod` |
| Runtime volume | `m1m5_v2_runtime_data` |
| Data volumes | `m1m5_v2_pgdata`, `m1m5_v2_redisdata` |
| M1 magic number | `262610200` |
| M5 magic number | `262610201` |
| MT5 host ports | **none** |

Nothing above is shared with any other bot. The sibling deployment uses
`/home/deploy/.mt5-v2`; pointing both at one directory would give two
terminals one installation, which is exactly what must not happen.

## Ports

**The MT5 container publishes no host port**, so it cannot collide with
anything. Only `api` and `web` need one, and both bind to `127.0.0.1`.

`API_HOST_PORT=3020` and `WEB_HOST_PORT=3021` were **verified free on the VPS
on 2026-09-22** by direct inspection of its listening sockets. What is in use
there:

| Port | Owner |
|---|---|
| `127.0.0.1:3000` | `trading-monitor-api` (legacy deployment) |
| `127.0.0.1:3010` | `autonomous-trading-api` (M1 revision-5 bot) |
| `127.0.0.1:3011` | `autonomous-trading-web` |
| `127.0.0.1:65529` | `monarx-agent` |
| `0.0.0.0:80`, `:443` | `trading-monitor-caddy` |
| `0.0.0.0:22` | `sshd` |
| **`127.0.0.1:22346`** | **`wineserver`** — see below |

Re-check before deploying, since the host changes:

```bash
bash deploy/verify-vps-ports.sh
```

It is read-only: it starts, stops and removes nothing.

### The 22346 line is the constraint, observed live

`127.0.0.1:22346` is held by a host-level `wineserver` process — the legacy
deployment runs its MT5 terminal directly on the host under systemd and Xvfb,
rather than in a container.

That is precisely the fixed, per-host MT5 IPC port this design exists to work
around, and it is occupied right now. A second host-level Wine-hosted terminal
would collide with it regardless of having its own prefix. The M1 revision-5
bot already solved this by containerising its terminal
(`autonomous-trading-mt5-collector-1`, which publishes no ports), and this
project does the same for the same reason. Its internal `127.0.0.1:22346` is a
different address space from the host's, so the port above is irrelevant to it.

## One-time setup on the VPS

The terminal is installed **once**, interactively, into this project's own
prefix. The container never installs it, so a rebuild cannot silently replace
or relocate it.

```bash
# 1. Confirm what is already running and which ports are taken.
bash deploy/verify-vps-ports.sh

# 2. Create this project's OWN prefix directory, owned by the deploy user.
mkdir -p /home/deploy/.mt5-m1m5-v2
chown deploy:deploy /home/deploy/.mt5-m1m5-v2

# 3. Build and start the stack.
bash deploy/m1m5.sh build
bash deploy/m1m5.sh start

# 4. Install and log into MetaTrader 5 inside THIS prefix, interactively.
#    Use the account named in collector/.env.production (gitignored).
#    Do not type credentials into any tracked file.
bash deploy/m1m5.sh mt5-login

# 5. Verify the runtime, which is what actually decides readiness.
bash deploy/m1m5.sh mt5-verify

# 6. Prove the other bots are untouched.
bash deploy/m1m5.sh isolation-check
```

## Fail-closed behaviour

Three independent gates stop this collector attaching to another bot's
terminal or account. Each refuses to start rather than continuing, because a
collector that starts against the wrong terminal is silent, and a collector
that refuses to start is obvious and recoverable in seconds.

| Gate | Where | What it refuses |
|---|---|---|
| Prefix and terminal existence | `entrypoint.sh` | A missing prefix (Wine would otherwise create an empty one that looks like success), a missing or unset terminal path |
| `MT5_REQUIRE_EXPLICIT_TERMINAL` | `collector/app/config.py` | Starting when `MT5_TERMINAL_PATH` is unset or does not exist, which would let `initialize()` auto-discover another bot's terminal |
| `MT5_EXPECTED_LOGIN` | `collector/app/mt5_client.py` | Proceeding when the terminal reports a different account — checked **after connecting and before the client is marked connected**, so nothing downstream can read a tick or claim ownership first |

The third exists because the second is not sufficient on its own: a correct
path to a terminal logged into the wrong account is still the wrong account.

## Runtime verification

`deploy/docker/m1m5-mt5-collector/verify-mt5-readiness.py` runs inside the
container, against the live terminal, and checks:

- terminal connected, `trade_allowed`, `tradeapi_disabled`
- account identity matches the configured account
- broker/server identity
- account is **DEMO**
- account `trade_allowed`, `trade_expert`
- **`ACCOUNT_MARGIN_MODE_RETAIL_HEDGING`**
- XAUUSD exists, is tradable, volume bounds, stop/freeze levels
- a **live** bid/ask, established by watching the tick advance

The hedging check is the reason the script exists. The account was opened as
"Forex Hedged USD", but that is a label on a signup screen. The strategy needs
MT5 to report `RETAIL_HEDGING` at runtime, because M1 and M5 may hold
independent positions **including opposite directions at once**; under netting
the broker would merge them into a single net position, which is not the
specified strategy. If the runtime value is netting, execution stays blocked
and the check says so.

## Algo trading on a headless terminal

A fresh MT5 install has algorithmic trading **off**, so `terminal_info().
trade_allowed` returns false and no order can be placed. Normally that is a GUI
toggle (Tools -> Options -> Expert Advisors), which is not reachable on a
headless container without standing up VNC.

The switch itself lives in `Config/settings.ini`, which is binary and
encrypted, so it cannot be edited directly. `Config/common.ini` is plain text
but contains no `[Experts]` section at all.

The entrypoint therefore writes a startup config and passes MT5's documented
`/config:` parameter:

```
[Experts]
AllowLiveTrading=1
Enabled=1
Account=0
Profile=0
```

Written and passed on **every** start rather than once, deliberately: the
permission is re-asserted after any terminal update, profile reset or settings
corruption, instead of being a one-off manual step that silently lapses and is
noticed only when an order is rejected.

No credentials go in that file. The collector authenticates through
`MetaTrader5.initialize(login=, password=, server=)`, so the startup config
carries permission flags only.

## The broker clock, and what "a fresh quote" means

`symbol_info_tick().time` is in **broker server time**, not UTC.
MetaQuotes-Demo runs UTC+3. Subtracting it from the container's UTC clock made
a tick that had arrived half a second earlier report `age=-10799.5s`, and the
check failed a feed that was working perfectly. The negative sign was the tell:
a quote cannot arrive in the future.

Two tempting fixes are both wrong:

- **Hardcode +3h.** The offset is broker-specific, and most brokers follow DST,
  so it moves twice a year — silently, and in the direction that makes a stale
  quote look fresh.
- **Round the difference to the nearest hour.** This aliases. A two-day-old
  weekend quote rounds to "≈0s old", which is precisely the condition the check
  exists to catch.

So liveness is established the one way that needs no agreement between the two
clocks at all: **watch whether the tick advances**. The script polls
`time_msc` for a few seconds and compares the broker's timestamps *against each
other*. If it moves, the feed is live, whatever either clock says.

That moment is also the only honest opportunity to measure the offset — the
tick is then known to be ~0s old — so it is measured there, quantised to 30
minutes, and persisted to `C:\m1m5-server-utc-offset.json` inside the prefix.
A later run during a quiet market can then state a real staleness figure
instead of guessing. Until that first live measurement exists, a non-advancing
feed is reported as *unknown*, not as fresh:

| Situation | Result |
|---|---|
| Tick advances while watching | **PASS** — live; offset measured and stored |
| No tick, offset known, last tick recent | **PASS** — quiet market |
| No tick, offset known, last tick old | **FAIL** — with the real age |
| No tick, offset never measured | **FAIL** — staleness cannot be stated honestly |
| `bid == 0 && ask == 0` | **FAIL** — no tick has *ever* arrived; a different fault from staleness |

`MT5_SERVER_UTC_OFFSET_SECONDS` overrides the stored value if it is ever needed.

## Verified runtime values

Recorded from an actual `mt5-verify` run on 2026-09-22, since several of them
confirm constants this codebase had assumed:

| Check | Value |
|---|---|
| Terminal | MetaTrader 5 build 6207, connected |
| Account | matches the configured login, `trade_mode=0` (DEMO) |
| Broker | `MetaQuotes-Demo` |
| Account `trade_allowed` / `trade_expert` | both true (broker-side) |
| **Margin mode** | **`2` = RETAIL_HEDGING** |
| XAUUSD | exists, `trade_mode=4` (full access) |
| Point size | `0.01` -- matches `V2_EXPECTED_GOLD_POINT_SIZE` |
| $5.00 bracket | 500 points |
| Broker stop / freeze levels | `0` / `0` -- no restriction on a $5 bracket |
| Volume bounds | min `0.01`, max `100`, step `0.01` -- 0.5 lot valid |
| Terminal `trade_allowed` | `True` -- asserted by the `/config:` startup file; no GUI needed |
| Broker clock | **UTC+3** -- measured from a live tick, not assumed |
| XAUUSD quote | live, bid `4359.55` / ask `4360.22` |

The margin mode is the one that matters most. The account was opened as
"Forex Hedged USD", but that is a label on a signup screen; `margin_mode=2`
from the live terminal is what actually establishes that M1 and M5 can hold
independent simultaneous positions, including opposite directions. Every part
of the two-position design depends on it.

## Persistence

**Persisted** (survives restart, rebuild and image change):

| What | Where | Losing it costs |
|---|---|---|
| MT5 terminal installation, its config and saved login | host bind mount `/home/deploy/.mt5-m1m5-v2` | a full reinstall and interactive login |
| Windows Python and collector dependencies | same prefix | a re-install on next start (automatic, slow) |
| Per-timeframe indicator and crossing state, kill switch, stop-new-entries, recorded volume | volume `m1m5_v2_runtime_data` | a fresh 250-bar warm-up per timeframe before any signal can fire |
| Decisions, slot locks, post-loss locks, processed closures, report periods | volume `m1m5_v2_pgdata` | the audit trail and the four post-loss locks |

**Recreated** on every start: the container filesystem, Xvfb, the terminal
process, the collector process.

**Never baked into the image**: every credential. They arrive at run time from
`collector/.env.production` and `backend/.env.production`, both gitignored.

## Restart behaviour

1. Container restarts; Xvfb and Wine come back.
2. Entrypoint re-verifies prefix, terminal path and configured account, and
   refuses to continue if any is wrong.
3. Terminal launches and restores its saved session.
4. Collector connects and re-verifies the account identity against what the
   terminal actually reports.
5. Backend reconciliation runs; V2-owned positions are discovered by magic
   number (262610200 / 262610201) and nothing else is adopted.
6. M1/M5 occupancy is reconstructed from the slot-lock rows, which are the
   authority rather than anything in memory.
7. The four post-loss locks are read from the database and remain intact; a
   restart never clears one and never invents an unlock.
8. Indicators warm from closed bars **without generating entries** — warm-up
   never enters the code path that forms signals.
9. Execution resumes only once readiness and reconciliation pass.

## Operational commands

All scoped to this Compose project. `stop` never stops another bot.

```bash
bash deploy/m1m5.sh build | start | stop | restart | status
bash deploy/m1m5.sh mt5-status | mt5-verify | mt5-login | mt5-logs
bash deploy/m1m5.sh collector-status | backend-status | logs [service]
bash deploy/m1m5.sh ready | isolation-check
```

Deliberately absent, and not to be added: `docker system prune`,
`docker stop $(docker ps -q)`, `docker volume prune`, `pkill node`,
`pkill wine`. Each would reach beyond this project and into systems that are
trading.
