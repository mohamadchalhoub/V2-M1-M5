# Gold-live historical evaluation (task step 7) — three outputs

This does not re-run or re-derive new numbers — it POINTS TO the existing, already-computed,
already-honest v2 study output (frozen research code, unmodified by the execution-wiring work
in this directory) as Outputs A and B, and reports Output C's actual (empty) status directly.
No parameter was tuned in response to these results, before or after reading them.

## Output A — eligible first-return events, and Output B — one-position simulation

Full detail: `backend/research-output/xauusd-h4-confirmed-retest-v2/runs/end-20260915T064600Z__spec-45160276ec48/REPORT.md`
(spec hash `45160276ec48c41b00648abc91866b04d9a4c0be1086379eb54f5683e14de0e6`, frozen endpoint
2026-09-15T06:46:00.000Z, study start 2024-03-01). This is the same rule set the gold-live spec
(`XAUUSD_H4_CONFIRMED_RETEST_GOLD_LIVE_V1_SPEC.md`) inherits unchanged from v2 — no formation,
window, TP/SL, or ambiguity-handling difference exists between what this report evaluated and
what `gold-execution/`'s coordinator will trigger on live.

**Summary (see the report for full breakdown, including per-year and D1-agreement buckets):**
- Output A (event study): 57 eligible first-return events (full period), 19 WIN / 33 LOSS / 5
  AMBIGUOUS / 0 INDETERMINATE / 0 UNRESOLVED. Resolved win rate 19/52 = 36.5% (Wilson 95%:
  24.8%–50.1%). BUY(support) 10/31 = 32.3%; SELL(resistance) 9/21 = 42.9%.
- Output B (one-position paper simulation, $10,000 sensitivity branch, ASSUMED_BASE costs):
  44–45 trades, 14–18 W / 27–30 L, net P&L **$-178.40 … $-108.45** (a loss), profit factor
  0.43–0.62, max drawdown 1.71–2.21%.
- **Pre-declared mechanical conclusion: LOSING UNDER TESTED ASSUMPTIONS** (Wilson upper bound
  50.1% is below the 52.0% assumed-cost breakeven). This is reported as-is, per the task's own
  "a losing/inconclusive result is NOT a blocker — do not tune parameters to improve it" rule.
  **No formation, window, or risk parameter was changed after seeing this result**, before or
  during building the execution pipeline in this directory.

This result does not by itself block activation — the task explicitly separates "does the
strategy currently look profitable in this backtest" from "is the system correctly, safely
built to run it on demo." Both are reported honestly; activation proceeds on the latter only
if a positive DEMO trade_mode confirmation is obtained (see `DEMO_HANDOFF.md`).

## Output C — actual forward demo trades

**Empty as of this evaluation — genuinely, not by omission.** No gold order has ever been
placed by this system. Verify directly at any time via
`GET /research/gold-execution-status`'s `recentDecisions`/`closedTrades` arrays (both empty
until a real signal fires and the coordinator queues/executes an order), or by querying
`AutonomousDecision` rows with `symbol='XAUUSD'` directly (table remains empty here).

This will remain the honest state — "running and waiting for a qualifying signal" — until a
genuine confirmed-retest-v2 first-return event fires live, inside the entry window, with an
approved risk-gate verdict, while `GOLD_EXECUTION_MODE=DEMO`.
