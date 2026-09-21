# Deploying xauusd-m1-m5-rsi-threshold-v2 to the VPS

Step by step, in order. Every command is scoped to this project.

> **Two rules that apply to every step below.**
>
> 1. **Never run a command that is not scoped to this project.** Not
>    `docker system prune`, not `docker stop $(docker ps -q)`, not
>    `docker volume prune`, not `pkill node`, not `pkill wine`. Other bots are
>    trading on this host and each of those would reach them.
> 2. **Stop if a check fails.** The checks below exist because the failure
>    modes are silent. A collector attached to the wrong terminal looks
>    healthy right up until it acts on another system's positions.

Execution stays **OFF** until [step 8](#8-verify-the-runtime) passes.

---

## 0. Inspect first, decide after

Read-only. Safe with every bot live; it starts, stops and removes nothing.

```bash
bash deploy/verify-vps-ports.sh
```

Read three things out of the output:

- **Section 5b** — where the existing bots are deployed. Pick a directory for
  this project that appears nowhere in that list.
- **Section 5** — whether ports 3020 and 3021 are free. If either is taken,
  note a free one; you will set it in step 4.
- **Section 6** — existing Wine prefixes. This project's prefix must not be
  any of them.

If you have not got the code onto the VPS yet, run this step after step 2 and
before step 3.

## 1. Create the directory

A third directory, alongside the two that already exist:

```bash
mkdir -p /opt/trading-monitor-m1m5-v2
cd /opt/trading-monitor-m1m5-v2
```

The directory name does not determine the Compose project name — the scripts
pin `-p trading-monitor-m1m5-v2-prod` explicitly, so this project can never
adopt another's containers through a directory-name coincidence.

## 2. Get the code there

This repository has **no git remote**, so pick one:

**Option A — add a remote (recommended, matches the other bots).** Create an
empty private repository, then from your development machine:

```bash
git remote add origin git@github.com:<you>/trading-monitor-m1m5-v2.git
git push -u origin main
```

and on the VPS:

```bash
cd /opt/trading-monitor-m1m5-v2
git clone git@github.com:<you>/trading-monitor-m1m5-v2.git .
```

**Option B — copy directly** from your development machine:

```bash
rsync -av --exclude node_modules --exclude .git \
  ~/Desktop/trading-monitor-m1-m5-v2/ root@<vps>:/opt/trading-monitor-m1m5-v2/
```

## 3. Put the secrets in place

The three `.env.production` files are **gitignored**, so they do not arrive
with the code. That is deliberate: credentials belong on the host, not in a
repository.

Copy them from your development machine, where they already exist and are
already filled in:

```bash
scp backend/.env.production   root@<vps>:/opt/trading-monitor-m1m5-v2/backend/
scp collector/.env.production root@<vps>:/opt/trading-monitor-m1m5-v2/collector/
scp frontend/.env.production  root@<vps>:/opt/trading-monitor-m1m5-v2/frontend/
```

Then lock them down and confirm nothing leaked into git:

```bash
cd /opt/trading-monitor-m1m5-v2
chmod 600 backend/.env.production collector/.env.production frontend/.env.production
git status --porcelain | grep -E '\.env' && echo "PROBLEM: an env file is visible to git" || echo "OK: no env file is tracked"
```

## 4. Set the values only the VPS can know

Edit `backend/.env.production`:

```bash
nano backend/.env.production
```

| Setting | What to put |
|---|---|
| `POSTGRES_PASSWORD` | a real password, replacing `CHANGE_ME_STRONG_PASSWORD` |
| `DATABASE_URL` | the same password inside the URL |
| `API_HOST_PORT` / `WEB_HOST_PORT` | free ports from step 0 (3020/3021 are **unverified placeholders**) |
| `M1M5_MT5_UID` / `M1M5_MT5_GID` | the uid/gid that will own the Wine prefix — `id -u deploy` and `id -g deploy` |
| `M1M5_WINEPREFIX_PATH` | leave as `/home/deploy/.mt5-m1m5-v2` unless step 0 showed a clash |

Leave `XAUUSD_M1M5_EXECUTION_MODE=OFF`. It stays off until step 9.

## 5. Create this project's own Wine prefix

Its **own** directory. Never another bot's.

```bash
mkdir -p /home/deploy/.mt5-m1m5-v2
chown deploy:deploy /home/deploy/.mt5-m1m5-v2

# Confirm it is not the same path any other bot uses:
ls -ld /home/*/.mt5*
```

If that listing shows this path already in use by another container, **stop**
and choose a different one, updating `M1M5_WINEPREFIX_PATH` to match.

## 6. Build and start

```bash
bash deploy/m1m5.sh build
bash deploy/m1m5.sh start
bash deploy/m1m5.sh status
```

The build takes a while — the image installs Wine and its dependency tree.

`status` shows only this project's containers. Expect:
`m1m5-v2-mt5-collector`, `m1m5-v2-scheduler`, `m1m5-v2-postgres-prod`, plus
`api`, `web`, `redis`.

The MT5 container will **refuse to start the collector** at this point,
because the terminal is not installed yet. That is correct: it fails closed
rather than auto-discovering another bot's terminal. Check with:

```bash
bash deploy/m1m5.sh mt5-logs
```

You should see it naming the missing terminal path.

## 7. Install MetaTrader 5 into this prefix — one time, interactive

This is the only manual step, and it happens **once**. The container never
installs the terminal, so no rebuild can replace or relocate it.

```bash
# Download the installer into this project's prefix
docker compose -p trading-monitor-m1m5-v2-prod -f docker-compose.prod.yml \
  --env-file backend/.env.production \
  exec m1m5-mt5-collector bash -lc \
  'curl -fsSL https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe -o /tmp/mt5setup.exe'

# Run the installer (needs a VNC/X viewer attached to the container display)
bash deploy/m1m5.sh mt5-login
```

When the terminal opens, log in with the account in
`collector/.env.production` — `MT5_LOGIN` / `MT5_PASSWORD` / `MT5_SERVER`.

Then, in the terminal: **Tools → Options → Expert Advisors → Allow algorithmic
trading**. Without it, `terminal.trade_allowed` is false and step 8 will say so.

> Do **not** log this account into any other bot's terminal, and do not switch
> another bot's terminal to it. Each application needs its own terminal, its
> own prefix and its own account, so a position is always attributable to
> exactly one system.

## 8. Verify the runtime

This is the gate. It talks to the live terminal and reports what MT5 actually
says, not what a configuration file or a signup screen claims.

```bash
bash deploy/m1m5.sh mt5-verify
```

Every line must read `PASS`. The one that matters most:

```
[PASS] RETAIL_HEDGING margin mode: margin_mode=2
```

The account was opened as "Forex Hedged USD", but that is a label. This is the
runtime value. If it reports `margin_mode=0` (netting), **execution stays
blocked** — under netting the broker merges M1 and M5 into one net position,
and this strategy may hold opposite positions at once.

Then prove the other bots are untouched:

```bash
bash deploy/m1m5.sh isolation-check
```

Expect `ISOLATION VERIFIED`. Any `[FAIL]` means stop.

## 9. Enable execution

Only after step 8 is fully green. **Both** flags are required; with one set,
nothing is ever sent.

```bash
# backend
sed -i 's/^XAUUSD_M1M5_EXECUTION_MODE=OFF/XAUUSD_M1M5_EXECUTION_MODE=DEMO/' backend/.env.production

# collector
sed -i 's/^XAUUSD_M1M5_EXECUTION_ENABLED=false/XAUUSD_M1M5_EXECUTION_ENABLED=true/' collector/.env.production

bash deploy/m1m5.sh restart
bash deploy/m1m5.sh ready
```

Consider `SHADOW` first instead of `DEMO`: it runs every gate and records every
decision exactly as if trading, and queues nothing. A day in SHADOW shows what
would have been traded, at no risk.

After enabling, **do not force a trade**. The strategy submits when a genuine
M1 or M5 crossing occurs and passes every gate. If none occurs, the correct
status is "execution ready and enabled; no legitimate strategy signal has
occurred yet".

## Day-to-day

```bash
bash deploy/m1m5.sh status            # this project's containers
bash deploy/m1m5.sh mt5-status        # is the terminal alive
bash deploy/m1m5.sh mt5-verify        # full runtime permission check
bash deploy/m1m5.sh logs              # follow all logs
bash deploy/m1m5.sh mt5-logs          # terminal + collector
bash deploy/m1m5.sh ready             # everything needed before execution
bash deploy/m1m5.sh isolation-check   # prove the other bots are untouched
bash deploy/m1m5.sh stop              # stops THIS project only
```

## Updating later

```bash
cd /opt/trading-monitor-m1m5-v2
git pull
bash deploy/m1m5.sh build
bash deploy/m1m5.sh restart
bash deploy/m1m5.sh ready
```

The Wine prefix, the terminal installation and the database are all on
volumes or bind mounts, so a rebuild keeps them. Losing the runtime volume
costs a 250-bar warm-up per timeframe before any signal can fire.

## If something goes wrong

**Stop only this project.** Never a broad command:

```bash
bash deploy/m1m5.sh stop
```

To block new entries without stopping anything — reconciliation, protective
management and Friday liquidation keep running:

```bash
docker compose -p trading-monitor-m1m5-v2-prod -f docker-compose.prod.yml \
  --env-file backend/.env.production \
  exec api touch /app/XAUUSD_M1M5_KILL_SWITCH
```

Remove that file to resume. It is checked fresh on every evaluation, so it
takes effect on the next cycle rather than on the next restart.
