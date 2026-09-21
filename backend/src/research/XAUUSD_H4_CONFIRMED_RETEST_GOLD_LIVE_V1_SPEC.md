# xauusd-h4-confirmed-retest-gold-live-v1 — Versioned Spec (pre-execution)

**Status:** DRAFT / NOT YET FROZEN — written before any execution code exists, before any new
evaluation run, and before any activation. This documents the intended live-execution version
of the strategy; it does not itself change v1 or v2's frozen research files.

**Provenance:** direct restatement of the friend's rules (see `FRIEND_RULES_AND_IMPLEMENTATION.md`
at repo root) using `confirmed-retest-v2`'s formation engine (retest-of-L model) as the
formation/event engine, unchanged. This is NOT a further research revision — no formation
parameter differs from v2. What this version adds is execution-side scope only: occupancy
locking, risk gating against real equity, broker order submission, and control modes.

## 1. Inherited unchanged from v2
Pivot detection (2-left/2-right strict H4 swing), $10 rejection-close qualification, retest
model (return to fixed L, 5–120 H4 bars, body filter, confirmation within R/R+1/R+2, never
backdated), lifecycle/dedup/retirement state machine, D1 descriptive tag, session window
(04:00 inclusive–12:00 exclusive Asia/Beirut), TP/SL $10 each, no max holding, wick-touch
detection, ambiguous-outcome flagging. See `confirmed-retest-v2/spec.ts` (`SPEC`) — this
version's formation config is byte-identical; `SPEC_HASH` from v2 is reused as-is.

## 2. Added for live execution (new, not in v2 — all currently DRAFT/unimplemented)
- **Strategy identifier / magic number:** to be assigned (reserve a value distinct from any
  existing strategy's magic number before first live order — not yet allocated as of this
  draft).
- **Occupancy:** at most one active XAUUSD position under this strategy AND counting any
  manual/other-strategy/pending/UNKNOWN XAUUSD exposure — reserved persistently before order
  submission, reconciled against broker state on every restart.
- **Volume:** fixed 0.01 lots (user-controlled only), validated against live broker
  min/max/step before every submission; invalid → skip + log reason, never resize.
- **Risk gate:** 0.5% per-trade stop-risk cap, 1% combined open-risk cap, 2% daily loss cap,
  5% drawdown cap — all computed against live account equity queried at decision time, not an
  assumed balance.
- **Max entry deviation:** frozen conservative default of 0.20% of the trigger price (to be
  confirmed against any existing executor limit in the codebase before first use; if an
  existing limit is found elsewhere in the repo, that value supersedes this default) — skip
  (never chase) if the executable price has moved beyond this bound between signal and send.
- **Modes:** OFF / SHADOW / DEMO. STOP NEW ENTRIES is rechecked immediately before every send.
  Protective monitoring (SL/TP/emergency handling) continues in all modes except OFF.
- **No real-money fallback, ever**, under any condition.

## 3. What is NOT yet true (as of this draft)
No code implementing section 2 exists yet. No evaluation under this version's execution rules
has been run. No demo order has been placed. This spec exists to be versioned *before* that
work proceeds, per the task's own instruction not to build first and document later.

See `IMPLEMENTATION_CHECKPOINT.md` at repo root for exact remaining steps and current status.
