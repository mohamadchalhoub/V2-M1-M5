# Verification pass — xauusd-h4-confirmed-retest-v1 (2026-09-15)

This is a verification pass over the frozen v1 study. **v1's rules and its zero-sample
conclusion are unchanged.** Nothing here is a claim about whether the friend's discretionary
method succeeds or fails — v1 found no exact-price pivot pair in the required 5–120 H4-bar
window, so there is no sample to draw any such conclusion from. Every number in this document
was independently re-derived; none is copied from the v1 run without re-checking.

All evidence files referenced below live in this directory. Scripts are read-only (Mt5Client
connect/disconnect and MetaTrader5 read-only calls only; no `order_*` function is imported or
called anywhere in this pass).

---

## 1. Timestamp interpretation — RESOLVED, with a new finding

**Status: `VERIFIED`.** Stored MT5 bar and tick epochs are broker-server wall clock
(IANA `EET`: UTC+2 winter / UTC+3 summer, EU DST rules), not true UTC. v1's `data-source.ts`
conversion is correct. This overturns the collector's own inline claim that "OHLC bar times...
genuinely are UTC" (`mt5_client.py:723`) and that tick `time_msc` "IS already true UTC"
(`mt5_client.py:447` — that field itself is fine, see §1.4; the problem is the bar `time` field
and, separately, the live sync's query bounds).

### 1.1 What new evidence overturned the earlier "verified UTC" claim

The earlier claim was never actually live-tested for candle bars. Tracing its origin
(`git log -p -- collector/app/mt5_client.py`, commit `215c5b2`) shows it was introduced
alongside `_mt5_time_to_utc()`, which *was* verified live — but only for **position/deal**
`time` fields (`DEPLOYMENT_SESSION_2026-09-09.md` §9: 12 real trades, MT5 under Wine,
`history_deals_get()`). That same document explicitly notes `copy_rates_range()` (candles)
"does not share this bug" — referring only to the *argument-type* bug (datetime vs epoch), not
to the *return-value* labeling, which was never tested. The "candles are UTC" comment in
`mt5_client.py` is therefore an unverified generalization from a different, real bug about a
different field. New evidence in this pass: three independent, fresh, live tests (below), one
of which is a decisive position-based fetch that takes no datetime argument at all and so cannot
be confounded by the query-bound bug found in §1.3.

### 1.2 Independently timed fresh observation

Captured 2026-09-15T00:05Z. System clock cross-checked against the HTTP `Date` header of
`google.com` (agreement within 1 second — `mt5-live-time-evidence.json.clock_before/after`).

- **XAUUSD live tick**, fetched twice 4 seconds apart, `time_msc` advancing at 1× real-time
  speed (genuinely live, not cached): `time` and `time_msc` both read **exactly +3.000h** ahead
  of the externally-verified system UTC.
- **Position-based fetch** (`copy_rates_from_pos`, **no datetime argument passed to MT5 at
  all** — this is the decisive test, immune to any query-bound conversion bug): EURUSD's newest
  M1 bar and XAUUSD's newest M1 bar both read **+3.0h** ahead of true UTC.

This directly measures the broker's return-value convention with nothing else in the pipeline
that could itself be mislabeled. Script: `capture_mt5_time_evidence.py`; raw output:
`mt5-live-time-evidence.json`.

### 1.3 A second, separate bug this pass found: date-bound queries hide the true offset

An initial "sanity" check (comparing the collector's own DB-stored candle time against true
system UTC) appeared to show *no* offset — which contradicted §1.2. Isolating why:
`copy_rates_range`'s `date_from`/`date_to` arguments, when passed as true-UTC Python
`datetime` objects, are matched by MT5 against its own server-clock-labeled epoch scale
digit-for-digit — the same category of bug `DEPLOYMENT_SESSION_2026-09-09.md` already found
and fixed (`_utc_to_mt5_epoch`) for `history_deals_get()`'s bounds, but **never fixed or even
recognized for candle queries**. Direct test: passing `date_to` = true UTC "3 hours before now"
still returned the bar ending at server-clock "now minus ~0 minutes" (`ts_diagnostic3.py`
reproduced in the capture script's `datetime_bound_test`) — i.e. the bound is honored as if it
were server-clock digits, not true UTC.

**Consequence:** `runner.py`'s live incremental candle sync (`_sync_candles` →
`datetime.now(tz=timezone.utc)` as `now`, `mt5_client.py:459`) silently drops roughly the most
recent *offset-hours* (2–3h) of every symbol's candle history on every cycle, because
`get_candles()`'s "still forming, skip" filter (`open_time + bar_duration > now`) compares a
server-labeled `open_time` against a true-UTC `now` and treats the genuinely-latest, real bars
as if they were in the future. The DB's "latest stored row looks only ~13 minutes old" is an
artifact of this same bug, not evidence of correct labeling — confirmed directly: the DB's
actual latest EURUSD M5 row (`2026-09-14 21:00:00`, server-labeled) is **~3h20m stale** in true
UTC once converted, while the position-based fetch in §1.2, taken at essentially the same
moment, shows genuinely current data exists at the source. This is a live operational gap, not
a hypothetical: **the ongoing candle sync is currently running behind by roughly the broker's
own UTC offset**, on every configured symbol, until fixed. It does not affect ticks (§1.4) or
historical backfill runs, which use `copy_rates_range` with wide date ranges the effect doesn't
meaningfully truncate.

**No fix was applied.** This report only documents and evidences the finding, per the
instruction not to modify breakout strategy behavior based on interpretation work, and per the
instruction against unrelated refactors this session.

### 1.4 What is *not* affected

- `time_msc` (ticks) is correct as documented once queried without a broken date bound: live,
  two fetches 4s apart show it advancing at 1× speed and (via the DB's already-EET-corrected
  `LiveTickDto.tickAt`, computed by `_mt5_time_to_utc` in `get_live_tick`) matching backend
  receipt time within ~3 seconds (`docker exec ... select ... from live_ticks` — see full run
  log). Historical tick backfill (`get_ticks`, `copy_ticks_range`) uses `time_msc` directly and
  needs no correction.
- Historical candle backfill (`backfill_gold_history.py`) requests wide date ranges up front,
  so the §1.3 bug does not truncate its results the way the live 5-minute incremental sync is
  affected.

### 1.5 Broker DST rule: EU vs Lebanon vs a NY-anchored server clock

Per instruction, the broker's DST rule was **not** assumed equal to Asia/Beirut's. Every
stored XAUUSD bar (M1: 879,503 rows; H4: 5,619; D1: 1,007) was converted three ways and
compared (`compare-dst-rules.ts`, `dst-rule-comparison.json`):

| Candidate broker rule | Bars that disagree with `EET` (EU rules) |
|---|---|
| IANA `Asia/Beirut` (Lebanon rules) | **0 of 886,129** |
| IANA `America/New_York` offset + 7h (a NY-close-anchored server) | 74,767 of 886,129 (on 54–74 distinct dates — exactly the US/EU DST-mismatch weeks) |

`EET` and `Asia/Beirut` are indistinguishable on this dataset (their DST transition dates
coincided for every bar in range); a NY-anchored rule is **rejected** by 74,767 bars.
Independently, the 2024–2025 daily-break arithmetic (`break-arithmetic-observed.psv`, computed
against a NY-17:00-close true-UTC anchor) matches an EU-DST-observing server exactly, to the
minute, in all three regimes (winter/summer/US-only-DST mismatch) — see the frozen spec's §3.2
for the derivation, now corroborated by the live position-based test in §1.2. `Asia/Beirut` was
**not** used as the correction (the frozen spec already uses `EET` for the broker and
`Asia/Beirut` separately, only for the trading window) — this check exists solely to confirm
that choice was not accidentally masking a Lebanon-specific assumption; it wasn't, because the
two rules never diverge on this dataset.

**Residual limitation, left explicitly unresolved:** the winter offset (+2h) is confirmed only
by the historical break-pattern arithmetic, not by a live measurement (today is deep in EU
summer DST). No stored timestamp was rewritten and no historical study number was recomputed
under a new interpretation — v1's `SPEC.data.brokerServerTimezone = 'EET'` was already correct
and is unchanged.

### 1.6 Raw epoch → DB → research conversion, with matching records

Full chain, traced with real, currently-stored rows (`match_raw_to_db.py`,
`raw-to-db-trace.json`):

1. **Raw MT5 epoch** — `MetaTrader5.copy_rates_from_pos(...)` → `rates['time']` (int, seconds).
2. **Python decode** — `collector/app/mt5_client.py:408`, `get_candles()`:
   `datetime.fromtimestamp(int(r["time"]), tz=timezone.utc).isoformat()`.
3. **API payload** — `collector/app/api_mapper.py:121`, `build_candles_payload()`:
   `"openTime": c["open_time"]` (the string from step 2, unchanged).
4. **DTO validation** — `backend/src/market-data/dto/candles-push.dto.ts`,
   `IncomingCandleDto.openTime` (`@IsISO8601()`, no conversion).
5. **DB write** — `backend/src/market-data/historical-candle.service.ts:54`:
   `new Date(c.openTime)` into `open_time`, column type
   `TIMESTAMP(3)` **without time zone** (`migration 20260906203717_add_historical_candles`) —
   Postgres stores the wall-clock digits verbatim; no zone math happens in the database.
6. **Research read/convert** — `backend/src/research/confirmed-retest/data-source.ts`:
   `EXTRACT(EPOCH FROM open_time)` → `wallClockToUtc('EET', serverT)`.

Matched, currently-stored examples (`raw-to-db-trace.json`):
- XAUUSD H4: 40 fetched bars, 34 matched to an existing DB row by identical `open_time`
  digits, **34/34 OHLC equal** at the broker's own price precision (2 digits). Example:
  raw epoch `1789156800` → decoded `2026-09-11T20:00:00Z` → DB `open_time` identical →
  research-converted true UTC `2026-09-11T17:00:00Z` → Beirut `2026-09-11T20:00:00+03:00`.
- EURUSD M5: 80 fetched bars, 42 matched, **42/42 OHLC equal** at broker precision (5 digits;
  the earlier "exact-float" mismatch count in the export is IEEE-754 representation noise, e.g.
  `1.1555900000000001` vs `1.15559` — not a real difference, and disclosed as such in the export).
- 38 of the 80 fetched EURUSD bars had no DB row yet at capture time — consistent with, and
  additional evidence for, the §1.3 sync-lag finding (the newest real bars had not yet been
  written by the currently-running collector).

### 1.7 Impact on the research module vs. the existing breakout backtest

- **`confirmed-retest` (this study):** No impact — `data-source.ts` already converts server
  clock to true UTC before anything else runs, and was already correct.
- **`h4-trend-h1-breakout-v1` backtest:** `backend/src/trend-breakout/backtest.ts` calls
  `isWithinEntryWindow(candle.openTime)` directly on the DB's server-labeled value, with no
  conversion anywhere in that file. Effect quantified by calling the strategy's own, unmodified
  `isWithinEntryWindow` on stored-style timestamps (`breakout-window-impact.ts`,
  `breakout-window-impact.json`) — the intended window is 03:00–12:00 Asia/Beirut; what the
  backtest actually admits, in **true** Beirut time, is:

  | Regime | Admitted (true Beirut time) |
  |---|---|
  | Winter (2025-01-15) | 01:00 – 09:00 |
  | US-DST-only mismatch week (2025-03-19) | 01:00 – 09:00 |
  | Summer (2025-07-16) | 00:00 – 08:00 |

  i.e. the whole window is shifted roughly 2–3 hours earlier than intended, and its length is
  right at the edge of being preserved (9h admitted vs. 9h intended) only because the window
  edges shift together. The live coordinator's own "completed bar" filter
  (`trend-breakout-coordinator.service.ts:91-92`) is affected by the same §1.3 mechanism during
  live operation. **No code change was made to `trend-breakout/`** — this section only reports
  the measured impact, as instructed.

---

## 2. Zero-level verification — independent export

Independent SQL (`zero-level-independent.sql`, full output `zero-level-independent.out.txt`),
written without reference to the TypeScript engine, run against the same bar set the frozen
v1 run used (5,618 stored XAUUSD H4 bars, server time `2023-01-26 00:00` through
`2026-09-11 16:00`, i.e. every H4 bar closing at or before the frozen endpoint).

- **Pivot and rejection counts:** RESISTANCE 774 candidates, 573 qualified (≥$10 rejection
  close by the second following bar), 201 rejected. SUPPORT 793 candidates, 635 qualified, 158
  rejected. Matches the frozen run's `formation.json` exactly.
- **The one exact-price pair, any distance:** SUPPORT $1,956.71 — first pivot H4 index 502
  (server time `2023-05-24 16:00:00`), second pivot H4 index 1215 (server time
  `2023-11-07 12:00:00`), **index separation 713 bars** — outside the required 5–120 window.
  Matches `pivots.csv` from the frozen run (`pv:SUPPORT:502` / `pv:SUPPORT:1215`, both price
  `1956.71`) exactly, including that the first pivot did **not** qualify.
- **Was the ~25,000-pair population filtered to 5–120 bars? Yes, explicitly.** The SQL's join
  condition is `b.idx - a.idx BETWEEN 5 AND 120`; the result is 12,317 RESISTANCE pairs and
  12,809 SUPPORT pairs already inside that window (25,126 total) — this is descriptive-only
  (near-miss distribution), not a relaxed formation rule. Within that population: **0 exact
  matches** (confirming the one exact match above is the *only* one, and it falls outside the
  window); 6 RESISTANCE / 9 SUPPORT pairs within 5 cents; 13 / 17 within 6–10 cents; only
  10 RESISTANCE / 18 SUPPORT pairs are *both individually qualified* and within 10 cents of
  each other. No parameter was searched or widened to produce this table.
- **Price precision follows broker metadata, not an assumed cent rounding:** joined against
  live `symbol_metadata` (`digits=2`, `point=0.01`, `trade_tick_size=0.01`, captured
  2026-09-13, re-confirmed live in this pass — `contract-metadata-and-risk.json`). Every one of
  5,619 stored XAUUSD H4 rows is an exact multiple of `trade_tick_size` (`mod(price,
  0.01) = 0` for all four OHLC fields, 0 violations) — the comparison uses the broker's own
  tick size, not a hand-picked rounding.
- **Formation happens before any session or account-risk gate, by construction, not just by
  observation:** `src/research/confirmed-retest/levels.ts` (pivot/pair/activation logic) has
  **zero** imports beyond `./spec` and `./types`, and zero references to session windows,
  Beirut time, risk, equity, balance, volume, or quotes (grepped directly). `replay.ts`
  processes H4/D1 bars (`processHigherTimeframes`, which drives `levels.ts`) *before* it
  computes the touch/session-window check for the current bar. The one-position simulation
  (`paper.ts`) only ever receives the finished list of `FirstReturnEvent`s as input — it cannot
  see or influence which levels formed. With zero levels, this is architectural, not merely
  observed: there is nothing for the session window or the risk caps to act on.

---

## 3. Risk and reporting distinction

- **Event statistics stay independent of account equity** — confirmed unchanged: `Output A`
  (`statistics.ts summarizeEventStudy`) takes only `FirstReturnEvent[]`, never a balance,
  volume, or cost. (With zero events this pass has nothing new to report here; the separation
  itself is what's being confirmed.)
- **The $1,000 assumed paper scenario is retained**, labeled exactly as before
  (`SPEC.paper.startingBalances[0]`, `ASSUMED_1000_PRIMARY`) — not changed, not removed.
- **Why entries would be blocked, precisely:** live-captured XAUUSD contract metadata
  (`capture_contract_metadata.py`, `contract-metadata-and-risk.json`) —
  `trade_contract_size = 100 oz`. At the frozen 0.01 lot and $10 stop distance, the nominal
  stop risk is `0.01 × 100 × $10 = $10.00` (USD, the symbol's profit currency), which is 1% of
  a $1,000 balance — above the frozen 0.5% stop-risk cap (`SPEC.paper.maxStopRiskPctOfEquity`)
  and exactly at the 1% combined cap, so every simulated entry under the $1,000 scenario would
  be skipped with reason `STOP_RISK_EXCEEDS_0_5_PCT` (confirmed against `paper.ts`'s actual gate
  logic, not re-derived by hand).
- **Minimum nominal equity for the fixed-volume risk cap, reported for transparency only — not
  a funding recommendation, and volume/risk are unchanged:**
  - Stop-risk cap (0.5%, the binding one): **$2,000.00** (`$10.00 / 0.5%`).
  - Combined-risk cap (1.0%): **$1,000.00** (`$10.00 / 1.0%`).
  - The account's own currency is EUR; at the account's current EUR/USD conversion (via
    `trade_tick_value_loss`, itself a **current, not historical**, rate — disclosed as such in
    the export) the €-denominated stop risk is ≈€1.00 per 0.01 lot, for reference only.
- **Assumed vs. observed, restated (unchanged from the historical run):** no demo equity
  snapshot exists for this account (`account_snapshots` table: 0 rows) and no historical
  XAUUSD spread/commission/swap evidence exists (`historical_candles.spread` is `NULL` for
  every stored row) — both remain labeled assumptions, not observations.

---

## 4. The three full-suite failures — investigated, not dismissed by isolation

Per instruction, the three intermittent failures were **not** waved off because their isolated
re-runs passed. Instead: the **entire backend suite** (`npm run test`, the same command that
originally produced the 3 failures) was run **twice on the pre-change baseline commit
(`f459067`, the tip of this branch before this work began) and twice on the current commit
(`0c18bc6`)**, in separate `git worktree`s sharing the same test database and running
**concurrently with the same live dev backend/frontend/collector processes** this session had
already started — i.e. under the same resource contention as the run that first produced the
failures, not an isolated, quiet environment.

| Run | Files | Tests | Passed | Failed |
|---|---|---|---|---|
| baseline round 1 | 339 | 1,051 | 1,051 | 0 |
| current round 1 | 370 | 1,147 | 1,147 | 0 |
| baseline round 2 | 339 | 1,051 | 1,051 | 0 |
| current round 2 | 370 | 1,147 | 1,147 | 0 |

(`full-suite/*.json`, `full-suite/sequence.log`.) Zero failures across all four full-suite runs,
on **both** commits, under equivalent-or-worse contention than the original run. This is
evidence *for* pre-existing flakiness (intermittent, resource-contention-sensitive, present
before this session's changes and absent from this session's changes) — not proof it can never
recur, but a genuine comparison, not a dismissal based on isolation. `current` naturally has
more files/tests than `baseline` (this session's added `research/confirmed-retest` suite,
1,147 − 1,051 = 96, matching exactly).

No test was modified, skipped, or weakened to obtain this result.

---

## 5. Completion accuracy

- **Completed and verified this pass:** the timestamp-basis interpretation (§1, with one new
  operational finding left as a documented gap, not silently fixed); the zero-level result
  (§2, independently reproduced); the risk/reporting separation and its minimum-equity
  arithmetic (§3); the full-suite flakiness investigation (§4).
- **Implemented but not yet run continuously:** the watch-only workflow
  (`src/research/confirmed-retest/watch.ts`, `watcher.ts`, `scripts/confirmed-retest-watch.ts`)
  is code, verified with unit tests and short bounded live cycles — it is not installed as an
  OS service and is not currently running as a long-lived process. See `MORNING_HANDOFF.md`
  for its current status, exact start command, and what it found when run.
- **Not available in this pass:** a live XAUUSD quote young enough to pass the shadow-entry
  gate's 5-second freshness requirement, and a live demo equity snapshot. Both are collection
  gaps, not code gaps — see `MORNING_HANDOFF.md`.
- **No broker order was placed, modified, or closed. No strategy behavior was changed.**
  `AUTONOMOUS_EXECUTION_ENABLED` remained `false` throughout every check in this pass (verified
  live via a fresh collector startup log and via the config test suite).
