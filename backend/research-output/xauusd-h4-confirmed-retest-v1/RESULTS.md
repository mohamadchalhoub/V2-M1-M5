# xauusd-h4-confirmed-retest-v1 — Results and Status (2026-09-14, updated 2026-09-15)

**2026-09-15 update:** gold collection alongside EURUSD was completed and turned on this session
(see `MORNING_HANDOFF.md`). The study was re-run against the extended data through the new frozen
endpoint **2026-09-14T20:00:00Z** (data hash `fcc24632…70cd`, commit `f10c9c9`,
`runs/end-20260914T200000Z__spec-bc43a393385f/`) — **the conclusion is unchanged: still zero
levels, still INSUFFICIENT EVIDENCE.** The section below describes the original 2026-09-11 run;
its reasoning and every number in it still hold on the newer run (re-verify with
`runs/end-20260914T200000Z__spec-bc43a393385f/formation.json` if wanted — pivot/rejection counts
shift by only the ~3 additional days of H4 bars, and no new exact-price pair appeared).
A separate verification pass (`verification/VERIFICATION_REPORT.md`, 2026-09-15) independently
re-derived this same zero-level result and resolved the timestamp-basis question referenced there.

## Conclusion in plain language

**Insufficient evidence.** Under the frozen rules, not a single level ever formed on the configured
broker's XAUUSD data, so there were no first returns, no trades, and nothing to win or lose.

Why: the rules require two H4 swing highs (or lows) at *exactly the same price to the cent*. Across
5,618 H4 bars (Jan 2023 → Sep 2026) there were 1,567 swing candidates, 1,208 of which showed a ≥ $10
rejection. Only **one** pair of same-role swings ever shared an exact price (support $1,956.71 on
2023-05-24 and 2023-11-07), and it was far outside the 5–120-bar window. Inside the window: **zero**.

This is a valid result of the rules as written, not a bug and not a verdict on the friend's idea:
- An independent SQL recount of pivots, qualifications and exact pairs matches the engine exactly.
- Descriptively only (no outcomes computed, no rule change): of ~25,000 same-role pivot pairs 5–120
  bars apart, 0 are exact, 15 are within 5¢ and 45 within 10¢. The exact-cent requirement is what binds.
  Any tolerance would be a **new version** with its own freeze; nothing here recommends one.

The pre-declared conclusion rule (spec §11) gives INSUFFICIENT EVIDENCE because W+L = 0 < 30.
It is neither "promising" nor "losing" — there is simply no sample.

## Deliverables

| What | Where |
|---|---|
| Frozen rule specification + provenance (friend vs GPT) | `backend/src/research/confirmed-retest/XAUUSD_H4_CONFIRMED_RETEST_V1_SPEC.md`, `spec.ts` (hash `bc43a393…d695`) |
| Audit of the earlier first-touch engine; retired claims | `backend/src/research/confirmed-retest/ENGINE_AUDIT.md` |
| Historical run (machine-readable) | `runs/end-20260911T200000Z__spec-bc43a393385f/` — `manifest.json`, `coverage.json`, `formation.json`, `pivots.csv`, `levels.*`, `events.*`, `event-study.json`, `paper-summary.json`, `paper-branches.json`, `REPORT.md` |
| Reproduce the run | `cd backend; npm run confirmed-retest:study -- --end 2026-09-11T20:00:00.000Z` (expects data hash `ecffa99b…639cb`) |
| Watch-only runner | `cd backend; npm run confirmed-retest:watch [-- --interval-seconds 300]` — state/journal in `backend/research-state/` (git-ignored) |
| Dashboard | "Gold Retest Research" nav item → `/research/xauusd-confirmed-retest` (backend `GET /research/xauusd-confirmed-retest`) |
| Tests | `backend/test/research/confirmed-retest/*.spec.ts`; collector `tests/test_backfill_gold_history.py` |

Git: the spec, engine and tests were committed (`a42c7bc`) **before** the first real-data run.

## Data coverage evidence (frozen endpoint 2026-09-11T20:00Z)

- Broker: MetaQuotes-Demo, login 5055783885, account trade mode DEMO, `Metals\XAUUSD`, digits 2
  (backfill log 2026-09-13 + `symbol_metadata`). Per-row candle `server` columns are NULL.
- Rows used: M1 879,503 · M5 176,144 · M15 59,720 · M30 30,059 · H1 15,364 · H4 5,618 · D1 1,006.
  0 non-cent prices, 0 OHLC violations, 0 duplicates/non-increasing, 0 grid misalignments, 0 weekend bars.
