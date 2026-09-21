#!/usr/bin/env bash
# Final isolation test for xauusd-m1-m5-rsi-threshold-v2 (section 14).
#
# Proves, on the VPS, that this project runs alongside the existing bots
# without touching them. Run it with everything up.
#
# ============================================================================
# READ-ONLY. Inspects the other bots; never modifies them.
#
# Section 14 is explicit that the other bots must not be modified merely to
# perform this verification, so this script only observes. It does not restart
# anything to "test" recovery, and it does not stop a container to see what
# happens.
# ============================================================================
set -uo pipefail

PROJECT="trading-monitor-m1m5-v2-prod"
FAIL=0
pass() { echo "  [PASS] $*"; }
fail() { echo "  [FAIL] $*"; FAIL=1; }
info() { echo "  [info] $*"; }

echo "======================================================================"
echo " Isolation verification: $PROJECT vs the other bots on this host"
echo " $(date -Is)"
echo "======================================================================"
echo

echo "--- 1. Compose projects present ---------------------------------"
docker ps --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | grep -v '^$' | sort | uniq -c | sed 's/^/  /'
echo

echo "--- 2. This project's containers --------------------------------"
OURS=$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}')
if [ -z "$OURS" ]; then
    fail "no containers running for $PROJECT"
else
    echo "$OURS" | sed 's/^/  /'
fi
echo

echo "--- 3. Other bots remain healthy --------------------------------"
OTHERS=$(docker ps --format '{{.Names}}\t{{.Status}}\t{{.Label "com.docker.compose.project"}}' \
         | grep -v "$PROJECT" || true)
if [ -z "$OTHERS" ]; then
    info "no other containers running on this host"
else
    echo "$OTHERS" | sed 's/^/  /'
    UNHEALTHY=$(echo "$OTHERS" | grep -ciE 'unhealthy|restarting|exited' || true)
    if [ "$UNHEALTHY" -gt 0 ]; then
        fail "$UNHEALTHY other container(s) are unhealthy/restarting -- investigate before proceeding"
    else
        pass "every other container is up"
    fi
fi
echo

echo "--- 4. No container-name collision -------------------------------"
DUPES=$(docker ps -a --format '{{.Names}}' | sort | uniq -d)
[ -z "$DUPES" ] && pass "container names are unique" || fail "duplicate names: $DUPES"
echo

echo "--- 5. No host-port collision ------------------------------------"
# Every published host port, with its owning container. A port appearing twice
# would mean two systems fighting over it.
docker ps --format '{{.Names}} {{.Ports}}' \
  | grep -oE '[0-9.]+:[0-9]+->' | sed 's/->//' | sort | uniq -c \
  | awk '$1>1 {print "  [FAIL] port published more than once: "$2; f=1} END {if(!f) print "  [PASS] no duplicated host port"}'
echo "  this project's published ports:"
docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '    {{.Names}}: {{.Ports}}'
echo

echo "--- 6. MT5 terminals are separate processes ----------------------"
ps -eo pid,args 2>/dev/null | grep -i '[t]erminal64.exe' | sed 's/^/  /' || info "no terminals visible from the host namespace (expected: containerised terminals are not listed here)"
echo "  terminal inside THIS project's MT5 container:"
# Before the one-time MT5 install this container deliberately refuses to start,
# so there is no terminal to find. That is the fail-closed gate working, not a
# fault, and reporting it as FAIL trains an operator to ignore this script.
# Only a container that IS running without a terminal is actually wrong.
if docker ps --filter "name=m1m5-v2-mt5-collector" --filter "status=running" -q | grep -q .; then
    docker exec m1m5-v2-mt5-collector pgrep -af terminal64.exe 2>/dev/null | sed 's/^/    /'         || fail "the MT5 container is running but no terminal process is present"
else
    info "MT5 container not running - expected until the one-time MT5 install is done; it refuses to start rather than attaching to another bot's terminal"
fi
echo

echo "--- 7. Wine prefixes are distinct --------------------------------"
OUR_PREFIX=$(docker inspect m1m5-v2-mt5-collector \
    --format '{{range .Mounts}}{{if eq .Destination "/wineprefix"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)
info "this project's prefix: ${OUR_PREFIX:-<unknown>}"
# Same rule as section 8: ours is decided by the compose project label, not by
# a name prefix. The prefix form happened to behave here only because this
# project's other containers have no /wineprefix mount -- luck, not design.
OUR_NAMES=$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}' | sort -u)
for c in $(docker ps --format '{{.Names}}' | grep -vxF -f <(echo "$OUR_NAMES") || true); do
    other=$(docker inspect "$c" --format '{{range .Mounts}}{{if eq .Destination "/wineprefix"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)
    [ -n "$other" ] || continue
    if [ "$other" = "$OUR_PREFIX" ]; then
        fail "$c shares this project's Wine prefix ($other) -- STOP, this is not isolated"
    else
        pass "$c uses a different prefix ($other)"
    fi
done
echo

echo "--- 8. Volumes are distinct --------------------------------------"
docker volume ls --format '{{.Name}}' | grep -i m1m5 | sed 's/^/  ours: /' || info "no m1m5 volumes yet"
# Ownership is decided by the COMPOSE PROJECT LABEL, never by a container-name
# prefix. Only three of this project's containers carry an explicit
# container_name; the rest take Compose's default naming
# (trading-monitor-m1m5-v2-prod-api-1 and so on). An earlier version matched
# on "^m1m5-v2-" and so reported this project's OWN api, web and redis as
# foreign, failing a deployment that was correctly isolated.
#
# A verification script that cries wolf is worse than no script, because an
# operator learns to skip past it.
OURS_IDS=$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" -q | sort -u)
SHARED=$(echo "$OURS_IDS"   | xargs -r docker inspect --format '{{range .Mounts}}{{.Name}} {{end}}' 2>/dev/null   | tr ' ' '
' | grep -v '^$' | sort -u)

VOL_FAIL=0
for v in $SHARED; do
    mounters=$(docker ps -a --filter "volume=$v" -q | sort -u)
    foreign=$(comm -23 <(echo "$mounters") <(echo "$OURS_IDS") | grep -v '^$' || true)
    if [ -n "$foreign" ]; then
        for f in $foreign; do
            fail "volume $v is also mounted by $(docker inspect --format '{{.Name}}' "$f" 2>/dev/null) (not in this project)"
        done
        VOL_FAIL=1
    fi
done
[ "$VOL_FAIL" -eq 0 ] && pass "no volume of this project is mounted by a foreign container"
echo

echo "--- 9. Account identity ------------------------------------------"
docker exec m1m5-v2-mt5-collector bash -lc 'echo "  configured account: $MT5_EXPECTED_LOGIN"' 2>/dev/null \
    || info "container not running"
echo "  (the collector refuses to run if the terminal reports a different one)"
echo

echo "======================================================================"
if [ "$FAIL" -eq 0 ]; then
    echo " ISOLATION VERIFIED. No other bot was modified by this check."
else
    echo " ISOLATION PROBLEM FOUND -- see [FAIL] lines above. Do not enable"
    echo " execution until they are resolved."
fi
echo "======================================================================"
exit "$FAIL"
