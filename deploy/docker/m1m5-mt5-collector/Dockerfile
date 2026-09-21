# Isolated MT5 + Wine-hosted Python collector for xauusd-m1-m5-rsi-threshold-v2.
#
# ============================================================================
# WHY THIS NEEDS ITS OWN CONTAINER AT ALL
#
# This is not stylistic isolation. The MetaTrader5 Python package's IPC
# connection to terminal64.exe binds a FIXED, non-configurable local port under
# Wine (observed: 22346), and that bind is per-HOST, not per-WINEPREFIX. Two
# Wine-hosted MT5 terminals sharing one network namespace collide on it
# regardless of separate prefixes, /portable mode, or an RPyC bridge layer
# (which wraps the same underlying constraint rather than fixing it).
#
# That finding is recorded in the sibling deployment's own Dockerfile, where it
# was established by direct testing rather than guessed. This project inherits
# the conclusion and the remedy: a container gets its own network namespace, so
# THIS container's internal 127.0.0.1:22346 is simply a different address space
# from the host's and from any other bot's. No collision is possible, and no
# host port is involved.
#
# Consequently this service publishes NO host ports. It reaches the backend
# over its own Compose project's internal Docker network by service name.
# ============================================================================
#
# Deliberately a SEPARATE image from the sibling deployment's mt5-collector,
# not a shared base. They must be rebuildable, restartable and removable
# independently; sharing an image tag would couple their lifecycles, and a
# rebuild of one would change what the other runs.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# This project's OWN Wine prefix path inside the container. The host directory
# bind-mounted here is v2-specific too (see docker-compose.prod.yml) and must
# never be the sibling deployment's prefix.
ENV WINEPREFIX=/wineprefix
ENV DISPLAY=:0

RUN dpkg --add-architecture i386 && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg xvfb x11-utils procps && \
    mkdir -pm755 /etc/apt/keyrings && \
    wget -O - https://dl.winehq.org/wine-builds/winehq.key | gpg --dearmor -o /etc/apt/keyrings/winehq-archive.key && \
    wget -NP /etc/apt/sources.list.d/ https://dl.winehq.org/wine-builds/ubuntu/dists/jammy/winehq-jammy.sources && \
    apt-get update && \
    apt-get install -y --install-recommends winehq-staging && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Build context is the repo root, so this project's real collector source is
# baked in at build time -- the same immutable-image pattern the API uses, not
# a live bind mount that would drift from whatever happened to be on disk when
# the container started.
#
# NOTE: no secret is copied here. Credentials arrive at RUN time via env_file
# (collector/.env.production, gitignored), never baked into the image.
COPY collector/ /app/

COPY deploy/docker/m1m5-mt5-collector/entrypoint.sh /entrypoint.sh
COPY deploy/docker/m1m5-mt5-collector/verify-mt5-readiness.py /verify-mt5-readiness.py
RUN chmod +x /entrypoint.sh

# Readiness, as far as it can be established from inside without a broker
# round trip: the terminal process is alive and the Wine prefix is the one this
# service was configured with. The authoritative check -- account identity,
# DEMO status, hedging mode, trade permissions -- is
# verify-mt5-readiness.py, which talks to the running terminal.
HEALTHCHECK --interval=30s --timeout=15s --start-period=180s --retries=3 \
    CMD pgrep -f terminal64.exe > /dev/null && test -d "$WINEPREFIX" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
