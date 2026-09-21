# Analytics specification — Phase 3
> See `../../../PROJECT_STATUS.md` at the repo root for the authoritative build order, phase-numbering crosswalk, and current status of every component.

Every number below is produced by plain PostgreSQL aggregation + TypeScript arithmetic — no
model, no heuristic, no "this looks unusual" judgment anywhere in this module. This module
answers "what is true right now, and what has historically been true" only. Whether a value is
*unusual* is Phase 4's job.

All formulas are implemented in `metrics/*.ts` (current/live facts) and `baselines/*.ts`
(historical, windowed facts). `analytics.service.ts` is the only entry point Phase 4 is expected
to call; nothing here is exposed over HTTP because nothing outside the backend process needs it
yet (Req. "Do not create a public analytics API unless it is actually needed").

## 0. Conventions used throughout

- **Account isolation.** Every query in this module is scoped by `accountId`. There is no
  function anywhere in `metrics/` or `baselines/` that queries a table without an `accountId`
  (or `account_id`) predicate. Tested explicitly in `test/analytics/isolation.spec.ts`.
- **`now`.** Every top-level function accepts an explicit `now: Date` (defaulting to
  `new Date()`) rather than calling `Date.now()` internally. This is what makes the module
  deterministic and testable: a test fixes `now`, everything downstream is reproducible.
- **Realized vs. floating P/L.** "Realized" always means: derived from the `trades` table
  (immutable deal records). "Floating" always means: derived from `positions.profit` for
  currently `OPEN` rows (live, mutates every sync). These are never summed into one number
  without both halves being named in the result (e.g. `currentEquity` is explicitly
  balance+floating, `totalRealizedPl` is explicitly deals-only). No function returns a value
  called simply "profit" that secretly mixes the two.
- **Gross vs. net.** For any individual deal, `grossProfit = deal.profit` (MT5's own P/L
  component, excludes commission/swap). `netProfit = deal.profit + deal.commission + deal.swap`
  (commission and swap are stored as signed values, as received from MT5 — a cost is negative).
  Win/loss classification, averages, and largest/smallest trade all use **net**, because that is
  what actually happened to the account balance. Gross is exposed alongside net wherever a total
  P/L figure is returned, specifically so a caller can never double-count commission by summing
  gross + commission separately without realizing net already includes it.
- **Deal-level "trades", not paired positions.** The schema stores deal granularity
  (`DealEntry.IN/OUT/INOUT/OUT_BY`), and a position is not guaranteed to be exactly one IN + one
  OUT (partial closes, netting reversals). Every metric that counts or aggregates "trades"
  operates on **closing deals** — rows with `dealEntry IN ('OUT', 'INOUT', 'OUT_BY')` — because
  those are the rows that carry realized P/L. An `IN` deal never contributes profit and is never
  counted as a win, a loss, or a "trade" for win-rate purposes. This means a position closed via
  three partial closes contributes three independent trade outcomes, which is correct: each
  partial close was a separate realized decision.
