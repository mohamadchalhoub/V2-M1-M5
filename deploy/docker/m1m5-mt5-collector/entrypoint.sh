#!/bin/bash
# Entrypoint for the isolated xauusd-m1-m5-rsi-threshold-v2 MT5 + collector
# container.
#
# WINEPREFIX (/wineprefix) is a bind-mounted volume onto this project's OWN
# host directory, holding its OWN MT5 terminal installation (installed once,
# interactively, before this container is first started -- see
# V2_MT5_RUNTIME.md). This script never installs the terminal; it verifies the
# environment, ensures the Wine-hosted Windows Python and collector
# dependencies are present (idempotent, safe on every start), launches the
# terminal, and then runs the collector as the main process.
#
# ============================================================================
# THIS SCRIPT FAILS CLOSED.
#
# Every check below exits non-zero rather than continuing. That is deliberate
# and it is the whole point of the file: this host runs more than one MT5
# terminal, and a collector that starts "successfully" against the wrong
# prefix, the wrong terminal or the wrong account is far worse than one that
# refuses to start. The first failure is loud and recoverable in seconds; the
# second is silent and can mean acting on another system's positions.
# ============================================================================
set -euo pipefail

log() { echo "[m1m5-mt5] $*"; }
die() { echo "[m1m5-mt5][FATAL] $*" >&2; exit 1; }

PYTHON_DIR="$WINEPREFIX/drive_c/Program Files/Python312"
PYTHON_EXE="$PYTHON_DIR/python.exe"

# ---------------------------------------------------------------------------
# 1. Wine prefix must exist and be writable.
#
# A missing prefix means the bind mount is wrong or the one-time install was
# never done. Wine would otherwise CREATE an empty prefix here, which looks
# like success and contains no terminal -- so this is checked explicitly.
# ---------------------------------------------------------------------------
[ -d "$WINEPREFIX" ] || die "WINEPREFIX $WINEPREFIX does not exist. The host directory is not mounted, or the one-time MT5 install was never performed. Refusing to let Wine create an empty prefix that would look like success."
[ -w "$WINEPREFIX" ] || die "WINEPREFIX $WINEPREFIX is not writable by uid $(id -u). The container 'user:' must match the uid/gid owning the host directory."

# ---------------------------------------------------------------------------
# 2. The terminal path must be configured explicitly and must exist.
#
# MT5_TERMINAL_PATH is a Windows-style path the collector hands to
# MetaTrader5.initialize(). Its Linux-side equivalent is checked here, because
# an unset or wrong path makes initialize() AUTO-DISCOVER a terminal -- and on
# this host the one it finds could belong to another bot.
# ---------------------------------------------------------------------------
[ -n "${MT5_TERMINAL_PATH:-}" ] || die "MT5_TERMINAL_PATH is not set. Refusing to start: without it the MetaTrader5 package auto-discovers a terminal, which on this host may be another bot's."

# Translate C:\... to the prefix's drive_c for an existence check.
TERMINAL_REL="${MT5_TERMINAL_PATH#[A-Za-z]:}"
TERMINAL_REL="${TERMINAL_REL//\\//}"
TERMINAL_EXE="$WINEPREFIX/drive_c${TERMINAL_REL}"
[ -f "$TERMINAL_EXE" ] || die "Configured terminal not found at $TERMINAL_EXE (from MT5_TERMINAL_PATH=$MT5_TERMINAL_PATH). Refusing to fall back to auto-discovery."

# ---------------------------------------------------------------------------
# 3. The account must be named explicitly, and consistently.
#
# The collector re-verifies this against what the terminal actually reports
# after connecting. This is the earlier, cheaper half of the same check.
# ---------------------------------------------------------------------------
[ -n "${MT5_EXPECTED_LOGIN:-}" ] || die "MT5_EXPECTED_LOGIN is not set. Refusing to start without knowing which account this collector is allowed to use."
if [ -n "${MT5_LOGIN:-}" ] && [ "${MT5_LOGIN}" != "${MT5_EXPECTED_LOGIN}" ]; then
    die "MT5_LOGIN (${MT5_LOGIN}) and MT5_EXPECTED_LOGIN (${MT5_EXPECTED_LOGIN}) name different accounts."
fi
# Deliberately logs the login only. Never the password, and never the token.
log "configured account: ${MT5_EXPECTED_LOGIN} on ${MT5_SERVER:-<server unset>}"
log "wine prefix       : $WINEPREFIX"
log "terminal          : $TERMINAL_EXE"

# ---------------------------------------------------------------------------
# 4. Xvfb. `restart: unless-stopped` restarts THIS SAME container on a crash,
# so a stale lock from a previous failed attempt would otherwise make every
# retry fail on "Server already active" rather than on the real error.
# ---------------------------------------------------------------------------
rm -f /tmp/.X0-lock
log "starting Xvfb on $DISPLAY ..."
Xvfb "$DISPLAY" -screen 0 1280x1024x24 -nolisten tcp &
sleep 2

# ---------------------------------------------------------------------------
# 5. Wine-hosted Windows Python and collector dependencies. Idempotent.
# ---------------------------------------------------------------------------
if [ ! -f "$PYTHON_EXE" ]; then
    log "Windows Python not present in this prefix -- installing (one-time, silent) ..."
    if [ ! -f /tmp/python-installer.exe ]; then
        curl -fsSL https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe -o /tmp/python-installer.exe
    fi
    wine /tmp/python-installer.exe /quiet InstallAllUsers=1 PrependPath=0 Include_launcher=0 Include_test=0 Include_doc=0
    wineserver -w
    [ -f "$PYTHON_EXE" ] || die "Windows Python install did not produce $PYTHON_EXE."
fi

log "installing/verifying collector dependencies ..."
wine "$PYTHON_EXE" -m pip install --upgrade pip --quiet
wine "$PYTHON_EXE" -m pip install -r /app/requirements.txt --quiet

# ---------------------------------------------------------------------------
# 6. Terminal, then collector.
#
# /portable keeps the terminal's data beside the installation inside THIS
# prefix rather than in a shared Windows profile location.
# ---------------------------------------------------------------------------
log "launching MT5 terminal ..."
wine "$TERMINAL_EXE" /portable &
sleep "${MT5_TERMINAL_WARMUP_SECONDS:-20}"

if ! pgrep -f terminal64.exe > /dev/null; then
    die "MT5 terminal is not running after launch. Check the container logs above for Wine errors; the collector is NOT started, so it cannot fall back to another terminal."
fi
log "terminal is running."

# Optional gate: refuse to start the collector unless the full runtime
# verification passes. Off by default so the container can be brought up for
# the one-time interactive login; turn it on for unattended operation.
if [ "${MT5_VERIFY_ON_START:-false}" = "true" ]; then
    log "running runtime readiness verification ..."
    wine "$PYTHON_EXE" /verify-mt5-readiness.py || die "Runtime MT5 readiness verification failed. The collector is NOT started."
fi

log "launching collector (main process) ..."
cd /app
exec wine "$PYTHON_EXE" main.py
