#!/usr/bin/env bash
set -euo pipefail

# Phase 11 — Phase 0 §26: nightly logical pg_dump, 30-day rolling retention
# plus roughly one monthly snapshot kept longer. Runs pg_dump INSIDE the
# Postgres container (docker exec) so it works identically in dev and
# production — no local pg_dump binary or client/server version-matching
# needed on whatever host is doing the backing up.
#
# Usage: ./backup.sh   (reads POSTGRES_CONTAINER/POSTGRES_USER/POSTGRES_DB/
#                        BACKUP_DIR env vars, all optional — dev defaults below)

CONTAINER="${POSTGRES_CONTAINER:-autonomous-trading-postgres}"
DB_USER="${POSTGRES_USER:-autonomous_trading}"
DB_NAME="${POSTGRES_DB:-autonomous_trading}"
BACKUP_DIR="${BACKUP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/backups}"

mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT_FILE="$BACKUP_DIR/${DB_NAME}-${TIMESTAMP}.sql.gz"

echo "Backing up '$DB_NAME' from container '$CONTAINER' to $OUT_FILE"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --format=plain | gzip > "$OUT_FILE"
echo "Backup written: $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1))"

# Retention: delete daily dumps older than 30 days, except one taken on the
# 1st of its month (a simple, file-naming-based approximation of "one
# monthly snapshot kept a year" — good enough for the single-host nightly
# cron this is meant to run under; point BACKUP_DIR at off-host/mounted
# storage for the "off-host object storage" half of Phase 0 §26's design).
find "$BACKUP_DIR" -name "${DB_NAME}-*.sql.gz" -mtime +30 -not -name "${DB_NAME}-??????01T*.sql.gz" -print -delete