- **Stored MT5 bar times are broker-server clock (EET/EEST), not UTC.** Evidence: the daily break sits at
  a constant ~17:00 New York (16:00 after the broker's April-2026 change) straight through the US/EU
  DST-mismatch weeks after conversion, but moves by an hour in the raw stored times.
- Study-period M1 gaps: 651 confirmed closures, 99 unconfirmed-but-M5-bridged (225 min), 47 unconfirmed
  unbridged (5,517 min; e.g. 2025-07-03 00:03Z 549 min, 2025-01-07 02:03Z 180 min, a cluster of late
  session opens in Dec 2025). 1,816 M5 bars substituted for a 9-day M1 hole (2026-05-19→28) that the
  download ledger marks COMPLETED.
- Broker H4 vs M1 aggregate: 3,877 of 3,920 exact; 2 mismatches; 41 H4 bars with no M1 (the May hole).
- Ticks: 0 stored (earlier tick backfill failed; not retried). No live XAUUSD quote. No account snapshot.
  No historical spread (M1 spread column NULL). All costs are labeled scenarios.

## Output A / Output B

- Output A (event study): 0 eligible events; W 0 · L 0 · AMBIGUOUS 0 · INDETERMINATE 0 · UNRESOLVED 0;
  0 GAP_CROSS, 0 UNOBSERVABLE, 0 outside-window consumptions. No yearly/half-year buckets exist.
- Output B (one position): 0 entries and 0 skips in every scenario. Had events existed, the primary
  assumed-$1,000 run would have skipped every one: 0.01 lot × $10 stop = $10 = 1% > 0.5% cap.

## Engine verification

- 96 focused tests: formation timing, exact prices, strictness, distance bounds, $10 rejection
  boundary, body filter, partners, expiry, breaks, retire-until-break and generations, D1 tag,
  first return strictly after activation, wick touches, Beirut window + DST, GAP_CROSS, unobservable
  gaps, bridges, entry-candle reachability vs a brute-force path oracle (mutation-checked), gap-open
  exits, same-bar ambiguity, tick attestation, combined branch status, one-position gates, same-minute
  re-entry, forks and halts, daily-loss and drawdown blocks, costs, restart/split equivalence, spec-hash
  refusal, quote gate, locking, volume audit, dashboard read path and a static no-order boundary.
- The split/resume test found and fixed a real persisted-state bug (shared pivot references).
- Real-data watch cycle: bootstrap + resume ran against the local database (no new data to process).
- The dashboard page was rendered by Next.js against the real run output (HTTP 200, no runtime errors).
- Full backend suite: 1,144 of 1,147 passed; the 3 failures (analytics edge cases, analytics fixtures,
  technical-analysis integration — code this work did not touch) passed 33/33 when re-run in isolation,
  i.e. intermittent under full-suite load, not regressions. Collector backfill tests: 20/20.
- Regenerated at commit `b918a0e` (clean tree): identical data hash and result.

## Findings outside this version (not changed)

- `h4-trend-h1-breakout-v1` uses the same server-clock candle times as if they were UTC: its backtest's
  `isWithinEntryWindow(candle.openTime)` shifts the 03:00–12:00 Beirut window by 2–3 h, and its live
  coordinator's "completed bar" filter lags by 2–3 h. Left untouched as instructed; needs its own fix.
- The collector comment "candle OHLC bar times genuinely are UTC" is incorrect.

## Outstanding operational limitations

1. The database stops at 2026-09-11 20:00Z. The broker has newer bars, but the MT5 terminal and the
   backend API were not running, and the live collector syncs only EURUSD candles. No connection was made.
2. The watch runner runs only when invoked; nothing schedules it. Forward observations begin only once
   new gold bars are stored.
3. Shadow entries will be skipped as `QUOTE_UNAVAILABLE` until an XAUUSD live quote is stored; the
   `live_ticks.tick_at` time basis for gold is unverified (future-dated quotes fail the gate).
4. No demo equity snapshot exists, so paper results use an assumed balance.
5. Previously inspected history is not a pristine holdout; only future watch-only observations are
   forward evidence — and with exact-cent levels they may be very rare.

## Resume command

Prerequisites: MT5 terminal logged in to MetaQuotes-Demo and the backend API reachable at the
collector's configured URL (the backfill pushes candles through it). Then, from PowerShell:

```powershell
cd C:\Users\user\Desktop\trading-monitor-autonomous\collector; .\.venv\Scripts\python.exe backfill_gold_history.py --candles-only; if ($?) { cd ..\backend; npm run confirmed-retest:study; npm run confirmed-retest:watch }
```
