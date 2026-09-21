#!/usr/bin/env bash
# Verification pass: full backend suite, alternating pre-change baseline (f459067)
# and current branch (0c18bc6) worktrees, same machine, same shared test DB,
# same concurrently running dev backend/frontend/collector. Sequential only.
OUT="$1"
for round in 1 2; do
  for label in baseline current; do
    wt="/c/Users/user/Desktop/tma-wt-$label/backend"
    start=$(date -u +%FT%TZ)
    ( cd "$wt" && timeout 1500 node_modules/.bin/vitest run --reporter=default --reporter=json --outputFile="$OUT/$label-round$round.json" > "$OUT/$label-round$round.log" 2>&1 )
    echo "$label round$round exit=$? start=$start end=$(date -u +%FT%TZ)" >> "$OUT/sequence.log"
  done
done
echo DONE >> "$OUT/sequence.log"
