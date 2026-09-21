#!/usr/bin/env bash
set -euo pipefail

# Phase 11 — Phase 0's own Definition of Done for this phase: "a restore is
# exercised at least once before deployment is considered complete, not
# assumed to work because the dump completed without error." Always
# restores into a NEW target database (never overwrites an existing one,
# including the source) — the caller decides via TARGET_DB whether that's a
# disposable drill database or the real name being stood up on a fresh host.
#
# Usage: ./restore.sh <dump-file.sql.gz> <target-db-name>

CONTAINER="${POSTGRES_CONTAINER:-autonomous-trading-postgres}"
DB_USER="${POSTGRES_USER:-autonomous_trading}"
DUMP_FILE="${1:?Usage: restore.sh <dump-file.sql.gz> <target-db-name>}"
TARGET_DB="${2:?Usage: restore.sh <dump-file.sql.gz> <target-db-name>}"

echo "Creating target database '$TARGET_DB' in container '$CONTAINER'"
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE \"$TARGET_DB\";"

echo "Restoring $DUMP_FILE into '$TARGET_DB'"
gunzip -c "$DUMP_FILE" | docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$TARGET_DB" > /dev/null

echo "Restore complete. Row counts in '$TARGET_DB':"
docker exec "$CONTAINER" psql -U "$DB_USER" -d "$TARGET_DB" -c "
  SELECT 'trading_accounts' AS table_name, COUNT(*) FROM trading_accounts
  UNION ALL SELECT 'trades', COUNT(*) FROM trades
  UNION ALL SELECT 'alerts', COUNT(*) FROM alerts
  UNION ALL SELECT 'rule_definitions', COUNT(*) FROM rule_definitions
  UNION ALL SELECT 'account_snapshots', COUNT(*) FROM account_snapshots;
"
