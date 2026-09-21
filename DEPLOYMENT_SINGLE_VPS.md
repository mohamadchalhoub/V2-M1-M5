# Single-VPS deployment — MT5 (Wine-hosted) + full stack, one Ubuntu box

> Alternative to `DEPLOYMENT.md`'s two-host topology, for when a second
> (Windows) host isn't an option. See `DEPLOYMENT.md` if you *do* have a
> Windows machine available for MT5 — it's simpler and has no Wine
> involved at all.

## 0. Read this before you start: there is no Wine-free path

A native, non-Wine Linux MT5 terminal does not exist, and the official
`MetaTrader5` PyPI package has no Linux wheel — confirmed directly against
MetaQuotes' own install page
([metatrader5.com/.../install_linux](https://www.metatrader5.com/en/terminal/help/start_advanced/install_linux)),
which states outright: *"The platform runs on Linux using Wine."* Its
installer is a `.sh` script (`mt5linux.sh`), not a `.deb`, and it bootstraps
Wine before installing the ordinary Windows `terminal64.exe` under it —
that terminal then lives at `~/.mt5/drive_c/Program Files/MetaTrader 5/`, a
Wine prefix. The Python package is a compiled Windows extension module
(`.pyd`); it has no Linux wheel and can't be imported by a native Linux
Python interpreter no matter what it's pointed at.

Every "run MT5 on Linux" tool that exists (`lprett/mt5linux`,
`MT5LinuxEnhanced`, etc.) works around this by running a **Windows Python
interpreter inside Wine**, loading the real package there, and proxying
calls out over RPyC to a native Linux client process. That RPyC hop is
almost certainly what produced the "IPC timeout / Authorization failed"
failures from the earlier `lprett/mt5linux` attempt — it's a second network
protocol layered on top of MT5's own IPC, maintained by a small community
project, with its own bugs independent of Wine or MT5 themselves.

**What this plan does instead**: installs the terminal via MetaQuotes' own
official script (so the terminal itself is exactly what they ship), then
runs a Windows Python interpreter — with this repo's existing
`collector/` code completely unmodified — inside that *same* Wine prefix.
No bridge package, no RPyC, no second process talking to a first process
over a home-grown protocol. `collector/app/mt5_client.py` already has a
"native" code path used today in local Windows dev
(`import MetaTrader5 as mt5` at module scope, active whenever
`MT5_BRIDGE_HOST` is unset) — from that Windows Python interpreter's own
point of view, running under Wine looks exactly like running on real
Windows, so that native path is what actually executes here, completely
unaware it's on Linux underneath. This is a materially different failure
mode than the bridge that failed before, not a guarantee — Part 5 below is
a deliberate stop-and-verify gate before any of the rest of the stack gets
built on top of it, and §12 lists fallback options if it doesn't hold up.

This collector is **read-only against MT5** by design (`mt5_client.py`'s
own header comment: no `order_send`, no `order_check`, ever) — so unlike a
typical EA deployment, there is no "Algo Trading" toggle to enable and no
MT5-side auto-login config file to maintain. Login happens once per process
start, from the Python side, via `mt5.initialize(login=..., password=...,
server=...)` — exactly like local dev already does.

## 1. Architecture

```
Hostinger Ubuntu 22.04 VPS (single host)
──────────────────────────────────────────────────────────────────────
 Xvfb :99 (virtual display, systemd)
   └─ terminal64.exe (official MT5, MetaQuotes' own binary, under Wine)
        supervised by mt5-terminal.service

 Wine-hosted Windows Python 3.12
   └─ collector/main.py — UNMODIFIED — native `import MetaTrader5` path
        supervised by mt5-collector.service
        outbound: http://127.0.0.1:3000  (loopback only, see §6)

 Docker Compose (docker-compose.prod.yml)
   postgres · redis · migrate (one-shot) · api · web · caddy (TLS)
   api's port 3000 published to 127.0.0.1 ONLY — never on the public
   interface; the collector above is the one process on this box allowed
   to reach it directly, everyone else goes through Caddy on 443.
──────────────────────────────────────────────────────────────────────
```

## 2. Before you start

You need, from your broker: an MT5 account number, password, and server
name (e.g. `ICMarketsSC-Demo`). You need two DNS A records already pointing
at this VPS's IP before bringing the stack up (Caddy requests TLS certs on
first request): `api.<yourdomain>` and `app.<yourdomain>`.

## 3. VPS base setup

Run as `root` (or a sudo-capable user) over SSH.

```bash
timedatectl set-timezone Asia/Beirut
apt update && apt upgrade -y
apt install -y curl git ufw fail2ban wget

# A 4GB VPS running Postgres + Redis + Node + Next.js + Caddy + Wine/MT5
# is workable but tight — a swap file is cheap insurance against an OOM
# kill taking down a random service under load.
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Non-root deploy user — everything from here on runs as this user, never root.
adduser deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/ 2>/dev/null || true
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys

ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

systemctl enable --now fail2ban
```

**Recommended, once you've confirmed key-based SSH login as `deploy`
works**: edit `/etc/ssh/sshd_config`, set `PermitRootLogin no` and
`PasswordAuthentication no`, then `systemctl restart sshd`.

Clone the repo to a shared location both the Docker stack and the
Wine-hosted collector will read from:

```bash
mkdir -p /opt/trading-monitor
chown deploy:deploy /opt/trading-monitor
su - deploy
git clone <YOUR_GIT_REMOTE_URL> /opt/trading-monitor   # or rsync/scp it over if you haven't pushed anywhere yet
```

From here on, every command runs **as `deploy`** unless marked otherwise.

## 4. Xvfb (virtual display)

```bash
sudo cp /opt/trading-monitor/deploy/systemd/xvfb.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xvfb.service
systemctl status xvfb.service   # should show "active (running)"
```

## 5. One-time VNC access (needed for the MT5 install below)

MetaQuotes' installer launches a real installer wizard, and MT5's very
first-ever launch shows a "connect to an account" wizard modal — both need
one manual click-through before the terminal will run cleanly headless
forever after. Do this over an SSH tunnel, never expose VNC on the public
interface:

```bash
sudo apt install -y x11vnc
DISPLAY=:99 x11vnc -display :99 -nopw -listen localhost -xkb &
```

From your **local machine** (Windows), open a tunnel and connect a VNC
viewer (TightVNC/RealVNC/etc.) to `localhost:5900`:

```
ssh -L 5900:localhost:5900 deploy@<vps-ip>
```

Leave this VNC session running through §6. Kill it afterward:
`pkill x11vnc` — don't leave it running long-term; re-run the one command
above if you need to look again later (e.g. troubleshooting).

## 6. Install MT5 (official MetaQuotes script)

Watch this happen live in the VNC viewer from §5.

```bash
cd ~
wget https://download.terminal.free/cdn/web/metaquotes.software.corp/mt5/mt5linux.sh
chmod +x mt5linux.sh
DISPLAY=:99 ./mt5linux.sh
```

This installs Wine (may prompt for your `deploy` sudo password in the SSH
session itself — a normal terminal prompt, unrelated to the virtual
display), then launches the MT5 installer wizard on `:99`. In the VNC
window: click through the Wine/Mono/Gecko prompts if any appear (agree —
required for the terminal to run at all), finish the MT5 installer, and
when the terminal's own first-run "open an account" wizard appears, just
**close it** — login happens from Python in §9, not here. Confirm the bare
terminal window sits idle with no modal on top before moving on.

Confirm the install landed where the systemd units expect:

```bash
ls "$HOME/.mt5/drive_c/Program Files/MetaTrader 5/terminal64.exe"
```

If your prefix or install path differs, update the `ExecStart=` line in
`deploy/systemd/mt5-terminal.service` and `mt5-collector.service` (§9)
accordingly before installing them.

## 7. Supervise the terminal with systemd

```bash
sudo cp /opt/trading-monitor/deploy/systemd/mt5-terminal.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mt5-terminal.service
systemctl status mt5-terminal.service
```

Check the VNC window again — the terminal should be idle, no modal, no
crash dialog.

## 8. Install Windows Python inside the same Wine prefix

```bash
wget https://www.python.org/ftp/python/3.12.14/python-3.12.14-amd64.exe -P ~/
DISPLAY=:99 WINEPREFIX="$HOME/.mt5" wine ~/python-3.12.14-amd64.exe /quiet InstallAllUsers=1 PrependPath=0 Include_launcher=0 Include_test=0 Include_doc=0
```

Verify:

```bash
DISPLAY=:99 WINEPREFIX="$HOME/.mt5" wine "$HOME/.mt5/drive_c/Program Files/Python312/python.exe" --version
```

If that path doesn't exist, the silent install landed in the per-user
profile instead (`InstallAllUsers=1` not honored) — check
`"$HOME/.mt5/drive_c/users/$USER/AppData/Local/Programs/Python/Python312/python.exe"`
and use whichever path actually exists consistently from here on,
including in `mt5-collector.service`'s `ExecStart=`.

Install the collector's dependencies into this same interpreter:

```bash
cd /opt/trading-monitor/collector
DISPLAY=:99 WINEPREFIX="$HOME/.mt5" wine "$HOME/.mt5/drive_c/Program Files/Python312/python.exe" -m pip install --upgrade pip
DISPLAY=:99 WINEPREFIX="$HOME/.mt5" wine "$HOME/.mt5/drive_c/Program Files/Python312/python.exe" -m pip install -r requirements.txt
```

## 9. STOP — verify the real thing before building anything else

Don't wire up the backend/collector.env yet. Prove `mt5.initialize()` +
login actually works from this Wine-hosted Python first — this is the
exact mechanism the whole plan depends on, and it's far cheaper to debug
in isolation than after the full stack is layered on top of it.

```bash
cd /opt/trading-monitor/collector
DISPLAY=:99 WINEPREFIX="$HOME/.mt5" wine "$HOME/.mt5/drive_c/Program Files/Python312/python.exe" -c "
import MetaTrader5 as mt5
ok = mt5.initialize(login=<YOUR_LOGIN>, password='<YOUR_PASSWORD>', server='<YOUR_SERVER>')
print('initialize:', ok, mt5.last_error())
print('account_info:', mt5.account_info())
print('terminal_info:', mt5.terminal_info())
mt5.shutdown()
"
```

You're looking for `initialize: True` and a populated `account_info` with
your real balance/equity. **If this doesn't work, stop here** — nothing
below this point will work either, and you're better off retrying with
`MT5LinuxEnhanced`, adding a small second Windows host, or checking your
broker for a non-terminal API (see §12) than debugging it underneath a
full Docker stack.

## 10. The Docker stack (Postgres, Redis, API, frontend, Caddy)

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker deploy
# log out and back in for the group change to take effect, or: newgrp docker
```

Env files (never committed — see each repo's `.gitignore`):

```bash
cd /opt/trading-monitor
cp .env.production.example .env.production            # POSTGRES_*/REDIS_PASSWORD, API_DOMAIN, APP_DOMAIN
cp backend/.env.production.example backend/.env.production   # DATABASE_URL/REDIS_URL (match the passwords above), Telegram, AI keys, DASHBOARD_ORIGIN
cp frontend/.env.production.example frontend/.env.production # BACKEND_API_URL — leave DASHBOARD_API_TOKEN blank for now
chmod 600 .env.production backend/.env.production frontend/.env.production
```

Edit all three with real values, then bring the stack up:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps   # everything healthy before continuing
```

Bootstrap the trading account and mint its collector token (runs inside
the `migrate` image, which already has `tsx` and is on the same Docker
network as `postgres` — no separate `npm install` needed on the host):

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm \
  -e BOOTSTRAP_USER_EMAIL="you@example.com" \
  -e BOOTSTRAP_MT5_LOGIN="<YOUR_LOGIN>" \
  -e BOOTSTRAP_MT5_SERVER="<YOUR_SERVER>" \
  migrate npx tsx scripts/bootstrap.ts
```

Copy the printed collector token and account id — you'll need both in
§11. Then mint a dashboard token for the same account:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm \
  migrate npx tsx scripts/create-dashboard-token.ts <accountId>
```

Put that value into `frontend/.env.production`'s `DASHBOARD_API_TOKEN`,
then:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build web
```

## 11. Wire up the collector

```bash
cd /opt/trading-monitor/collector
cp .env.example .env
chmod 600 .env
mkdir -p logs
```

Edit `.env`:

```ini
MT5_LOGIN=<YOUR_LOGIN>
MT5_PASSWORD=<YOUR_PASSWORD>
MT5_SERVER=<YOUR_SERVER>
MT5_TERMINAL_PATH=C:\Program Files\MetaTrader 5\terminal64.exe
MT5_TIMEOUT_MS=60000
MT5_BROKER_TIMEZONE=EET

POLL_INTERVAL_SECONDS=10
HISTORY_DAYS=7
RECONNECT_INITIAL_BACKOFF_SECONDS=2
RECONNECT_MAX_BACKOFF_SECONDS=60
LOG_LEVEL=INFO
LOG_FORMAT=json

# Loopback only — see docker-compose.prod.yml's api service (§10). Do NOT
# point this at api.<yourdomain> — no reason to round-trip through the
# public internet for a same-host call.
COLLECTOR_API_BASE_URL=http://127.0.0.1:3000
COLLECTOR_API_KEY=<token from bootstrap.ts above>
COLLECTOR_ACCOUNT_ID=<accountId from bootstrap.ts above>
COLLECTOR_API_TIMEOUT_SECONDS=10

INITIAL_SYNC_DAYS=90
HISTORY_SYNC_OVERLAP_MINUTES=5
CANDLE_SYMBOLS=EURUSD
CANDLE_TIMEFRAMES=M5,M15,H1,M30,H4,D1,W1,MN1
CANDLE_SYNC_INTERVAL_SECONDS=300
CANDLE_INITIAL_SYNC_DAYS=730
```

**Leave `MT5_BRIDGE_HOST` unset** — don't add it. That variable switches
`mt5_client.py` into its RPyC-bridge mode, built for the abandoned
`lprett/mt5linux` approach; this deployment intentionally uses the native
code path instead (§0), the same one local Windows dev already exercises.

Install and start the collector service:

```bash
sudo cp /opt/trading-monitor/deploy/systemd/mt5-collector.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mt5-collector.service
journalctl -u mt5-collector -f
```

Watch for `"configuration loaded"` followed by successful poll cycles, no
repeated `connect()` failures.

## 12. If §9 or §11 don't hold up in practice

The Wine-hosted-Python approach removes the specific bridge layer that
failed before, but it's still Wine, and it's the first time this exact
combination has been tried in this deployment. If MT5's IPC turns out to
be unstable under Wine in general (not just in the RPyC layer that failed
previously), these are the fallbacks, roughly in order of effort:

1. **Try `MT5LinuxEnhanced`** instead of `lprett/mt5linux` — a different,
   actively maintained implementation of the same bridge pattern; may have
   fixed the specific bugs you hit before, without changing anything else
   in this plan.
2. **Add a small second Windows host** (e.g. Contabo's low-cost Windows
   VPS tier) for MT5 + collector only, and keep this Ubuntu box for
   everything else — exactly `DEPLOYMENT.md`'s topology. The only
   Wine-free option, at the cost of the second host you were trying to
   avoid.
3. **Check your broker for a FIX or REST API** that doesn't require the
   desktop terminal at all — a fundamentally different integration than
   `MetaTrader5`/`mt5_client.py`, feasible only if your specific broker
   offers one.

## 13. Firewall & security (confirm, don't just set-and-forget)

- `sudo ufw status verbose` — only 22 (or your custom SSH port), 80, 443
  should be `ALLOW`. Port 3000 must **not** appear — it's bound to
  `127.0.0.1` only in `docker-compose.prod.yml` (§10), never reachable
  from outside this host.
- `ls -la /opt/trading-monitor/.env.production /opt/trading-monitor/backend/.env.production /opt/trading-monitor/frontend/.env.production /opt/trading-monitor/collector/.env` — all four `-rw-------` (600), owned by `deploy`.
- SSH: key-based only, root login disabled (§3's recommended step) —
  confirm with `sudo sshd -T | grep -E 'permitrootlogin|passwordauthentication'`.

## 14. Backups & monitoring

Reuses `DEPLOYMENT.md`'s existing backup mechanism unchanged — same
compose file, same container name:

```bash
cd /opt/trading-monitor/backend
POSTGRES_CONTAINER=trading-monitor-postgres-prod bash scripts/backup.sh
```

Cron it nightly:

```bash
(crontab -l 2>/dev/null; echo "0 3 * * * cd /opt/trading-monitor/backend && POSTGRES_CONTAINER=trading-monitor-postgres-prod bash scripts/backup.sh >> /var/log/trading-monitor-backup.log 2>&1") | crontab -
```

Health/monitoring:

- Docker's own healthchecks already gate `api`/`web`/`postgres`/`redis` startup
  ordering (`docker-compose.prod.yml`); `docker compose ps` shows current status.
- `curl -s http://127.0.0.1:3000/health/live` → `{"status":"ok"}` from this host directly.
- Optional: point an external uptime monitor at `https://api.<yourdomain>/health/live`.
- `journalctl -u mt5-collector`, `-u mt5-terminal`, `-u xvfb` — rotated and
  size-capped automatically by journald; `journalctl --vacuum-size=500M`
  if disk ever gets tight.

## 15. Final verification checklist

- [ ] `systemctl status xvfb mt5-terminal mt5-collector` — all `active (running)`
- [ ] `docker compose -f docker-compose.prod.yml ps` — all healthy
- [ ] `curl -s http://127.0.0.1:3000/health/live` → `{"status":"ok"}`
- [ ] `journalctl -u mt5-collector -n 50` — polling successfully, no repeated reconnect errors
- [ ] New rows landing in `account_snapshots` (via `docker exec -it trading-monitor-postgres-prod psql -U <user> -d trading_monitor -c "select count(*) from account_snapshots;"` a minute apart)
- [ ] `https://app.<yourdomain>` loads and shows live balance/equity/positions
- [ ] A rule trigger (or `npm run send-account-summary` inside the `migrate` image) delivers a Telegram message
- [ ] **Reboot survival**: `sudo reboot`, wait ~1 min, SSH back in, re-check
      the first three items above with no manual intervention
