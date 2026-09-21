#!/bin/bash
# Entrypoint for the isolated v2 MT5+collector container. WINEPREFIX
# (/wineprefix) is a bind-mounted volume onto the host's already-installed
# MT5 terminal (installed once, interactively via VNC, before this container
# existed) — this script never reinstalls the terminal itself, only ensures
# the Wine-hosted Windows Python interpreter + collector deps are present
# (idempotent, safe to run on every container start), then launches the
# terminal and the collector.
set -e

PYTHON_DIR="$WINEPREFIX/drive_c/Program Files/Python312"
PYTHON_EXE="$PYTHON_DIR/python.exe"
TERMINAL_EXE="$WINEPREFIX/drive_c/Program Files/MetaTrader 5/terminal64.exe"

# Defensive: `restart: unless-stopped` restarts THIS SAME container (same
# /tmp) on a crash, not a fresh one — a stale lock from a previous failed
# attempt would otherwise make every retry fail on "Server already active"
# rather than the real underlying error.
rm -f /tmp/.X0-lock

echo "[entrypoint] starting Xvfb on $DISPLAY..."
Xvfb "$DISPLAY" -screen 0 1280x1024x24 -nolisten tcp &
XVFB_PID=$!
sleep 2

if [ ! -f "$PYTHON_EXE" ]; then
    echo "[entrypoint] Windows Python not found in this prefix — installing (one-time, silent)..."
    if [ ! -f /tmp/python-installer.exe ]; then
        curl -fsSL https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe -o /tmp/python-installer.exe
    fi
    wine /tmp/python-installer.exe /quiet InstallAllUsers=1 PrependPath=0 Include_launcher=0 Include_test=0 Include_doc=0
    wineserver -w
fi

echo "[entrypoint] installing/verifying collector Python deps..."
wine "$PYTHON_EXE" -m pip install --upgrade pip --quiet
wine "$PYTHON_EXE" -m pip install -r /app/requirements.txt --quiet

echo "[entrypoint] launching MT5 terminal..."
wine "$TERMINAL_EXE" /portable &
TERMINAL_PID=$!
sleep 15

echo "[entrypoint] launching collector (main process)..."
cd /app
exec wine "$PYTHON_EXE" main.py
