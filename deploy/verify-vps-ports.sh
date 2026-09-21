#!/usr/bin/env bash
# Read-only VPS inspection for xauusd-m1-m5-rsi-threshold-v2.
#
# Run this ON THE VPS (Hostinger web console is fine) BEFORE deploying, and
# paste the output back. It answers the one question that cannot be answered
# from a development machine: which host ports are already taken by the bots
# already running here.
#
# ============================================================================
# THIS SCRIPT ONLY READS.
#
# It starts nothing, stops nothing, removes nothing and modifies nothing. No
# `docker system prune`, no `docker stop`, no process kills, no cleanup of any
# kind. It is safe to run while every existing bot is live and trading, which
# is the entire point -- inspection must never be the thing that takes a
# trading system down.
# ============================================================================
#
# Usage:  bash deploy/verify-vps-ports.sh
set -uo pipefail

# The host ports this project would like. Both bind to loopback only and are
# overridable via API_HOST_PORT / WEB_HOST_PORT in backend/.env.production.
WANT_API_PORT="${API_HOST_PORT:-3020}"
WANT_WEB_PORT="${WEB_HOST_PORT:-3021}"

echo "==========================================================="
echo " V2 pre-deployment inspection (read-only)"
echo " host: $(hostname)   date: $(date -Is)"
echo "==========================================================="
echo

echo "--- 1. All listening TCP sockets -------------------------"
if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null || ss -ltn
elif command -v netstat >/dev/null 2>&1; then
    netstat -ltnp 2>/dev/null || netstat -ltn
else
    echo "  neither ss nor netstat available"
fi
echo

echo "--- 2. Docker containers and their published ports -------"
if command -v docker >/dev/null 2>&1; then
    docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
else
    echo "  docker not available to this user"
fi
echo

echo "--- 3. Docker Compose projects already on this host ------"
# Names only. Establishes that this project's own name is not already taken.
docker ps -a --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null \
    | grep -v '^$' | sort -u | sed 's/^/  /'
echo

echo "--- 4. Docker networks and volumes -----------------------"
echo "networks:"; docker network ls --format '  {{.Name}} ({{.Driver}})' 2>/dev/null
echo "volumes matching this project:"
docker volume ls --format '{{.Name}}' 2>/dev/null | grep -i 'm1m5' | sed 's/^/  /' || echo "  none yet (expected before first deploy)"
echo

echo "--- 5. Are the ports this project wants actually free? ---"
port_in_use() {
    local p="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$"
    else
        netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$"
    fi
}
for p in "$WANT_API_PORT" "$WANT_WEB_PORT"; do
    if port_in_use "$p"; then
        echo "  PORT $p: IN USE -- pick another and set API_HOST_PORT/WEB_HOST_PORT"
    else
        echo "  PORT $p: free"
    fi
done
echo
echo "  Note: the MT5 container publishes NO host port at all, so it cannot"
echo "  collide with anything. Only api and web need a host port, and both"
echo "  bind to 127.0.0.1 rather than 0.0.0.0."
echo

echo "--- 5b. Where the existing bots are deployed --------------"
# Answers "which directory should v2 use" from the host itself rather than
# from documentation that may be out of date.
echo "contents of /opt:"
ls -1d /opt/*/ 2>/dev/null | sed 's/^/  /' || echo "  (nothing in /opt)"
echo
echo "working directory of every running compose container:"
# The compose project's working_dir label is the authoritative answer for
# where each bot was actually deployed from.
docker ps --format '{{.Names}}' 2>/dev/null | while read -r c; do
    [ -n "$c" ] || continue
    wd=$(docker inspect "$c" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null)
    pr=$(docker inspect "$c" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null)
    [ -n "$wd" ] && echo "  $pr -> $wd"
done | sort -u
echo
echo "  This project must use a directory that appears NOWHERE above."
echo "  Suggested: /opt/trading-monitor-m1m5-v2"
echo

echo "--- 6. Wine prefixes present on this host ----------------"
# Confirms this project's prefix is distinct from every other bot's.
for d in /home/*/.mt5* /root/.mt5* /opt/*/.mt5*; do
    [ -d "$d" ] || continue
    owner=$(stat -c '%U:%G (%u:%g)' "$d" 2>/dev/null)
    terminal=$(find "$d" -name terminal64.exe -maxdepth 6 2>/dev/null | head -1)
    echo "  $d"
    echo "      owner:    $owner"
    echo "      terminal: ${terminal:-<none found>}"
done
echo
echo "  This project expects its OWN prefix at the path named by"
echo "  M1M5_WINEPREFIX_PATH (default /home/deploy/.mt5-m1m5-v2)."
echo "  If that path is missing, the one-time MT5 install has not been done."
echo "  If it is the SAME path as another bot's, STOP -- do not deploy."
echo

echo "--- 7. Running MT5 terminals -----------------------------"
ps -eo pid,user,args 2>/dev/null | grep -i '[t]erminal64.exe' | sed 's/^/  /' || echo "  none"
echo
echo "==========================================================="
echo " Nothing was started, stopped or modified by this script."
echo "==========================================================="
