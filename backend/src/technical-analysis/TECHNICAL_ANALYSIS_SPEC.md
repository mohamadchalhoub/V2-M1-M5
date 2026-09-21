# Technical analysis specification — user's custom EURUSD trading rules

The user provided four plain-language trading rules (support/resistance proximity, Ichimoku
breakout, daily Fibonacci analysis, daily market direction) with an explicit architectural
requirement: keep "Market Data," "Technical Analysis," "Rule Engine," "AI Layer," and "Telegram"
as separate layers, and never put trading calculations inside a controller, a Telegram template,
an AI prompt, or a frontend component. This document records the deterministic design each
calculation uses and why, so the reasoning is legible without re-deriving it from the code.

## 0. Layering

```
HistoricalCandleService (Market Data — facts only, real MT5-sourced candles)
        ↓
TechnicalAnalysisReportService (this module — fetches candles, calls the pure
  calculation functions below; the ONLY place that does either)
        ↓
RuleEngineService.buildExtras() (Rule Engine — converts already-computed results
  into each evaluator's structural extras; never fetches a candle or runs a
  calculation itself)
        ↓
evaluator functions (rules/evaluators/*.ts — pure, decide TRIGGERED/NOT_TRIGGERED
  only, same purity convention every other evaluator already has)
        ↓
Alert.triggerValues (frozen, generic JSON) → AI prompt (verbatim) → Telegram (rendered)
```

