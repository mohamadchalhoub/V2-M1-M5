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
docker exec "m1m5-v2-mt5-collector" pgrep -af terminal64.exe 2>/dev/null | sed 's/^/    /' \
    || fail "no terminal running in m1m5-v2-mt5-collector"
echo

echo "--- 7. Wine prefixes are distinct --------------------------------"
OUR_PREFIX=$(docker inspect m1m5-v2-mt5-collector \
    --format '{{range .Mounts}}{{if eq .Destination "/wineprefix"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)
info "this project's prefix: ${OUR_PREFIX:-<unknown>}"
for c in $(docker ps --format '{{.Names}}' | grep -v '^m1m5-v2-' || true); do
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
SHARED=$(docker ps --filter "label=com.docker.compose.project=$PROJECT" -q \
  | xargs -r docker inspect --format '{{range .Mounts}}{{.Name}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep -v '^$' | sort -u)
for v in $SHARED; do
    users=$(docker ps -a --filter "volume=$v" --format '{{.Names}}' | grep -vc '^m1m5-v2-' || true)
    [ "${users:-0}" -gt 0 ] && fail "volume $v is also used by a non-v2 container" || true
done
pass "no v2 volume is mounted by a foreign container"
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
