#!/usr/bin/env bash
# Operational control for xauusd-m1-m5-rsi-threshold-v2 ON THE VPS.
#
# ============================================================================
# EVERY COMMAND HERE IS SCOPED TO THIS COMPOSE PROJECT.
#
# Other trading bots run on this host. Their containers are also postgres,
# redis, node and wine; their processes have the same names as ours. So every
# operation below goes through `docker compose -p trading-monitor-m1m5-v2-prod`
# and never through a bare container name, a process name, or an image filter.
#
# Specifically NOT used anywhere in this file, and not to be added:
#   docker system prune      - would delete other bots' unused resources
#   docker stop $(docker ps -q)  - would stop every bot on the host
#   pkill node / pkill wine  - would kill other bots' processes
#   docker volume prune      - would delete other bots' data
#
# `m1m5.sh stop` must never stop another bot. That is the single property this
# file is organised around.
# ============================================================================
#
# Usage: bash deploy/m1m5.sh <command>
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

PROJECT="trading-monitor-m1m5-v2-prod"
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.prod.yml --env-file backend/.env.production)
MT5_SERVICE="m1m5-mt5-collector"
MT5_CONTAINER="m1m5-v2-mt5-collector"

usage() {
    cat <<'USAGE'
xauusd-m1-m5-rsi-threshold-v2 operations

  build              Build this project's images
  start              Start this project's stack
  stop               Stop THIS project only (never another bot)
  restart            Restart this project's stack
  status             Containers, health and published ports for this project
  mt5-status         Is the MT5 terminal process alive in our container
  mt5-verify         Full runtime MT5 readiness check (account, DEMO, hedging,
                     permissions, symbol, quote) against the live terminal
  mt5-login          One-time interactive terminal launch for the first login
  collector-status   Recent collector output
  backend-status     API health
  logs [service]     Follow logs for this project (default: all)
  mt5-logs           Follow MT5 container logs
  collector-logs     Alias of mt5-logs (collector runs in that container)
  ready              Everything needed before enabling execution
  isolation-check    Prove this project is not touching the other bots
  set-volume <lots>  Set the order volume (validated, audited). e.g. set-volume 0.03
  kill-switch on     EMERGENCY: block all new entries immediately
  kill-switch off    Allow entries again
  kill-switch        Show whether the kill switch is engaged

 --- Engine B, the Telegram copy engine (@SFxauusd1). Independent of the
     RSI engine above: these commands do not affect M1/M5 in any way.
  telegram-auth      ONE-TIME interactive Telegram sign-in. Prompts for phone,
                     login code and (if set) 2FA password. Writes a session
                     that survives restarts and redeploys.
  telegram-check     Is the account SUBSCRIBED, and what has the channel
                     published? Distinguishes "quiet channel" from "not
                     receiving". Runs the real parser over recent messages.
  telegram-ready     Pre-flight checks before enabling execution
  telegram-status    Ingestion health, source channel, reconciliation state
  telegram-logs      Follow the Telegram ingestion container's logs
  telegram-enable    Turn Telegram DEMO execution ON (deliberate, two-step)
  telegram-disable   Turn Telegram execution OFF (positions stay managed)
  telegram-kill on|off|status   EMERGENCY stop for Engine B alone
USAGE
}