`TechnicalAnalysisController` (the dashboard's read API) calls the exact same
`TechnicalAnalysisReportService` the rule engine calls — "what triggered the alert" and "what the
dashboard shows right now" can never silently diverge, because there is only one code path that
computes either.

All four calculation functions (`support-resistance.service.ts`, `ichimoku.service.ts`,
`fibonacci.service.ts`, `market-direction.service.ts`) are plain exported functions, not NestJS
providers — they take already-fetched `CandleData[]` and do no I/O, matching the rule engine's own
evaluator-purity convention (`RULE_ENGINE_SPEC.md` §3). Only `TechnicalAnalysisReportService` is
injectable, since it alone needs `HistoricalCandleService`/config.

## 1. Support/resistance (Rule 1)

- **Method**: fractal pivot detection — a candle whose high (or low) is the most extreme among
  itself and `FRACTAL_WIDTH` (2) candles on each side. The standard, simplest deterministic pivot
  method; not a library, per the user's own "hand-write it" expectation.
- **Merge**: two pivots within `LEVEL_MERGE_TOLERANCE_POINTS` (10, a fixed implementation
  constant) of each other collapse into one level, keeping a running touch count — prevents
  reporting near-duplicate "levels" that are really the same price zone.
- **Timeframes**: H1, H4, D1 — fixed by the user's own Rule 1 text, not configurable.
- **Proximity threshold**: `SUPPORT_RESISTANCE_PROXIMITY_POINTS` (env, default 50) — the alerting
  threshold, kept entirely separate from the merge tolerance above (they solve different
  problems: one is "is this alert-worthy," the other is "is this really one level or two").
- **Point definition**: `point-value.ts` — this deployment's EURUSD is quoted at 5 digits
  (verified against real stored candle closes), so 1 point = 0.00001 (MT5's own convention), and
  1 traditional pip = 10 points. Documented explicitly rather than silently assumed; no
  symbol-metadata fetch exists in this system (the collector never calls MT5's `symbol_info()`),
  so this is a named constant, not a new subsystem.
- **Alert dedup**: a continuous condition ("is price near a level right now"), not a discrete
  event — ordinary cooldown re-notify (the same behavior DRAWDOWN/MARGIN_UTILIZATION already
  have) is correct here; no extra freshness logic needed.
- **Trend indicator (Stage 3A addition)**: each match also reports `trend` —
  `APPROACHING`/`RETREATING`/`FLAT`/`UNKNOWN` — whether price has moved toward or away from that
  level since a `priorPrice` reference point. `priorPrice` reuses the same 30-minute M5 window
  `getCurrentPrice` already fetches (its earliest close), rather than adding a second lookback
  config knob; `UNKNOWN` when that window has fewer than two candles. Movement smaller than
  `TREND_FLAT_TOLERANCE_POINTS` (1 point, a fixed implementation constant) counts as `FLAT`, not
  noise misread as a direction. This is informational only — surfaced in `triggerValues` for the
  Telegram message and the AI context — it does not change the TRIGGERED/NOT_TRIGGERED decision,
  which stays purely proximity-based.

## 2. Ichimoku breakout (Rule 2)

- **Periods**: Tenkan 9 / Kijun 26 / Senkou B 52 / displacement 26 — the universal standard
  convention, treated as implementation constants (not env config), per the user's own "don't add
  unnecessary configuration for true constants" instruction.
- **Cloud state**: `ABOVE_CLOUD` / `BELOW_CLOUD` / `INSIDE_CLOUD`, computed from the Senkou
  spans calculated `displacement` periods earlier (the cloud is a leading indicator — getting this
  offset right is what makes it one).
- **Breakout definition**: the latest **closed** candle's close is definitively on the opposite
  side of the cloud from the prior closed candle's close. Candle-close confirmation only — no
  intra-candle/live-price trigger (user's explicit preference). A transition that lands
  `INSIDE_CLOUD` (from either side) is "entering the cloud," never itself a breakout — only a
  transition that lands definitively `ABOVE` or `BELOW` counts.
- **Timeframes**: `ICHIMOKU_TIMEFRAMES` (env, default `M30,H1,H4,D1`; this deployment's `.env` also
  enables `W1,MN1`) — configurable, per the user's own instruction. `W1`/`MN1` need the collector's
  own `CANDLE_TIMEFRAMES` to include them too (real MT5-native weekly/monthly bars, never
  resampled) — see §3 below.
- **Freshness window and cooldown, together** (`ichimoku-breakout.evaluator.ts`): unlike Rule 1,
  this is a genuinely discrete event, and `detectIchimokuBreakout` is a stateless "did the last two
  closed candles cross" comparison — without a freshness check, the same already-alerted breakout
  would re-trigger every time cooldown expires, because the comparison keeps reporting the same
  historical breakout for as long as that candle remains "the latest." The evaluator only counts a
  breakout if it happened within `BREAKOUT_FRESHNESS_MS` (15 minutes) of evaluation time. The
  rule's own `cooldownSeconds` must be set **longer** than this window, so a stale breakout goes
  `NOT_TRIGGERED` (and `RuleState` back to `INACTIVE`) before cooldown could ever expire and
  re-notify on it — recommend 1200s+ when creating this rule.

## 3. Candle lookback windows

`TechnicalAnalysisReportService`'s `TIMEFRAME_LOOKBACK_DAYS` map bounds how far back each
timeframe's candles are fetched on every call — chosen so there is comfortably more than
Ichimoku's own 78-candle minimum (26 displacement + 52 Senkou B period) on every timeframe, never
"all of history":

| Timeframe | Lookback | Approx. candle count |
|---|---|---|
| M5 | 2 days | ~576 |
| M15 | 5 days | ~480 |
| M30 | 10 days | ~480 |
| H1 | 30 days | ~720 |
| H4 | 90 days | ~540 |
| D1 | 500 days | ~500 |
| W1 | 1095 days (3yr) | ~156 |
| MN1 | 3650 days (10yr) | ~120 |

M30/H4/D1 were added to the collector/backend in an earlier pass (previously only M5/M15/H1
existed, enough for the historical-chart-reconstruction feature but not for Ichimoku/support-
resistance, which need longer native timeframes); W1/MN1 were added later, for Ichimoku breakout
alerts specifically (not support/resistance — `SUPPORT_RESISTANCE_TIMEFRAMES` stays `H1,H4,D1`).
Real MT5 data, not resampled from finer candles — the collector's own architecture already fetches
native timeframes directly (`_MT5_TIMEFRAME_BY_NAME`), so widening that small allowlist was the
smaller change than building a new resampling layer. W1/MN1's own first-ever backfill also uses a
longer floor than the collector's shared `CANDLE_INITIAL_SYNC_DAYS` (see
`runner.py`'s `_MIN_INITIAL_SYNC_DAYS_BY_TIMEFRAME`, 1825d/5475d) — each Ichimoku candle "costs"
much more wall-clock time on these timeframes, so the global setting (sized for the shorter
timeframes) would leave W1/MN1 without the 78-candle minimum Ichimoku needs.

## 4. Fibonacci (Rule 3)

- **Swing selection**: the highest high and lowest low within a bounded D1 lookback window
  (`FIBONACCI_LOOKBACK` days, env, default 90) — the standard, simplest deterministic swing method.
  Never a random or manually-chosen high/low (user's explicit requirement).
- **Direction**: whichever extreme is chronologically more recent decides it. If the high is more
  recent, price most recently moved up into it, so the swing is `BULLISH` and retracement is
  measured **down** from the high. If the low is more recent, `BEARISH`, measured **up** from the
  low.
- **Levels**: `FIBONACCI_RATIOS` (0, 23.6%, 38.2%, 50%, 61.8%, 78.6%, 100%) — one centralized
  constant array, not scattered magic numbers.
- **Insufficient data**: a flat/degenerate window (`high - low <= 0`) returns `null` rather than a
  meaningless retracement — the evaluator/report treat this as "not enough data," never a
  fabricated swing.

## 5. Daily market direction (Rule 4)

A deliberately small, named 3-signal majority vote — the user's own explicit "do not silently
create a complex new strategy" instruction. Nothing more elaborate is added.

1. **H4 Ichimoku trend** — `ABOVE_CLOUD`/`BELOW_CLOUD`/`INSIDE_CLOUD` (`INSIDE`/insufficient data
   votes `NEUTRAL`).
2. **H4 market structure** — classic higher-highs/higher-lows (bullish) vs. lower-highs/lower-lows
   (bearish), from the same fractal pivots §1 already computes (fewer than 2 pivots of either type
   votes `NEUTRAL`).
3. **D1 SMA trend** — a 10-day vs. 30-day simple moving average cross (implementation constants,
   not configurable — a plain trend cross, not a tuned strategy parameter).

`dailyBias` is whichever side has more votes (a tie, including 0-0, is `NEUTRAL`).
`confidence` is the winning side's vote count divided by 3 (deterministic agreement, never an AI
guess) — 3/3 agreement is the strongest signal this produces, 2/3 is moderate, and a NEUTRAL
result (no majority) is reported honestly as such, not forced into a direction.

## 6. Rule types added

Three new leaf `RuleType` values (migration `20260907120632_add_technical_analysis_rule_types`),
all parameterless (same precedent as `NO_STOP_LOSS`) — their thresholds/timeframes/lookback
windows are system-wide config (§8), not per-rule parameters, since there is only ever one EURUSD
market to analyze:

- `SUPPORT_RESISTANCE_PROXIMITY` — real-time, evaluated on the normal snapshot-driven trigger.
- `ICHIMOKU_BREAKOUT` — real-time, evaluated on the normal snapshot-driven trigger.
- `DAILY_MARKET_ANALYSIS` — Rules 3+4 combined into the daily morning report. Evaluated **only**
  via `DailyMarketAnalysisProcessor`'s own cron schedule (`DAILY_ANALYSIS_TIME`/
  `DAILY_ANALYSIS_TIMEZONE`), never the snapshot trigger. `RuleEngineService.evaluateAccount` gained
  one additive `ruleTypeFilter` option to support this: omitted (the snapshot path's normal call)
  excludes `DAILY_MARKET_ANALYSIS` by default; the processor calls it with
  `{ ruleTypeFilter: ['DAILY_MARKET_ANALYSIS'] }` to evaluate only that type. Everything downstream
  (Alert persistence, cooldown, AI analysis, Telegram delivery) is the existing machinery,
  completely unchanged.

**No trade-blocking capability exists or was added** — same as every other rule type in this
system (`RULE_ENGINE_SPEC.md`'s own addendum), these three can only ever alert, never intercept an
order. A rule phrased "do not enter BUY when X" becomes "alert the moment X is true."

**Telegram chat IDs are global** (`TELEGRAM_TRADING_CHAT_IDS`), not per-account — enabling any of
these three rule types on more than one account sends duplicate reports to the same chat. Enable
on exactly one account.

## 7. Config reference

| Variable | Default | Meaning |
|---|---|---|
| `SUPPORT_RESISTANCE_PROXIMITY_POINTS` | `50` | Rule 1's alert threshold, in EURUSD points (§1). |
| `ICHIMOKU_TIMEFRAMES` | `M30,H1,H4,D1` | Rule 2's watched timeframes, comma-separated. Valid: `M5,M15,H1,M30,H4,D1,W1,MN1` (this deployment's `.env` uses `M30,H1,H4,D1,W1,MN1`). |
| `DAILY_ANALYSIS_TIME` | `08:00` | 24-hour `HH:MM`, in `DAILY_ANALYSIS_TIMEZONE`. |
| `DAILY_ANALYSIS_TIMEZONE` | `Asia/Beirut` | IANA zone — the trader's own, not the server's. |
| `FIBONACCI_LOOKBACK` | `90` | Days of D1 history Rule 3's swing search considers. |
| `MARKET_DIRECTION_LOOKBACK` | `90` | Days of D1 history Rule 4's SMA signal considers. |

Ichimoku's own periods, the support/resistance fractal width/merge tolerance, and the market
direction SMA periods are **not** configurable — true implementation constants, per the user's
own instruction not to add configuration for values a trader wouldn't reasonably tune.
