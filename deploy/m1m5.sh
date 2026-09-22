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
  kill-switch on     EMERGENCY: block all new entries immediately
  kill-switch off    Allow entries again
  kill-switch        Show whether the kill switch is engaged
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
      "${COMPOSE[@]}" exec -T api bash -lc 'curl -sf http://localhost:3000/health | head -40' \
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
      "${COMPOSE[@]}" exec -T api bash -lc 'echo "backend XAUUSD_M1M5_EXECUTION_MODE=$XAUUSD_M1M5_EXECUTION_MODE"' 2>/dev/null || true
      "${COMPOSE[@]}" exec -T "$MT5_SERVICE" bash -lc 'echo "collector XAUUSD_M1M5_EXECUTION_ENABLED=$XAUUSD_M1M5_EXECUTION_ENABLED"' 2>/dev/null || true
      echo
      echo "Both must be DEMO/true before an order can reach the broker."
      ;;
  isolation-check)
      bash deploy/verify-isolation.sh
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
  ""|-h|--help|help) usage ;;
  *) echo "unknown command: $1"; echo; usage; exit 1 ;;
esac