case "${1:-}" in
  build)    "${COMPOSE[@]}" build ;;
  start)    "${COMPOSE[@]}" up -d ;;
  stop)
      # Scoped by -p. Stops this project's containers and nothing else.
      "${COMPOSE[@]}" stop
      echo
      echo "Stopped $PROJECT only. Other bots on this host were not touched."
      echo "Note: while stopped, nothing observes RSI and the Friday liquidation does not run."
      ;;
  restart)
      # `up -d`, NOT `docker compose restart`.
      #
      # `restart` stops and starts the EXISTING containers with the config they
      # were created with, so it does not re-read env_file. An operator who
      # edits .env.production and runs `restart` sees their change silently
      # ignored -- which cost real time once: the API kept failing on missing
      # Telegram config that had already been added to the file.
      #
      # `up -d` recreates any container whose config changed and leaves the
      # rest alone, which is what "restart after editing config" has to mean.
      "${COMPOSE[@]}" up -d
      ;;
  status)
      "${COMPOSE[@]}" ps
      echo
      echo "--- published host ports for THIS project ---"
      "${COMPOSE[@]}" ps --format json 2>/dev/null | grep -o '"Publishers":\[[^]]*\]' || true
      ;;
  mt5-status)
      echo "--- terminal process inside $MT5_CONTAINER ---"
      "${COMPOSE[@]}" exec -T "$MT5_SERVICE" bash -lc 'pgrep -af terminal64.exe || echo "terminal64.exe NOT running"'
      echo
      echo "--- wine prefix ---"
      "${COMPOSE[@]}" exec -T "$MT5_SERVICE" bash -lc 'echo "WINEPREFIX=$WINEPREFIX"; ls -la "$WINEPREFIX" | head -5'
      ;;
  mt5-verify)
      # The authoritative check. Talks to the running terminal and reports the
      # real margin mode rather than the account-type label.
      "${COMPOSE[@]}" exec -T "$MT5_SERVICE" bash -lc \
          'wine "$WINEPREFIX/drive_c/Program Files/Python312/python.exe" /verify-mt5-readiness.py'
      ;;
  mt5-login)
      echo "Launching the terminal for a one-time interactive login."
      echo "Connect a VNC/X viewer to this container's display to complete it."
      "${COMPOSE[@]}" exec "$MT5_SERVICE" bash -lc \
          'wine "$WINEPREFIX/drive_c/Program Files/MetaTrader 5/terminal64.exe" /portable'
      ;;
  collector-status|mt5-logs|collector-logs)
      "${COMPOSE[@]}" logs --tail 200 -f "$MT5_SERVICE"
      ;;
  backend-status)
      # The api image is node:20-alpine: no bash and no curl. BusyBox sh and
      # wget are what exist there.
      "${COMPOSE[@]}" exec -T api sh -c 'wget -qO- http://localhost:3000/health | head -40' \
          || echo "api not healthy or not running"
      ;;
  logs)
      shift || true
      "${COMPOSE[@]}" logs --tail 200 -f "$@"
      ;;
  ready)
      echo "=== 1. this project's containers ==="
      "${COMPOSE[@]}" ps
      echo
      echo "=== 2. MT5 runtime readiness (authoritative) ==="
      "${COMPOSE[@]}" exec -T "$MT5_SERVICE" bash -lc \
          'wine "$WINEPREFIX/drive_c/Program Files/Python312/python.exe" /verify-mt5-readiness.py' \
          || echo "  MT5 readiness FAILED -- execution must stay OFF"
      echo
      echo "=== 3. execution mode ==="
      # Read from the SCHEDULER, which is the process whose mode decides
      # whether an order is queued. `sh`, because the image is Alpine.
      "${COMPOSE[@]}" exec -T m1m5-scheduler sh -c 'echo "scheduler XAUUSD_M1M5_EXECUTION_MODE=$XAUUSD_M1M5_EXECUTION_MODE"' 2>/dev/null           || echo "scheduler not running -- nothing is observing RSI"
      echo "kill switch:"; bash "$0" kill-switch status 2>/dev/null || true
      "${COMPOSE[@]}" exec -T "$MT5_SERVICE" bash -lc 'echo "collector XAUUSD_M1M5_EXECUTION_ENABLED=$XAUUSD_M1M5_EXECUTION_ENABLED"' 2>/dev/null || true
      echo
      echo "Both must be DEMO/true before an order can reach the broker."
      ;;
  isolation-check)
      bash deploy/verify-isolation.sh
      ;;
  set-volume)
      # The ONLY supported way to change the volume. The XAUUSD_M1M5_VOLUME_LOTS
      # variable in the env file is read by no code at all. Runs inside the
      # scheduler container, which already has the account and the database.
      [ -n "${2:-}" ] || { echo "usage: m1m5.sh set-volume <lots>"; exit 1; }
      "${COMPOSE[@]}" exec -T m1m5-scheduler node dist/scripts/xauusd-m1m5-set-volume.js "$2" --by "${SUDO_USER:-${USER:-operator}}"
      ;;
  kill-switch)
      # The file lives in the runtime VOLUME, which the api and the scheduler
      # both mount at this same path. Anywhere else would be private to the
      # container that wrote it, and the scheduler -- the process that
      # actually queues orders -- would never see it.
      #
      # Blocks NEW entries only. Reconciliation, protection repair and Friday
      # liquidation keep running, which is why this, and not stopping the
      # stack, is the right first move in an emergency: stopping the stack
      # also stops the thing that would close an open position before the
      # weekend.
      KS=/app/xauusd-m1m5-runtime/XAUUSD_M1M5_KILL_SWITCH
      case "${2:-status}" in
        on)
          "${COMPOSE[@]}" exec -T api sh -c "touch $KS"             && echo "KILL SWITCH ON. No new entries. Open positions are still managed and liquidated on Friday."
          ;;
        off)
          "${COMPOSE[@]}" exec -T api sh -c "rm -f $KS" && echo "Kill switch off. Entries allowed again."
          ;;
        status)
          # Checked from the SCHEDULER, deliberately: that is the process whose
          # view actually decides whether an order gets queued.
          "${COMPOSE[@]}" exec -T m1m5-scheduler sh -c "test -f $KS && echo 'kill switch: ON (entries blocked)' || echo 'kill switch: off'"
          ;;
        *) echo "usage: m1m5.sh kill-switch [on|off|status]"; exit 1 ;;
      esac
      ;;
  telegram-auth)
      # Interactive by design: `exec`, not `exec -T`, because Telegram will
      # ask for a login code and possibly a 2FA password and those are typed,
      # never passed as arguments or environment variables where they would
      # outlive the moment in shell history or a process listing.
      echo "One-time Telegram authorization for Engine B."
      echo
      echo "You will be asked for:"
      echo "  1. your Telegram phone number, international format (+961...)"
      echo "  2. the login code Telegram sends to that account"
      echo "  3. your two-factor password, if you have one set (not echoed)"
      echo
      echo "The session is written to the runtime volume and reused after every"
      echo "restart, redeploy and reboot. You will not be asked again."
      echo
      "${COMPOSE[@]}" run --rm -it telegram-ingest node dist/scripts/telegram-auth.js
      ;;
  telegram-check)
      # Answers the one question a heartbeat cannot: whether this account is
      # actually a SUBSCRIBER. A public channel is readable without joining,
      # and Telegram pushes updates only to subscribers - so "connected, no
      # messages" is ambiguous until this is run.
      "${COMPOSE[@]}" run --rm -T telegram-ingest node dist/scripts/telegram-check.js
      ;;
  telegram-status)
      echo "=== Engine B: ingestion + reconciliation ==="
      "${COMPOSE[@]}" exec -T api sh -c \
          'wget -qO- --header="Authorization: Bearer $DASHBOARD_TOKEN" \
           http://localhost:3000/xauusd-m1m5/telegram-engine/status | head -80' \
          || echo "api not reachable, or DASHBOARD_TOKEN not set in the api container"
      echo
      echo "=== execution switches (read from the ingestion container) ==="
      "${COMPOSE[@]}" exec -T telegram-ingest sh -c \
          'echo "TELEGRAM_ENGINE_ENABLED=$TELEGRAM_ENGINE_ENABLED"; echo "TELEGRAM_ENGINE_EXECUTION_MODE=$TELEGRAM_ENGINE_EXECUTION_MODE"' \
          2>/dev/null || echo "telegram-ingest not running"
      ;;
  telegram-logs)
      "${COMPOSE[@]}" logs --tail 200 -f telegram-ingest
      ;;
  telegram-enable)
      # Deliberately two-step and deliberately verbose. Turning this on is the
      # single action that lets someone else's Telegram message place an order
      # on this account, so it asks, and it says what it is about to do.
      echo "This will enable TELEGRAM DEMO EXECUTION."
      echo
      echo "After this, a valid fresh signal from @SFxauusd1 will place real"
      echo "DEMO orders: 0.01 lot per take profit, at the published SL and TP."
      echo "The RSI engine is unaffected."
      echo
      echo "Confirm the checks first with: bash deploy/m1m5.sh telegram-ready"
      read -r -p "Type ENABLE to continue: " answer
      [ "$answer" = "ENABLE" ] || { echo "Not enabled."; exit 1; }
      python3 - <<'PY' || { echo "could not update backend/.env.production"; exit 1; }
