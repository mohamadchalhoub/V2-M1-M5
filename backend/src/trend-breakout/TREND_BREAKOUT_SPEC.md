# Trend-breakout strategy (v3) — `h4-trend-h1-breakout-v1`

Replaces the weekly H4 support/resistance rule (`backend/src/autonomous/`,
`AUTONOMOUS_RULE_ENGINE_SPEC.md`) as the strategy under active development.
That strategy — archived under `weekly-h4-sr-v1` (`../strategy-versions.ts`)
— is left completely untouched: its code, tables, and historical decisions
remain exactly as interpretable as before.

**Execution is disabled throughout this implementation.** No collector poll
step or scheduler exists for this strategy; nothing here has ever placed a
broker order. See §9 ("remaining prerequisites") below before that changes.

## 1. The rule, as implemented

- **Instruments**: EURUSD and gold-vs-USD (canonical id `XAUUSD`), each
  mapped to an explicit, validated broker symbol (`instrument-config.ts`).
  Ambiguous mappings (a gold cross against a non-USD currency, two
  instruments resolving to the same broker symbol) are rejected outright.
- **H4 trend filter**: EMA50 vs EMA200 on H4 closes, plus H4 close vs
  EMA200 — all three strictly on the same side (`signal-engine.ts`).
- **H1 breakout entry**: signal candle S closes strictly beyond the high/low
  of the preceding 20 H1 candles (excluding S), AND the immediately
  preceding H1 candle must NOT have already broken its own prior-20 range
  (the "fresh breakout" condition — prevents repeated entries while price
  sits beyond an old range).
- **Volatility filter**: S's own H-L range must be `<= 2 x A`, where A is
  ATR14 (Wilder smoothing) computed through the H1 candle immediately
  preceding S — frozen for the whole setup, never recomputed.
- **Entry timing**: fill at the first executable quote after S closes (buy
  at ask, sell at bid); the setup expires 60 seconds after S's close; the
  executable price must be within `0.25 x A` of S's close (gap/chase
  filter) or the setup is dropped, never retried on a later bar.
- **SL/TP**: stop `1.5 x A`, target `3 x A` (a 2:1 structure before costs),
  rounded to the broker's real price increment (`sl-tp.ts`) — a setup whose
  increment would collapse or invert the stop/target is rejected, never
  silently widened.
- **Exits**: full-position SL or TP only. No partial exits, trailing stops,
  breakeven moves, time-based exits, or Friday/noon closures. A position
  can stay open overnight or across a weekend until SL/TP.
- **Schedule**: entries only 03:00:00-12:00:00 Beirut local time
  (`Asia/Beirut`, real IANA/DST-aware), checked at signal time AND again
  immediately before submission (`schedule.ts`). Existing positions are
  managed outside this window; only NEW entries are gated.
- **Concurrency**: one active trade per instrument, enforced by a database
  primary key (`TrendBreakoutSlotLock`, `slot-lock.service.ts`) — not an
  in-memory check — so it holds across restarts and multiple workers.
  Occupied by a pending request, an open position, or an unresolved/UNKNOWN
  outcome alike.
- **Volume**: fixed, user-controlled, per instrument (§2's 0.12 EURUSD /
  0.01 gold initial values) — never resized by risk logic. A trade whose
  fixed volume would breach a risk/margin limit is skipped, not shrunk.
- **Account protection** (`risk-policy.ts`, `risk-state.service.ts`):
  per-trade risk cap (0.5% equity), combined cap across both instruments
  (1%), daily loss block (2%, Beirut calendar day, cash-flow-adjusted,
  persisted), drawdown block (5% below a durable cash-flow-adjusted high,
  cleared only by explicit reset), max spread (10% of D), max quote age
  (5s). Missing equity/metadata/conversion-rate data fails closed.
- **Emergency handling** (`emergency-handler.ts`): a confirmed missing/
  unverifiable protective stop attempts to re-establish it once, verifies,
  closes the position if it's still unprotected, and always blocks new
  entries plus records a critical incident — regardless of whether the
  immediate remediation succeeded (see that file's own design-decision
  comment for why "always blocks" was the safer reading of an ambiguous
  spec point).