- **Numeric precision.** Prisma returns `Decimal(18,2)`/`Decimal(12,2)` columns as `Decimal`
  instances. All arithmetic converts to `number` via `.toNumber()` at the point of read, then
  uses ordinary floating-point math. Monetary and volume results are rounded to 2 decimal places
  (`Math.round(x * 100) / 100`) before being returned. This matches the schema's own precision
  (nothing in the schema stores more than 2 decimal places of money or volume) and avoids
  returning `0.1 + 0.2`-style float noise in API responses. Sums always come from PostgreSQL
  (`SUM(...)` in SQL, or Prisma's `aggregate`) rather than summing many rows in Node, both for
  performance and because Postgres numeric arithmetic on `numeric`/`decimal` columns is exact.
  Durations (minutes) and rates (trades/day, trades/hour) are likewise rounded to 2 decimal
  places — not because they carry schema-defined precision, but for the same reason: a stable,
  reproducible number in test assertions and API responses rather than raw float noise. Fractions
  compared against a `_pct`-style threshold (win rate, drawdown) are rounded to 4 decimal places
  instead, since 2 decimal places of a 0–1 fraction only carries whole-percent resolution.
- **Null vs. zero.** A metric is `null` when it is **undefined** (no denominator, no data to
  compute from — e.g. win rate with zero decided trades). A metric is `0` when the answer is
  **known and is zero** (e.g. total realized P/L with zero trades is legitimately `0`, not
  unknown). No metric ever returns `NaN`, `Infinity`, or throws on an empty dataset — this is
  enforced by construction: every division in this module checks its denominator first.

## 1. Trading-day boundaries (`trading-day.ts`)

A trading day is **not** a UTC calendar day. It is defined per-account by
`trading_day_timezone` (IANA name) and `trading_day_reset_hour` (0–23, local to that timezone).
Trading day *D* runs from `resetHour:00:00` local time on calendar date *D* to `resetHour:00:00`
local time on calendar date *D+1*.

- `getUtcOffsetMinutes(instant, tz)` — the IANA offset (in minutes, local − UTC) in effect for a
  given UTC instant, via `Intl.DateTimeFormat` (`formatToParts`), so no extra timezone package is
  needed.
- `tradingDayBoundaryContaining(instant, tz, resetHour)` — returns `{ start, end }` (both UTC
  `Date`s) for the trading day that contains `instant`. `end - start` is usually exactly 24h but
  is 23h or 25h on the local date that a DST transition falls on — the boundary is always
  computed by walking **local calendar dates**, then converting that local wall-clock instant
  back to UTC via a two-pass offset lookup (handles the DST edge correctly; see
  `test/analytics/trading-day.spec.ts` for the explicit spring-forward/fall-back cases).
- `previousTradingDayBoundary(boundary, tz, resetHour)` / `nextTradingDayBoundary(...)` — step one
  trading day earlier/later; used to walk backward for the baseline window and to detect distinct
  active trading days.

`trading_day_timezone` defaults to `'UTC'` and `trading_day_reset_hour` defaults to `0` at the
schema level (Phase 0 §04) — with those defaults, a trading day is simply the UTC calendar day,
so nothing about this module special-cases UTC; it is just the (correct) degenerate case of the
general timezone logic.

## 2. Current metrics (`metrics/*.ts`)

These reflect "right now" (or, for trading-activity/behavioral-sequence metrics, "all of history
to date" — see the per-metric note). They are **not** windowed to the 90-day baseline; the
baseline window only applies to §3.

### 2.1 Account / session (`account.metrics.ts`)

| Metric | Formula | Source | Missing-data handling |
|---|---|---|---|
| `startingBalance` | `balance` from the **anchor snapshot** for the current trading day (the `account_snapshots` row with the greatest `captured_at <= tradingDayStart`) | `account_snapshots` | `null` if no snapshot exists at or before the boundary |
| `currentBalance` | `balance` from the single latest snapshot for the account | `account_snapshots` | `null` if the account has no snapshots |
| `currentEquity` | `equity` from the single latest snapshot | `account_snapshots` | `null` if none |
| `dailyPl` | `anchorEquity(now) − anchorEquity(tradingDayStart)`, i.e. equity-based, so an open floating loss counts *before* it's realized (this is what a same-day loss-limit rule needs to see) | `account_snapshots` | `null` if either anchor is missing |
| `dailyProfit` | `max(dailyPl, 0)` | derived | `0` if `dailyPl <= 0` or unknown → `null` propagates from `dailyPl` |
| `dailyLoss` | `max(-dailyPl, 0)` (a non-negative magnitude) | derived | same propagation as above |
| `drawdown` | `(peakEquity − currentEquity) / peakEquity`, floored at 0, where `peakEquity` is the **all-time** high-water mark of every snapshot's equity for the account (not baseline-windowed — this is a live fact, "how far below my best-ever equity am I right now") | `account_snapshots` | `null` if no snapshots |
| `maxDrawdown` | the maximum, over the account's entire snapshot history, of `(runningPeakEquity(t) − equity(t)) / runningPeakEquity(t)`, computed with a SQL window function (`MAX(equity) OVER (ORDER BY captured_at ROWS UNBOUNDED PRECEDING)`) so this is one query, not N | `account_snapshots` | `null` if no snapshots |

`drawdown`/`maxDrawdown` are returned as a fraction (0–1), e.g. `0.038` for 3.8%, matching the
`DRAWDOWN` rule's `threshold_pct` convention in Phase 0 §08 (the rule engine will multiply/compare,
not this module).

### 2.2 Trading activity (`trading-activity.metrics.ts`)

All-time totals over every closing deal (`dealEntry IN ('OUT','INOUT','OUT_BY')`) for the account —
unwindowed, because the 90-day windowed equivalents live in §3.

| Metric | Formula | Zero-trade handling |
|---|---|---|
| `totalTrades` | `COUNT(*)` of closing deals | `0` |
| `winningTrades` | `COUNT(*)` where `netProfit > 0` | `0` |
| `losingTrades` | `COUNT(*)` where `netProfit < 0` | `0` |
| `winRate` | `winningTrades / (winningTrades + losingTrades)` | `null` if `winningTrades + losingTrades === 0` (never `NaN`) |
| `averageWinningTrade` | `AVG(netProfit)` over winning deals | `null` if none |
| `averageLosingTrade` | `AVG(netProfit)` over losing deals (negative) | `null` if none |
| `largestWinningTrade` | `MAX(netProfit)` over winning deals | `null` if none |
| `largestLosingTrade` | `MIN(netProfit)` over losing deals | `null` if none |
| `totalRealizedPlGross` | `SUM(grossProfit)` over closing deals | `0` |
| `totalRealizedPl` | `SUM(netProfit)` over closing deals | `0` |
| `totalCommission` | `SUM(commission)` over **all** deals (IN and OUT — some brokers charge commission on the opening leg) | `0` |
| `totalSwap` | `SUM(swap)` over **all** deals — this is *realized* swap only; open positions' live `positions.swap` is a separate, floating figure never added here | `0` |

Breakeven deals (`netProfit === 0`) count toward `totalTrades` but not toward `winningTrades`,
`losingTrades`, or the win-rate denominator — they are neither a win nor a loss.

### 2.3 Position behavior (`position.metrics.ts`)

| Metric | Formula | Source | Notes |
|---|---|---|---|
| `currentOpenPositions` | `COUNT(*)` where `status = 'OPEN'` | `positions` | live |
| `currentTotalVolume` | `SUM(volume)` where `status = 'OPEN'` | `positions` | `0` if none open |
| `maximumPositionVolume` | `MAX(volume)` where `status = 'OPEN'` | `positions` | the biggest position open **right now**; `null` if none open |
| `positionVolumeBySymbol` | `{ symbol, totalVolume, count }[]` grouped over `status = 'OPEN'` | `positions` | `[]` if none open |
| `numberOfSimultaneousPositions` | identical computation to `currentOpenPositions` | `positions` | kept as a separate named field because Phase 4 rules may reference either name for readability (e.g. a "too many concurrent positions" rule reads more naturally against this name); deliberately not a distinct formula |
| `averageHistoricalPositionVolume` | `AVG(volume)` over **all-time** `IN`-deals for the account | `trades` | see rationale below; `null` if no IN deals ever |

**Why IN-deal volume, not `positions.volume`, for the historical average:** `positions` is
upserted from `positions_get()` on every sync and always reflects the position's *current*
remaining size — after a partial close, `positions.volume` is smaller than what was actually
opened. Using it for a historical "how big does this trader normally open" average would silently
shrink the answer for every partially-closed position. The `trades` table's `IN` deals are
immutable, append-only, and each one records the exact volume of that opening execution, so they
are the correct source for a historical size average. (Live "what's open now" facts —
`currentTotalVolume`, `maximumPositionVolume`, `positionVolumeBySymbol` — correctly use
`positions`, since that table's whole job is to be the live state.)

### 2.4 Trading frequency (`frequency.metrics.ts`)

| Metric | Formula | Window | Zero-data handling |
|---|---|---|---|
| `tradesPerDay` | count of closing deals with `executedAt` inside `[tradingDayStart, tradingDayEnd)` for **today** | live, current trading day | `0` |
| `tradesPerHour` | count of closing deals with `executedAt` inside the trailing 60 minutes ending at `now` | live, rolling | `0` |
| `averageTimeBetweenTrades` | mean gap, in minutes, between consecutive closing deals' `executedAt`, ordered `(executedAt ASC, id ASC)` for determinism, all-time | all-time | `null` if fewer than 2 closing deals |
| `averageTradesPerSession` | `totalTrades / distinctActiveTradingDays`, where a "session" is one trading day (per account tz) containing ≥1 closing deal, all-time | all-time | `null` if `totalTrades === 0` |

### 2.5 Behavioral sequences (`sequence.metrics.ts`)

Computed by walking closing deals in `(executedAt ASC, id ASC)` order, all-time. A breakeven
deal (`netProfit === 0`) is neither a win nor a loss and **breaks** both streaks (it is not
skipped — a streak must be an unbroken run of same-outcome deals).

| Metric | Formula |
|---|---|
| `currentConsecutiveWins` | length of the run of wins ending at the most recent closing deal; `0` if the most recent deal is a loss/breakeven or there are no deals |
| `currentConsecutiveLosses` | same, for losses |
| `maxConsecutiveWins` | longest winning run anywhere in the account's history |
| `maxConsecutiveLosses` | longest losing run anywhere in the account's history |

All four are `0` (not `null`) when there are zero trades — an absence of any streak is a defined,
zero-length streak, not an undefined value.

### 2.6 Windowed trade counts — Phase 4 addition (`metrics/frequency.metrics.ts`)

| Metric | Formula | Zero-data handling |
|---|---|---|
| `tradesInTrailingWindow(accountId, windowMinutes, now)` | count of closing deals with `executedAt` inside `[now − windowMinutes, now]` | `0` |

Added for `TRADE_FREQUENCY_MULTIPLE` rules (see `rules/RULE_ENGINE_SPEC.md` §12.12 decision 2),
whose `window_minutes` parameter is per-rule and therefore can't be one of the fixed windows
`tradesPerHour`/`tradesPerDay` (§2.4) already cover. Not part of the `CurrentMetrics` shape —
called directly by `RuleEngineService` only for accounts with at least one enabled
`TRADE_FREQUENCY_MULTIPLE` rule, since it's the one current-side fact in this module that isn't
needed by every caller. The corresponding historical baseline needs **no new query**: the rule
engine derives "average trades per `window_minutes`" from the existing `averageTradesPerHour`
baseline (§3) as `averageTradesPerHour × (window_minutes / 60)` — a plain rate scaling, not a
separate windowed aggregate — so `averageTradesPerHour === null` (brand-new account) correctly
propagates to "no baseline for this window" without a second query.

## 3. Historical baselines (`baselines/*.ts`)

Config: `ANALYTICS_BASELINE_WINDOW_DAYS` (default `90`), read once via `ConfigService` in
`AnalyticsService` and passed as an explicit `windowDays` parameter into every baseline function —
no baseline function reads the env var itself or hard-codes `90`, so a caller (including a test)
can always override it per-call.

**Window definition — deliberately excludes "today":**

```
todayStart      = tradingDayBoundaryContaining(now, tz, resetHour).start
baselineEnd     = todayStart                      // exclusive — today is never in the baseline
baselineStart   = todayStart − windowDays trading days (walked via previousTradingDayBoundary)
```

The in-progress trading day is excluded from its own baseline on purpose: comparing "today" against
a baseline that already includes part of today would be comparing today against itself. This also
means the baseline window is always made of **complete** trading days.

An account with **no data at all** (no snapshot, no trade, ever) is a special case of the clipping
above: `windowStart` collapses to `windowEnd` (an empty window, `windowCompleteDays = 0`) rather
than falling back to the full uncapped `windowDays`-day span. Falling back would silently assert
"zero trades/day for the last 90 days," which is a claim about history that doesn't exist for an
account that was, say, created five minutes ago — the correct answer is "no baseline yet"
(every field `null`), not "a 90-day baseline of zero activity."

| Baseline | Formula | Source | Empty-window handling |
|---|---|---|---|
| `averageDailyPl` | mean, over every complete trading day in the window that has a snapshot anchor at both its start and end, of `anchorEquity(dayEnd) − anchorEquity(dayStart)` | `account_snapshots`, day-bucketed via a single `LATERAL`-join query against the boundary list (§3 implementation note) | `null` if no day in the window has both anchors |
| `averageDailyLoss` | mean of `-dailyPl(day)` over days where `dailyPl(day) < 0` | derived from the above | `null` if no losing day in the window |
| `averageTradesPerDay` | `totalClosingDealsInWindow / windowCompleteDays` (calendar trading days elapsed, including zero-trade days) | `trades` | `null` if `windowCompleteDays === 0` (brand-new account) |
| `averagePositionVolume` | `AVG(volume)` over `IN`-deals with `executedAt` in the window | `trades` | `null` if none |
| `maximumNormalPositionVolume` | `MAX(volume)` over `IN`-deals in the window | `trades` | `null` if none |
| `averageTradeDuration` | mean, in minutes, of `MAX(executedAt) − MIN(executedAt)` per `positionId`, over positions that are `CLOSED` and whose last deal falls in the window | `trades` + `positions.status` | `null` if none |
| `averageLosingTrade` | `AVG(netProfit)` over losing closing deals in the window | `trades` | `null` if none |
| `averageWinningTrade` | `AVG(netProfit)` over winning closing deals in the window | `trades` | `null` if none |
| `averageTradesPerHour` | `totalClosingDealsInWindow / (windowCompleteDays * 24)` | `trades` | `null` if `windowCompleteDays === 0` |

**Implementation note — day-bucketed equity without loading full snapshot history into Node:**
`averageDailyPl`/`averageDailyLoss` need "equity at the start/end of every day in the window,"
which naively means either N×2 round trips or pulling every snapshot row into memory (potentially
hundreds of thousands of rows over 90 days at a 30s interval — exactly what Req. 8's performance
section says to avoid). Instead, the day boundaries for the window are computed once in Node
(cheap — ~91 timezone calculations, no I/O), then a single query resolves all of them at once:

```sql
SELECT b.boundary, s.equity, s.captured_at
FROM unnest($1::timestamptz[]) AS b(boundary)
LEFT JOIN LATERAL (
  SELECT equity, captured_at FROM account_snapshots
  WHERE account_id = $2 AND captured_at <= b.boundary
  ORDER BY captured_at DESC LIMIT 1
) s ON true
ORDER BY b.boundary;
```

This is `O(log n)` per boundary via the existing `(account_id, captured_at DESC)` index — one
round trip regardless of how much snapshot history exists. **This query is the one most likely to
need revisiting if the boundary list ever grows very large** (it currently scales with
`windowDays`, capped in practice at whatever `ANALYTICS_BASELINE_WINDOW_DAYS` is configured to).

**Implementation note — streak and duration queries load raw rows.** `sequence.metrics.ts` and
`averageTradeDuration` inherently need row-level, ordered data (a streak or a duration is a
sequential/grouping computation that doesn't reduce to a single SQL aggregate). These load
`{ executedAt, dealEntry, netProfit components, positionId }` for the account's closing deals in
the relevant range — bounded by trade *count*, not snapshot count, so it is far smaller than the
snapshot tables even for an active trader. Documented here as the one place this module reads more
than an aggregate: if an account's deal history ever grows large enough for this to matter, the
fix is a SQL window-function streak calculation, not a design this phase needs yet.

## 4. What Phase 3 explicitly does not do

Per the phase brief, this module never: decides whether a value is unusual, triggers an alert,
calls Telegram or an AI provider, or writes to any table. Every exported function in
`analytics/` is a read plus arithmetic. `AnalyticsService` has no dependency on `rules`, `alerts`,
`ai`, or `telegram` — Phase 4 will depend on `analytics`, never the reverse (matching the module
dependency table in Phase 0 §15).