import io, re
p = "backend/.env.production"
s = io.open(p, encoding="utf-8").read()
for key, value in (("TELEGRAM_ENGINE_ENABLED", "true"), ("TELEGRAM_ENGINE_EXECUTION_MODE", "DEMO")):
    if re.search(rf"^{key}=.*$", s, re.M):
        s = re.sub(rf"^{key}=.*$", f"{key}={value}", s, flags=re.M)
    else:
        s += f"\n{key}={value}\n"
io.open(p, "w", encoding="utf-8").write(s)
print("backend/.env.production updated")
PY
      sed -i 's/^TELEGRAM_ENGINE_EXECUTION_ENABLED=.*/TELEGRAM_ENGINE_EXECUTION_ENABLED=true/' collector/.env.production 2>/dev/null \
        || echo "TELEGRAM_ENGINE_EXECUTION_ENABLED=true" >> collector/.env.production
      echo "Recreating the affected containers so they re-read their env files..."
      "${COMPOSE[@]}" up -d telegram-ingest api m1m5-mt5-collector
      echo
      echo "Telegram DEMO execution is ON. Verify with: bash deploy/m1m5.sh telegram-status"
      ;;
  telegram-disable)
      python3 - <<'PY'
import io, re
p = "backend/.env.production"
s = io.open(p, encoding="utf-8").read()
s = re.sub(r"^TELEGRAM_ENGINE_ENABLED=.*$", "TELEGRAM_ENGINE_ENABLED=false", s, flags=re.M)
s = re.sub(r"^TELEGRAM_ENGINE_EXECUTION_MODE=.*$", "TELEGRAM_ENGINE_EXECUTION_MODE=SHADOW", s, flags=re.M)
io.open(p, "w", encoding="utf-8").write(s)
print("backend/.env.production updated")
PY
      sed -i 's/^TELEGRAM_ENGINE_EXECUTION_ENABLED=.*/TELEGRAM_ENGINE_EXECUTION_ENABLED=false/' collector/.env.production 2>/dev/null || true
      "${COMPOSE[@]}" up -d telegram-ingest api m1m5-mt5-collector
      echo "Telegram execution is OFF. Existing Telegram positions are still reconciled and managed."
      ;;
  telegram-kill)
      # Engine B's own emergency stop. Deliberately NOT the same file as the
      # RSI engine's: an operator stopping one engine must not silently stop
      # the other. Blocks new Telegram entries only; reconciliation and
      # management of open Telegram positions keep running.
      TKS=/app/xauusd-m1m5-runtime/TELEGRAM_ENGINE_KILL_SWITCH
      case "${2:-status}" in
        on)
          "${COMPOSE[@]}" exec -T api sh -c "touch $TKS" \
            && echo "TELEGRAM KILL SWITCH ON. No new Telegram entries. Open Telegram positions are still managed."
          ;;
        off)
          "${COMPOSE[@]}" exec -T api sh -c "rm -f $TKS" && echo "Telegram kill switch off."
          ;;
        status)
          "${COMPOSE[@]}" exec -T telegram-ingest sh -c \
            "test -f $TKS && echo 'telegram kill switch: ON (entries blocked)' || echo 'telegram kill switch: off'"
          ;;
        *) echo "usage: m1m5.sh telegram-kill [on|off|status]"; exit 1 ;;
      esac
      ;;
  telegram-ready)
      echo "=== 1. Telegram session and source channel ==="
      "${COMPOSE[@]}" exec -T telegram-ingest sh -c \
        'test -f "$TELEGRAM_INGEST_SESSION_PATH" && echo "session: present" || echo "session: MISSING - run telegram-auth"'
      "${COMPOSE[@]}" exec -T telegram-ingest sh -c \
        'ls -l "$TELEGRAM_INGEST_SESSION_PATH" 2>/dev/null | cut -d" " -f1,3,4 || true'
      echo
      echo "=== 2. ingestion + reconciliation state ==="
      bash "$0" telegram-status
      echo
      echo "Telegram DEMO execution requires ALL of:"
      echo "  - session present and source channel resolved"
      echo "  - ingestion connected, with recent source messages"
      echo "  - reconciliation recoveryComplete = true"
      echo "  - MT5 ready (bash deploy/m1m5.sh mt5-verify)"
      ;;
  ""|-h|--help|help) usage ;;
  *) echo "unknown command: $1"; echo; usage; exit 1 ;;
esac