Every signal-candle evaluation — HOLD included — is logged to
`TrendBreakoutDecision` with the full gate-by-gate breakdown, frozen
inputs, and (once execution exists) fill/reconciliation state.

## 2. Deliberate design decisions worth flagging

- **A HOLD's reason is always specific** — `gateResults` records every gate
  in order, not just the failing one, so "why didn't this trade" never
  needs re-derivation.
- **The emergency handler always blocks entries once invoked**, even if its
  own remediation succeeds cleanly (MITIGATED) — clearing that block is a
  separate, explicit human action. The spec's 5 steps don't spell this out
  explicitly; this is the conservative reading, stated plainly in code.
- **The backtest engine cannot model the literal 60-second expiry** against
  hourly bars (the earliest a bar-only backtest can fill is up to 3600s
  after S's close) — it fills at the next H1 open instead and applies the
  real gap/chase price filter there. This is a disclosed approximation,
  not a silent one (`backtest.ts`'s own module comment), and does not
  apply to the live/operational code path (`entry-timing.ts`), which does
  enforce the literal 60s rule against real sub-minute quotes.
- **Deposit/withdrawal detection for the daily-loss cash-flow adjustment is
  not wired up** — `recordCashFlow` exists and is unit-tested, but nothing
  calls it yet; `dailyNetCashFlow` is 0 in practice until a real detector
  is built (see §9).

## 3. Real backtest result (EURUSD, full available history)

2023-12-11 through 2026-09-09 (~2.75 years), H4-trend/H1-breakout rules run
exactly as specified (no parameter search): **76 trades, 38.16% win rate,
profit factor 1.28, total P&L +$316.32 (0.12 lots, $100,000 contract size,
15pt assumed spread, no commission/swap modeled), max drawdown $335.40.**
Reproduce with `npm run backtest-trend-breakout` in `backend/`. Gold and the
combined (shared-account) backtest could not be run against real data —
this database has zero historical XAUUSD candles — see that script's own
output for the full caveat list.

## 4. Unresolved limitations / remaining prerequisites before demo execution

1. **No live MT5 terminal was connected in this session** — `SymbolMetadata`
   (broker volume min/max/step, price increment, contract size, profit
   currency) is empty for both instruments. Every volume/price-rounding
   check fails closed until the collector pushes real data via the new
   `POST /collector/symbol-metadata` route (`mt5_client.py`'s
   `get_symbol_info`, wired but not yet called by `runner.py` on a
   schedule — that wiring is the next step, deliberately not added
   automatically per this task's "existing collector behavior stays
   unchanged unless explicitly turned on" posture).
2. **No account-equity data exists** for the dedicated demo account (zero
   `AccountSnapshot` rows) — every risk gate that needs equity fails closed
   until the collector/snapshot pipeline is actually running against it.
3. **Gold has no historical candle data** — `CANDLE_SYMBOLS` was never
   configured to include XAUUSD; back-filling it requires a live terminal
   session, not something this sandboxed task could do.
4. **Deposit/withdrawal detection** (§2 above) is not built — the daily-loss
   gate's cash-flow adjustment is structurally ready but inactive.
5. **No scheduler calls `TrendBreakoutCoordinatorService.evaluateAll()`** —
   by design, matching the legacy system's own "code exists and is tested,
   does not run unsupervised until a human wires it up" posture.
6. **The collector's execution-poll step for this strategy does not exist**
   — `executor.py`'s primitives (`send_bracket_order`, `close_position`,
   `find_open_position`, `find_any_position`) are generalized and tested
   for multi-symbol use, but nothing in `runner.py` calls them for this
   strategy yet, and a dedicated magic number for it still needs to be
   picked (distinct from the legacy strategy's `AUTONOMOUS_MAGIC_NUMBER`).
7. **Full margin-requirement and broker trading-session/permission checks**
   are not implemented — this codebase's `AccountSnapshot` carries balance/
   equity/margin/freeMargin but not leverage or per-symbol trading-session
   state, and no live terminal was available to extend that in this
   session.
