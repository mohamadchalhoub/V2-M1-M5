# h4-trend-h1-breakout-v1 entry-window shift — current status (2026-09-15, second follow-up)

Answering directly: **still affected in the backtest path, not fixed by the collection
query-bound fix, and not previously misdiagnosed.** The collection fix (`3beb63c`) changed only
how quickly bars reach the database — never what timezone they're labeled with — so it could
not have touched this.

## Where it lives

- `backend/src/trend-breakout/schedule.ts:75` — `isWithinEntryWindow(utcNow: Date)` — correct
  code: converts its argument to `Asia/Beirut` via `Intl`/IANA tzdata and checks the 03:00–12:00
  window. It has no bug in itself; the defect is entirely in what gets passed to it.
- `backend/src/market-data/historical-candle.service.ts`'s `getCandlesInRange()` /
  `toCandleData()` returns `openTime` straight from the `historical_candles.open_time` column —
  no timezone correction of any kind (confirmed by grep: neither this file nor anything in
  `src/trend-breakout/` references `wallClockToUtc`, `EET`, or any broker-clock correction; the
  confirmed-retest research module's `data-source.ts` has that correction, this strategy does
  not).
- `backend/src/trend-breakout/backtest.ts:133` and `:375` —
  `isWithinEntryWindow(candle.openTime)` — feeds that uncorrected, broker-mislabeled `openTime`
  straight in. **This is the bug.** `candle.openTime` is still stored the same way after the
  2026-09-15 collection fix (deliberately — see `FIX_REPORT.md` §2: correcting the stored value
  would have double-converted it against millions of existing rows).

## Live proof, from the actual code (not hand computation)

`entry_window_shift_evidence.ts` (output in `entry_window_shift_evidence.out.txt`) imports the
real `isWithinEntryWindow`/`getBeirutWallClock` from `schedule.ts` and feeds it a concrete stored
(raw, mislabeled) H1 candle open time — using this session's own live-measured broker offset
(+3h, EEST — `mt5-live-time-evidence.json`, `candle-sync-fix/proof.json`), not an assumed one:

```
candle.openTime (stored, raw, mislabeled): 2026-07-15T02:30:00.000Z
  isWithinEntryWindow(candle.openTime) -> USED BY THE BACKTEST: true

true UTC instant this bar really opened at: 2026-07-14T23:30:00.000Z
  isWithinEntryWindow(true UTC) -> CORRECT: false
```

The backtest would treat this bar as inside the entry window (Beirut 05:30) when the bar
genuinely opened at Beirut 02:30 — before the window even starts. This is a live boundary-
crossing case from the real function, not a synthetic worst case.

## Reachability: backtest vs. live

- **`backtest.ts`** (historical simulation): reachable and actively used — every
  `confirmed-retest`-style or breakout backtest run exercises this bug. Any historical
  session-dependent breakout result is affected.
- **`trend-breakout-coordinator.service.ts`** (the live/operational gate, same underlying
  issue — it also mixes `candle.openTime` against a true-UTC `now` for its still-forming-bar
  filter and 60s expiry check): confirmed via `grep -rn "evaluateAll("` across `src/`, `scripts/`,
  and `test/` that **nothing calls it** — no scheduler, no controller route, no script. This
  matches `TREND_BREAKOUT_SPEC.md`'s own documented item 5 ("No scheduler calls
  `evaluateAll()`... by design"). So the live gate carries the same latent defect but is
  currently unreachable/dormant, not actively producing wrong live decisions. (`isWithinEntryWindow(new Date())` used by the dashboard's own "is the window open right now" status field is unaffected — it's given the real system clock directly, never a stored candle time.)

## What is NOT claimed here

- No winter-offset inference — the +3h used above is this session's own live EEST measurement,
  not extrapolated to winter.
- No strategy parameter, signal rule, or entry-window boundary was changed.
- No broad test suite was rerun for this; `entry_window_shift_evidence.ts` is a standalone,
  read-only script against the real exported functions, not a new permanent test file.
- Nothing here touches or changes the confirmed-retest (`xauusd-h4-confirmed-retest-v1`)
  zero-level finding — that strategy has its own, separate, already-correct EET conversion layer
  (`data-source.ts`'s `wallClockToUtc`) and is not affected by this issue at all.

## Labeling

Any existing or future `h4-trend-h1-breakout-v1` backtest result that reports session/time-of-day-
dependent statistics (entries by Beirut hour, entry-window edge cases, anything keyed off
`isWithinEntryWindow`) should be treated as **provisional** pending a real fix (e.g. converting
`candle.openTime` the same way `data-source.ts` does before it reaches `isWithinEntryWindow`, or
storing true-UTC times at ingestion — either is a code change out of scope for this task). No
existing backtest run's output file has been altered or re-labeled by this task; this is a status
note pointing at the affected code path, not an edit to prior results.
