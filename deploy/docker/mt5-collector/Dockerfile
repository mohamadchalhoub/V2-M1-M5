# Isolated MT5 + Wine-hosted Python collector for v2 (gold-execution), built
# specifically to solve a real constraint found deploying alongside v1 on the
# same VPS: the MetaTrader5 Python package's IPC connection to terminal64.exe
# binds a fixed, non-configurable local port under Wine (observed: 22346),
# and that bind is per-HOST, not per-WINEPREFIX — two Wine-hosted MT5
# terminals on the same host's network namespace collide on it regardless of
# separate prefixes, /portable mode, or an RPyC bridge layer (which wraps the
# SAME underlying constraint, not a fix for it). A Docker container's own
# network namespace sidesteps this entirely: this container's internal
# 127.0.0.1:22346 is simply a different address space from the host's or
# v1's, so no collision is possible. This container is deliberately attached
# to autonomous-trading_internal (Docker network, this project's Compose
# project) rather than any host port — the collector reaches the backend via
# Docker DNS (http://api:3000), never through the host loopback ports v1's
# own services occupy.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV WINEPREFIX=/wineprefix
ENV DISPLAY=:0

RUN dpkg --add-architecture i386 && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg xvfb x11-utils && \
    mkdir -pm755 /etc/apt/keyrings && \
    wget -O - https://dl.winehq.org/wine-builds/winehq.key | gpg --dearmor -o /etc/apt/keyrings/winehq-archive.key && \
    wget -NP /etc/apt/sources.list.d/ https://dl.winehq.org/wine-builds/ubuntu/dists/jammy/winehq-jammy.sources && \
    apt-get update && \
    apt-get install -y --install-recommends winehq-staging && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Build context is the repo root (see docker-compose.prod.yml) so the real
# collector/ source is baked in at build time, same immutable-image pattern
# api/web already use — not a live bind mount, which would drift from
# whatever happened to be on disk at container start.
COPY collector/ /app/

COPY deploy/docker/mt5-collector/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
