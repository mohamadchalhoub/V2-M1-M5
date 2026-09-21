# Candle-sync lag fix — 2026-09-15 (follow-up)

## 1. The defect, exactly

`collector/app/mt5_client.py`'s `get_candles()` passed true-UTC
`date_from`/`date_to` straight into `mt5.copy_rates_range()`. MT5 compares
those bounds against each bar's **raw** `time` field — broker-server
wall-clock digits mislabeled as UTC (same quantity `_mt5_time_to_utc()`
already corrected for positions/deals; the verification pass on
2026-09-15 confirmed candle bars share this same mislabeling, contrary to
this file's own earlier docstring claim that "candle OHLC bar times
genuinely are UTC"). Because the broker is ahead of true UTC (EET: +2
winter / +3 summer, currently +3), a true-UTC `date_to` numerically
compares as *less than* the raw epoch of any bar from roughly the last
broker-offset hours — MT5 silently excludes them. The excluded window
looked like it "caught up" one poll cycle later only because true time had
by then advanced past the stale cutoff, giving the illusion of a healthy,
merely-slightly-behind sync rather than a persistent multi-hour gap.

**The fix is query-bound only.** `date_from`/`date_to` are now converted
with the existing `_utc_to_mt5_epoch()` helper (the same one already used
for `history_deals_get()`) before being passed to `copy_rates_range()`.

## 2. What was deliberately NOT changed

The returned bar's own `time` field (`r["time"]`) is still stored exactly
as before: a plain naive-decode of the raw epoch, i.e. still the
broker-mislabeled wall-clock digits, not corrected to true UTC. This
preserves the same storage convention as every one of the ~2.4M already-
stored `historical_candles` rows, which the confirmed-retest research
layer (`backend/src/research/confirmed-retest/data-source.ts`'s
`wallClockToUtc`) and `spec.ts`'s `brokerServerTimezone: 'EET'` already
assume and correct for at *read* time. An earlier version of this fix
(committed only locally within this session, superseded before any commit
landed) also "corrected" `r["time"]` here — that was wrong: it would have
double-converted every future bar against the historical convention and
silently shifted all new candles by the broker's own UTC offset relative
to old ones. Caught before commit by re-deriving the offset live (see
`proof.json`) and checking `data-source.ts` directly, not assumed.

The "still forming" cutoff (which excludes the currently-open bar) was
updated to compare like with like: it now converts true "now" into the
same broker-mislabeled epoch before comparing against `r["time"]`, instead
of comparing a true-UTC "now" against a mislabeled bar time (which would
have wrongly called every recent bar "still forming").

## 3. Live, bounded proof (`prove_candle_sync_fix.py` → `proof.json`)

Captured together, same short window, against the real MT5 terminal and
the real database (collector still running the OLD code at capture time):

| | Old code (reproduced live) | Fixed code (live) | DB (still on old code) |
|---|---|---|---|
| Newest XAUUSD M1 bar's raw/displayed time | `2026-09-15T06:45:00+00:00` (looks 50s old) | `2026-09-15T09:44:00+00:00` (raw, by design) | `2026-09-15T06:41:00Z` (looks 4m36s old) |
| That bar's **true UTC** open time | `2026-09-15T03:45:00+00:00` | `2026-09-15T06:44:00+00:00` | `2026-09-15T03:41:00+00:00` |
| **Actual staleness** | **10,850s (≈3h 1m)** | **110s (≈1m 50s)** | **≈3h 4m** (matches old code) |

Same result for EURUSD. This is the exact "looks fresh, is actually ~3h
stale" illusion documented as an open item in the prior session's
`MORNING_HANDOFF.md` — now quantified with a concrete before/after pair
instead of described qualitatively.

## 4. Restart / incremental-fetch behavior, verified live

The two collector processes that had been running the pre-fix code (PIDs
`2712`, `10524` — the latter an unexplained stray duplicate, also stopped)
were stopped and one fresh process started
(`collector/logs/collector_post_fix.log`). First cycle: XAUUSD M1 pushed 8
bars in one batch (catching up the ~3h gap in one incremental step, cursor
= last stored candle time, not a fixed lookback), all other timeframes
resumed from their own stored cursors with no duplication (`upserted`
counts matched `batch_size`, i.e. no conflict/error). Confirmed via direct
SQL immediately after: newest stored XAUUSD M1 raw-labeled open time
`09:45:00`, i.e. true UTC `06:45:00` — about 2 minutes stale against a true
"now" of `06:46:58`, consistent with the fixed code's own live reading
above. No credentials changed; same account, same `.env`.

## 5. Scope of what this live observation proves — and does not

- Proves, for **today, EU summer time (EEST, UTC+3)**, both symbols
  (EURUSD and XAUUSD), the M1/M5/M15/M30/H1/H4/D1/W1/MN1 timeframes
  currently configured, and this specific broker/account
  (MetaQuotes-Demo, login 5055783885): the query-bound fix restores
  the sync to within ~2 minutes of true UTC, vs. ~3 hours stale before.
- Does **not** newly verify the winter (EET, UTC+2) offset — that remains
  exactly as unresolved as the prior verification report left it (§1.5):
  confirmed only by historical break-time arithmetic, not a live
  measurement, because today is deep in EU summer DST. The dashboard and
  research report must not describe the whole year as time-verified on
  the strength of this check.
- Does **not** touch or re-verify the historical tick backfill (still
  failing, still not retried, out of scope) or the one-off
  `backfill_gold_history.py` historical candle backfill (uses the same
  `get_candles()` and so benefits from the same fix automatically, but was
  not re-run — its date ranges are fixed historical windows, not
  "now"-relative, so the bug being fixed here would not have affected its
  prior runs materially).

## 6. Effect on other consumers (task 4)

- **`h4-trend-h1-breakout-v1`**: reads `historical_candles.open_time`
  directly and applies its own (separately documented, unfixed,
  out-of-scope) UTC-vs-broker-clock confusion in
  `isWithinEntryWindow()`/its live coordinator. This fix changes *when*
  a bar becomes available in the database, not what value is stored in
  `open_time` — so it does not change that strategy's backtest results or
  its already-documented window-shift finding at all. Nothing to mark
  provisional there.
- **`xauusd-h4-confirmed-retest-v1`**: the frozen study operates on
  already-closed, already-synced historical data at the time each run was
  invoked — this fix affects sync *latency* going forward, not the
  correctness of any data a completed run already read. The zero-level
  conclusion is unaffected and not marked provisional. The watch-only
  watcher's own staleness reporting was already computing true UTC
  staleness correctly from whatever was stored (via the same
  `wallClockToUtc` correction) — so it was already correctly showing
  stale data as stale before this fix; what changes is that data now
  *becomes* fresh instead of staying ~3h behind.

## 7. Tests

- `collector/tests/test_mt5_client.py`: 2 new regression tests
  (`test_get_candles_converts_query_bounds_to_the_broker_mislabeled_epoch`,
  `test_get_candles_does_not_relabel_the_bar_time_itself`), plus the
  existing "still forming"/"maps every closed bar" tests updated to stay
  correct under the fixed "now" comparison. 18/18 in this file.
- Full collector suite: 189/189 (was 187/187 before this session's earlier
  gold-collection work; +2 here).
- No backend files were touched by this fix (confirmed by grep — no
  backend source references `copy_rates_range` or the collector sync
  lag); backend test suite not re-run for this specific fix as nothing in
  it changed.
