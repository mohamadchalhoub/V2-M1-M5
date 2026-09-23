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
  telegram-apply     Apply Engine B env changes to the RUNNING containers and
                     print what they actually have. `restart` does NOT pick up
                     env_file edits; this does.
  telegram-scan <n>  Run the parser over the last <n> channel messages and
                     print the RAW TEXT of everything it read as a trade.
                     Read this before enabling execution.
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
  telegram-apply)
      # Applies Engine B environment changes to the RUNNING containers.
      #
      # Needed because `m1m5.sh restart` (a plain `up -d`) does not pick up an
      # edit to the contents of an env_file: it reports "Running" and keeps the
      # old values. This forces the two Engine B services to be recreated, and
      # then prints what they actually have, because the file saying one thing
      # while the process believes another is the failure this exists to catch.
      echo "--- recreating Engine B services (Engine A untouched) ---"
      "${COMPOSE[@]}" up -d --force-recreate telegram-ingest m1m5-mt5-collector
      echo
      echo "--- environment as the RUNNING containers see it ---"
      "${COMPOSE[@]}" exec -T telegram-ingest sh -c         'echo "telegram-ingest: TELEGRAM_ENGINE_ENABLED=$TELEGRAM_ENGINE_ENABLED TELEGRAM_ENGINE_EXECUTION_MODE=$TELEGRAM_ENGINE_EXECUTION_MODE"'         || echo "telegram-ingest not running"
      "${COMPOSE[@]}" exec -T m1m5-mt5-collector bash -lc         'echo "collector: TELEGRAM_ENGINE_EXECUTION_ENABLED=$TELEGRAM_ENGINE_EXECUTION_ENABLED"'         || echo "collector not running"
      ;;
  telegram-scan)
      # Deeper history than telegram-check's default, for judging the
      # channel's actual message format before trusting the parser with an
      # account. Read-only: it writes nothing and places nothing.
      COUNT="${2:-50}"
      "${COMPOSE[@]}" run --rm -T -e TELEGRAM_CHECK_MESSAGES="$COUNT" telegram-ingest           node dist/scripts/telegram-check.js
      ;;
  telegram-check)
      # Answers the one question a heartbeat cannot: whether this account is
      # actually a SUBSCRIBER. A public channel is readable without joining,
      # and Telegram pushes updates only to subscribers - so "connected, no
      # messages" is ambiguous until this is run.
      "${COMPOSE[@]}" run --rm -T telegram-ingest node dist/scripts/telegram-check.js
      ;;
  telegram-status)
      # Reads the runtime directly - no HTTP, no dashboard token.
      #
      # The previous version wget-ed an authenticated endpoint on the api
      # container and failed with "Connection refused". Three things were
      # wrong with it: DASHBOARD_TOKEN is not set anywhere in this deployment,
      # so the request could only ever have been rejected; the api container
      # is the wrong place to ask about the INGEST container's state; and a
      # network round trip makes a transient HTTP failure indistinguishable
      # from "not ready". A readiness check that can fail for reasons
      # unrelated to readiness trains you to ignore it.
      "${COMPOSE[@]}" run --rm -T telegram-ingest node dist/scripts/telegram-ready.js
      ;;
  telegram-logs)
      "${COMPOSE[@]}" logs --tail 200 -f telegram-ingest
      ;;
  telegram-enable)
      # Deliberately multi-step. Turning this on is the single action that
      # lets someone else's Telegram message place an order on this account,
      # so it verifies first, announces before it changes anything, and
      # refuses to claim success it has not checked.
      echo "This will enable TELEGRAM DEMO EXECUTION (Engine B)."
      echo
      echo "After this, a valid fresh signal from @SFxauusd1 will place real"
      echo "DEMO orders: 0.01 lot per take profit, at the published SL and TP."
      echo "Engine A is unaffected."
      echo

      echo "--- verifying readiness before changing anything ---"
      if ! "${COMPOSE[@]}" run --rm -T telegram-ingest node dist/scripts/telegram-ready.js; then
        echo
        echo "REFUSING to enable: readiness failed. Nothing was changed."
        exit 1
      fi
      echo

      read -r -p "Type ENABLE to continue: " answer
      [ "$answer" = "ENABLE" ] || { echo "Not enabled. Nothing was changed."; exit 1; }

      echo "--- sending the pre-activation alert ---"
      "${COMPOSE[@]}" run --rm -T telegram-ingest node dist/scripts/telegram-announce.js pending \
        || echo "WARNING: the pre-activation alert did not send. Continuing; check the notification config."

      echo "--- updating backend/.env.production ---"
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

      echo "--- updating collector/.env.production ---"
      if grep -q "^TELEGRAM_ENGINE_EXECUTION_ENABLED=" collector/.env.production 2>/dev/null; then
        sed -i 's/^TELEGRAM_ENGINE_EXECUTION_ENABLED=.*/TELEGRAM_ENGINE_EXECUTION_ENABLED=true/' collector/.env.production
      else
        echo "TELEGRAM_ENGINE_EXECUTION_ENABLED=true" >> collector/.env.production
      fi

      echo "--- recreating ONLY the services that read these files ---"
      # NOT m1m5-scheduler and NOT api: neither reads an Engine B variable,
      # and restarting the scheduler would interrupt Engine A's observation
      # loop for a change that has nothing to do with it.
      #
      # --force-recreate, NOT a plain `up -d`. Compose recreates a container
      # when it detects a CONFIG change, and editing the CONTENTS of a file
      # named by env_file does not reliably count as one: `up -d` reports the
      # container as "Running" and leaves the old environment in place. The
      # change then appears to have been applied while the process is still
      # using the previous values -- which, for an execution flag, is the
      # worst way to be wrong. Observed on this deployment.
      "${COMPOSE[@]}" up -d --force-recreate telegram-ingest m1m5-mt5-collector

      echo
      echo "--- verifying the RUNNING containers, not the files ---"
      "${COMPOSE[@]}" exec -T telegram-ingest sh -c \
        'echo "telegram-ingest: TELEGRAM_ENGINE_ENABLED=$TELEGRAM_ENGINE_ENABLED TELEGRAM_ENGINE_EXECUTION_MODE=$TELEGRAM_ENGINE_EXECUTION_MODE"'
      "${COMPOSE[@]}" exec -T m1m5-mt5-collector bash -lc \
        'echo "collector: TELEGRAM_ENGINE_EXECUTION_ENABLED=$TELEGRAM_ENGINE_EXECUTION_ENABLED"'

      echo
      echo "--- sending the post-activation alert (refuses if the runtime disagrees) ---"
      "${COMPOSE[@]}" run --rm -T telegram-ingest node dist/scripts/telegram-announce.js active

      echo
      echo "Engine B is enabled. Watch it with: bash deploy/m1m5.sh telegram-logs"
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
      # --force-recreate for the same reason as telegram-enable. Turning
      # execution OFF that silently did not apply is the more dangerous half
      # of the two.
      "${COMPOSE[@]}" up -d --force-recreate telegram-ingest m1m5-mt5-collector
      "${COMPOSE[@]}" run --rm -T telegram-ingest node dist/scripts/telegram-announce.js disabled "${2:-disabled by operator}" || true
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
      echo "=== 1. session file, inside the container that holds it ==="
      "${COMPOSE[@]}" run --rm -T telegram-ingest sh -c \
        'test -f "$TELEGRAM_INGEST_SESSION_PATH" && ls -l "$TELEGRAM_INGEST_SESSION_PATH" || echo "session: MISSING - run telegram-auth"'
      echo
      echo "=== 2. runtime readiness ==="
      "${COMPOSE[@]}" run --rm -T telegram-ingest node dist/scripts/telegram-ready.js
      READY_RC=$?
      echo
      echo "=== 3. is the account actually SUBSCRIBED to the channel? ==="
      "${COMPOSE[@]}" run --rm -T telegram-ingest node dist/scripts/telegram-check.js || true
      echo
      if [ "$READY_RC" -eq 0 ]; then
        echo "All blocking gates passed. You may run: bash deploy/m1m5.sh telegram-enable"
      else
        echo "NOT READY. Do not enable Engine B until the failing gates above pass."
      fi
      exit "$READY_RC"
      ;;
  ""|-h|--help|help) usage ;;
  *) echo "unknown command: $1"; echo; usage; exit 1 ;;
esac
