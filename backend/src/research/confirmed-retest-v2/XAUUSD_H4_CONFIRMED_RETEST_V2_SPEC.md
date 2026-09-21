# xauusd-h4-confirmed-retest-v2 — Frozen Research Specification

**Status:** FROZEN 2026-09-15, before any aggregate result of this version was computed or read.
**Machine-readable form:** `spec.ts` (`SPEC`); `SPEC_HASH` = SHA-256 of its canonical JSON, printed
by every run and stamped on every output file.
**Scope:** research, historical replay only in this task. **No order path exists** (verified the
same way as v1 — no import of any order/execution module anywhere in this directory).
**Provenance:** `SPEC.provenance = 'GPT_AUTHORIZED_RESEARCH_REVISION_OF_V1'`. **This is a GPT-
authorized research revision of v1's formation rule, not a faithful restatement of the friend's
discretionary method, and not a claim that the change is an improvement.** It is one bounded,
frozen, single-run test.

v1 is **untouched** — frozen, in its own directory (`src/research/confirmed-retest/`), its
zero-level result and conclusion unchanged and not recycled here. EURUSD, `h4-trend-h1-breakout-v1`,
and every execution/order-related setting are untouched by this task.

---

## 1. What changed from v1, and why

v1 required TWO H4 swing pivots of the same role at the **exact same price** (to the broker cent),
5–120 H4 bars apart. Zero such pairs ever fell inside that window across the whole study, so v1
never produced a sample. v2 replaces the second-pivot-exact-match rule with a **retest of the
original pivot price L** — the level price never moves; only a later candle needs to return to it.
Everything else (pivot detection, the $10 rejection-close qualification, the body filter, the
lifecycle/dedup state machine, session window, exits, paper simulation, cost/risk assumptions) is
carried over from v1 unchanged (see `spec.ts` inline comments for exactly which fields changed).

## 2. Formation — processed chronologically, bar by bar, no look-ahead

1. **Pivot L** — identical to v1: strict 2-left/2-right H4 swing (resistance = pivot high, support =
   pivot low). Becomes a *candidate* only once the second following candle closes.
2. **Initial rejection requirement** — identical to v1: at least one of the two candles confirming
   the pivot must close ≥ $10 away from L in the favorable direction. Unqualified pivots are logged
   but never watched for a retest.
3. **Retest candle R** — the earliest H4 bar with index in `[pivotIndex+5, pivotIndex+120]`
   (inclusive both ends):
   - Resistance: `R.high >= L` and `R.open <= L` and `R.close <= L`.
   - Support: `R.low <= L` and `R.open >= L` and `R.close >= L`.
   - R's own extreme need **not** equal L (an overshoot wick past L, with the body still respecting
     it, still counts). L itself never changes.
4. **Body filter** — from the pivot bar (exclusive) through the eventual confirmation bar
   (inclusive), no H4 body may extend beyond L on the breakout side (equality at a body edge is
   allowed) — same rule as v1's, applied incrementally as each bar arrives rather than retroactively
   over a stored pair span. A violation at any point invalidates the candidate immediately; no later
   retest is tried for that pivot.
5. **Confirmation** — R itself, or one of the next two *completed* H4 candles after R, must close
   ≥ $10 favorably from L. Activation happens at the first such close — **never backdated to R**. If
   none of R/R+1/R+2 qualifies, the candidate is retired; formation does **not** keep searching for a
   later retest for that same pivot.
6. Freeze L; record the pivot's and the retest/confirmation bars' timestamps and H4 indices.
7. **Dedup** — same-price/same-role candidates: the earliest one to reach ACTIVE owns the level's
   key. A later same-price candidate confirming while the key is `ACTIVE` or `RETIRED_UNTIL_BREAK`
   is blocked; after a confirmed break (`BROKEN`), the next pivot whose own index is after the break
   may start a new generation — identical retirement/generation state machine to v1's.
8. D1 agreement remains descriptive only (unchanged from v1), never an entry filter.

## 3. Events, lifecycle, session, exits — unchanged from v1

Formation touches are not entries. The first subsequent return strictly after activation is
evaluated exactly as in v1: outside-window consumption, invalidation, 120-H4-bar expiry, and no
daily reset of level eligibility are all preserved verbatim (same `replay.ts`/`gaps.ts`/`outcome.ts`
modules, reused unmodified from v1's own audited files — see `report.ts`'s header). Gold entries:
04:00 inclusive–12:00 exclusive Asia/Beirut; BUY support / SELL resistance; TP/SL each $10;
no holding deadline; M1 primary resolution, ticks optional and used only when attested complete;
gap and unresolved-event handling unchanged. Event statistics (Output A) remain independent of the
one-position paper simulation (Output B). Paper volume stays the user-fixed 0.01 lots with v1's
existing risk caps (0.5% stop-risk cap, 1% combined, 2% daily loss, 5% drawdown) — none of these
were touched or re-tuned.

## 4. Time evidence — what this run can and cannot claim

See `TIME_EVIDENCE.md` in this directory and `../confirmed-retest/verification/VERIFICATION_REPORT.md`
§1.5. **Not all historical timestamps are claimed verified.** The EET/EEST broker-clock
re-interpretation is live-measured for EU summer (EEST, UTC+3) as of 2026-09-15; the winter offset
(EET, UTC+2) rests only on historical break-time arithmetic, not a live measurement. Session-window-
filtered results (which events are `eligible`, the paper simulation) for touches in a winter month
are therefore **assumption-dependent**, reported as such, never silently treated as verified. The
all-hours formation funnel (pivot/retest/confirmation counts) does not depend on the session window
and is reported without that caveat.

## 5. Implementation notes

- Formation-agnostic modules (`types.ts`, `time.ts`, `gaps.ts`, `outcome.ts`, `data-source.ts`,
  `statistics.ts`, `paper.ts`, `audit.ts`, `replay.ts`, `pipeline.ts`) are physically copied from
  v1's own audited files with only the relative-import-driven coupling to `spec.ts`/`levels.ts`
  changed by virtue of living in this directory — their logic is byte-identical to v1's except
  `types.ts`'s `Level`/`PivotRecord` shapes (extended for the pivot+retest model) and `report.ts`'s
  level-row/formation-text formatting (adapted to the new diagnostics fields).
- `levels.ts` is new: single-pivot watch-list engine (see its own header comment) replacing v1's
  pair-formation engine. Every other rule (lifecycle, break/expiry, D1 tag) is unchanged.
- Tests: `test/research/confirmed-retest-v2/formation.spec.ts` — retest formation, an overshoot
  wick that rejects without a body violation, failed confirmation (retire, no further search),
  activation timing (never backdated to R), no-future-data-use, distance-window boundaries, body
  filter (violation and allowed equality), same-price dedup, and pivot qualification.
