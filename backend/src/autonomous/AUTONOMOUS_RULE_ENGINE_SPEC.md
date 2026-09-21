# Autonomous rule engine specification — the friend's EURUSD weekly H4 rule (Phases 2-4)

Phase 2/3 (`weekly-range-levels.service.ts`, `level-confirmation.ts`, `autonomous-rule-engine.service.ts`,
`backtest-simulator.ts`): a deterministic, AI-free evaluation of the friend's trading rule, and the
backtest that validates it. Phase 4 (`autonomous-ai-decision.service.ts`,
`autonomous-ai-provider-gemini.ts`, `validate-autonomous-ai-decision.ts`) adds a confirm/veto AI
layer strictly ON TOP of the mechanical engine's own candidates — the AI never originates a trade
idea (§4 below). No execution module and no kill switch exist yet — this code can compute what the
rule (and, on top of it, the AI) says, and log it (plan §10), and nothing more. It cannot place an
order; there is no code path in this repo yet that calls MT5's `order_send`.

**Revision note**: the original version of this spec was written against four open questions with
placeholder answers. The friend has since answered them directly (see §2) — the rule engine below
is a rewrite around his actual answers, not the original placeholder model. Two further details his
answers didn't fully specify are still this project's own reconciliations (§2.4/§2.5), clearly
marked as such.

## 0. The friend's rules, verbatim (ground truth — never paraphrase this away)

**Strategy Name: EURUSD Weekly Swing Trading on H4 Support/Resistance**

1. Symbol: EURUSD only. No other symbols. Ever.
2. Reference Timeframe: H4.
3. Level Identification: On the H4 chart, find the highest resistance and lowest support formed
   during the previous completed week.
4. Entry Logic: Place orders at or near these levels when price approaches them.
5. Trade Frequency: Maximum one order per day. Do not feel obligated to hit this limit — only
   trade when the setup is valid.
6. Order Parameters (Symmetric 1:1 Risk-Reward): Take Profit 180 points, Stop Loss 180 points.
7. Level Break Handling: If price breaks through the identified support or resistance, new
   support/resistance levels are formed.
8. Recalculation Rule: When new S/R levels form, the system must recalculate by looking back to
   the week when those new levels first appeared, and trade based on that week's levels for the
   following period.

**The friend's direct answers to the open questions** (verbatim, lightly formatted):
1. "180 points or pips — example if the price was 1.15800, TP at 1.15620." (1.15800 − 1.15620 =
   0.00180 = 180 points, confirming the "points" reading.)
2. "Focus on resistance and support using H4. When touch resistance or support, take order after
   50 points, and bet on a bounce."
3. "Don't take any order if the market moves hard — that means up or down in 1 or 2 hours more
   than 500 points."
4. "Don't count on every support and resistance — when support or resistance on H4 and D1 are too
   close, take order."
5. "When price breaks levels: don't take any order, just wait the next opportunity."

## 1. Layering

Same separation `TECHNICAL_ANALYSIS_SPEC.md` already establishes in this codebase:

```
HistoricalCandleService (Market Data — facts only)
        ↓
AutonomousRuleEngineService (this module — fetches H4/D1/M15 candles + live tick,
  calls the pure functions below; the only place that does either)
        ↓
weekly-range-levels.service.ts   — pure: Rule 4's weekly high/low (H4 for the trade
                                    level, D1 for the confluence check — same function,
                                    different candles)
level-confirmation.ts            — pure: touch/retrace/break state machine (Rules 4-5
                                    as the friend actually described them), the
                                    volatility filter (his answer 3), and the H4/D1
                                    confluence check (his answer 4)
autonomous-rule-engine.service.ts's evaluateAutonomousRule() — pure: combines the above
  into one decision (Rules 3-6)
        ↓
AutonomousDecisionLoggerService (writes one AutonomousDecision row per evaluation, HOLD included)
```

Every function above takes already-fetched data and does no I/O — same purity convention
`support-resistance.service.ts` uses, so all of it is directly unit-testable and directly reusable,
unchanged, by the backtest script (`backend/scripts/backtest-autonomous-rule.ts`) — one rule
engine, never two implementations that could quietly drift apart.

## 2. From placeholders to the friend's actual answers

### 2.1 — "180 points" (Rule 6) — CONFIRMED

The friend's own worked example (1.15800 → 1.15620) is exactly 180 × `EURUSD_POINT_SIZE`
(`0.00180`, 18 traditional pips), matching what was already implemented as a placeholder. Config:
`AUTONOMOUS_TAKE_PROFIT_POINTS` / `AUTONOMOUS_STOP_LOSS_POINTS`, default `180` each — no longer a
guess.

(For the record, the pre-confirmation empirical check pointed the same way: of the friend's **865
imported closed positions**, 648 are EURUSD — the rest are GOLD/OIL/EURCHF/GBPUSD/NATGAS — and only
249 of those have both SL and TP recorded, averaging 122.53pt/243.78pt (median 106/162), nowhere
near "180 pips" scale.

**Correction (independent-review reconciliation, confirmed against the live database)**: this
document previously said "1,730 imported trades, only 1,296 are EURUSD." Those two numbers are
exactly double the real position counts (865 and 648) — CONFIRMED root cause: they were a raw
`count(*) FROM trades` query, and the XTB importer (by design — `XTB_IMPORT_SPEC.md` §2 step 5)
writes TWO `Trade` rows per closed position (an IN leg and an OUT leg, mirroring how MT5's own deal
history works), so counting `trades` rows counts deal-LEGS, not positions. Verified directly: every
one of the 865 positions has exactly 2 legs (865 IN + 865 OUT = 1,730; 648 IN + 648 OUT = 1,296),
and every other figure previously reported here — gross P/L, swap, win/loss counts, SL/TP
averages — was already computed correctly off the `OUT` leg per position, so this was a
mislabeling of the record count, not a data or math defect elsewhere. See
`AUTONOMOUS_DEMO_TRADING_PLAN.md`'s data-reconciliation audit for the full reconciliation against
the source workbook, including net-position P/L, win rate, and cash-balance checks.)

### 2.2 — Entry mechanism (Rule 4) — CONFIRMED, and it replaced the original model entirely

The friend's answer ("when touch resistance or support, take order after 50 points, and bet on a
bounce") is not a simple "enter when price is within X points of the level" check — the original
placeholder model. It's a **touch-then-confirm-retrace** pattern: price must actually reach the
level, then retrace 50 points back from it (in the bounce direction) before entering. This also
confirms the fade/bounce direction (buy at support, sell at resistance), which had been the
original placeholder default.

Implemented as a state machine, `evaluateLevelState` (`level-confirmation.ts`):
`NOT_TOUCHED → TOUCHED_WAITING → READY` (or `→ BROKEN`, see §2.5). Config:
`AUTONOMOUS_ENTRY_RETRACE_POINTS`, default `50` — the friend's own number, not a guess.

### 2.3 — Volatility filter (new rule, not in the original 8) — CONFIRMED

"Don't take any order if the market moves hard — up or down in 1 or 2 hours more than 500 points."
A blanket gate, checked before any level logic: if price has moved >= 500 points within the
filter window, no entry regardless of which level would otherwise be valid. Implemented as
`isVolatilitySpike` (`level-confirmation.ts`), comparing the newest close against the oldest
close inside the window (a net directional move, not the bar-to-bar range). Config:
`AUTONOMOUS_VOLATILITY_FILTER_MAX_POINTS` (default `500`, the friend's number) and
`AUTONOMOUS_VOLATILITY_FILTER_WINDOW_HOURS` (default `2` — the friend said "1 or 2 hours"; 2 was
picked, still a placeholder on the exact hour and NOT unambiguously "more conservative": a longer
window can average away a sharp move a shorter window would have caught (e.g. a genuine 450-point
spike in 20 minutes stays under the 500pt/2h gate but would trip a 500pt/1h — or shorter — one),
so "2h" is a different sensitivity, not a strictly safer one. Reconciliation audit correction: an
earlier version of this note called 2h "the more conservative reading," which doesn't hold in
general.

### 2.4 — Multi-timeframe confluence (new rule, not in the original 8) — mostly CONFIRMED, one PLACEHOLDER remains

"Don't count on every support and resistance — when support or resistance on H4 and D1 are too
close, take order." Read as: only trade an H4 level that's corroborated by a nearby D1-timeframe
level (confluence) — the friend is explicit that not every H4 weekly level is tradeable, only ones
with this cross-timeframe agreement. Implemented as `hasConfluence` (`level-confirmation.ts`),
reusing `calculateWeeklyRangeLevels` on D1 candles for the same reference week window as the H4
levels, then checking the two are within tolerance. **PLACEHOLDER**: the friend didn't give a
number for "too close" — `AUTONOMOUS_CONFLUENCE_TOLERANCE_POINTS` defaults to `50`, this project's
own placeholder (picked to match the retrace number for a round, defensible default), not
something he stated. Needs his confirmation. `d1Levels === null` (insufficient D1 history) is
treated as "not confirmed" — fail closed, never assumed confirmed by default.

**CONFIRMED DEFECT (independent-review audit, proven against real candle data, not an
interpretation question)**: as implemented, this filter is a near-total no-op, which is exactly
why the earlier backtest's sensitivity sweep found identical results at a 30pt, 50pt, and 100pt
tolerance. Root cause: `hasConfluence`'s "D1 level" is computed by calling
`calculateWeeklyRangeLevels` on D1 candles over the SAME 1-week window used for the H4 level. But
a week's highest H4 high and a week's highest D1 high are the SAME underlying price series at
different bar granularity — max(H4 highs for the week) is mathematically the week's true high
regardless of which timeframe measured it, so the two must be equal (net of data gaps). Verified
directly against this database's real EURUSD H4/D1 candles across 15+ sampled weeks in 2026: the
H4-computed and D1-computed weekly high/low were **identical to 0.00 points in every single week
checked**. This means the filter isn't comparing an independently-derived daily-chart level
against the weekly H4 level (which is what "when support or resistance on H4 and D1 are too close"
most plausibly describes) — it's comparing a number to itself, so it passes at virtually any
tolerance. **This was not fixed** (guessing a replacement D1 window/definition would be a NEW
unconfirmed assumption, exactly what this project avoids) — it's flagged here as the single most
important open strategy question for the friend, with concrete price examples, in the
reconciliation audit's consolidated question list.

### 2.5 — Break handling (Rule 5, replacing the original Rules 7-8 reading) — mostly CONFIRMED, one PLACEHOLDER remains

"When price breaks levels: don't take any order, just wait the next opportunity." This is simpler
than the original rules' text suggested and needed no mid-week recalculation logic at all: once a
level is broken, stop trading it until the reference week rolls over naturally. **The remaining
question this raises**: the friend's Rule 4 already describes entering AFTER a "touch" (his answer
2), so a touch by itself can't also mean "broken," or the entry mechanism could never fire.
**PLACEHOLDER, this project's own reconciliation**: a level counts as BROKEN once price overshoots
it by >= `AUTONOMOUS_LEVEL_BREAK_OVERSHOOT_POINTS` (default `50`, the SAME number as the retrace
threshold, for a clean symmetric race — whichever happens first, a 50pt retrace back or a 50pt
push further through, decides READY vs. BROKEN) without having retraced first. This produces
coherent, testable behavior, but the friend never actually stated an overshoot number for "broken"
specifically — needs his confirmation, ideally with 2-3 real worked examples of a level breaking.

### 2.6 — Week boundary clock — still a PLACEHOLDER, unchanged

Computed on the UTC calendar week (candle `openTime` values are stored as-is from the
collector/MT5). Still very likely NOT the same thing as the friend's own notion of "the week" —
unresolved, not asked about directly yet.

## 3. Real backtest results (Phase 3, rerun against the friend's confirmed rules)

Run via `npm run backtest-autonomous-rule` against this database's full EURUSD H4/D1/M15 history
(2023-12 to present, ~2.75 years). **This supersedes the earlier placeholder-model backtest, which
is no longer representative of the friend's actual rules.**

At the default config (180pt SL/TP, 50pt retrace, 50pt confluence tolerance, 500pt/2h volatility
filter): **61 trades, 31–34% win rate, profit factor 0.45–0.53, total P&L -3,420 to -4,140 points
(losing) depending on the assumed spread.** A parameter sensitivity sweep across retrace (30/50/75)
× confluence tolerance (30/50/100) × spread (0/10/15/20) is **negative in every single cell** —
this is not a marginal or fragile result like the earlier placeholder model produced; it's a
consistent, meaningful loss across the whole grid.

**Recommendation, per the plan's own go/no-go gate (§7.8)**: this is a clear fail. The mechanical
rule, built as faithfully as possible to the friend's actual described logic (not a rough
approximation), loses money consistently.

**User decision, recorded for the audit trail**: the user reviewed this result and chose to
proceed to Phase 4 anyway, trusting the friend's rules and opinion over this specific mechanical
backtest's verdict. This is a deliberate, informed override of the plan's own gate, not a silent
pass — the underlying numbers above stand, and Phase 5 (§4 below) reruns the same comparison with
the AI layer included, over the same real data.

## 4. The AI decision layer (Phase 4/5)

`AutonomousAiDecisionService` sits on top of `AutonomousRuleEngineService`: it calls the AI **only
when the mechanical engine has already found a candidate** (a confluence-confirmed,
touched-and-retraced level, no volatility spike, one order/day not yet used) — never to originate a
trade idea the mechanical rule didn't already flag (AUTONOMOUS_DEMO_TRADING_PLAN.md §13.1's
recommendation, applied literally). The AI is given the same raw signals the mechanical engine used
(current price, H4/D1 levels, both levels' touch/retrace/broken state, the friend's historical
EURUSD pattern stats, upcoming high-impact events/news, today's order count) plus the friend's
rules verbatim, and independently produces a decision in the plan's exact schema
(`action`/`confidence`/`entry_price`/`stop_loss`/`take_profit`/`position_size`/`reasoning`).
`validate-autonomous-ai-decision.ts` then independently re-derives and checks every number — exact
SL/TP distance, `position_size` exactly `0.01` (hardcoded, not `.env` config — a safety bound, not
a friend's-rule parameter), correct side (a BUY's stop below and target above entry, and the
mirror for a sell) — before anything is logged as a confirmed decision; a response that fails any
check is rejected outright and logged as a HOLD with the rejection reason, never silently
corrected. Provider: `AutonomousGeminiProvider`, a REST call to Gemini at `temperature: 0` for
reproducibility — a new, small class rather than reusing the existing `ai/gemini-provider.ts`,
since that one's `AiProvider` interface is hard-coupled to the unrelated alert-narration schema
(`AlertContext`/`AiAnalysisResult`).

**Phase 5 status: blocked on API quota, not yet a real result.** The first attempt at
`npm run backtest-autonomous-rule`'s AI-assisted section had a real bug: a mechanical candidate
that stayed valid across several M15 candles (price sitting in an already-retraced zone) got
re-asked to the AI on every subsequent candle instead of once, because the "already evaluated
today" flag was only set when a trade actually opened, never on a veto or rejection. This turned
~60 intended calls into **1,927 real ones** in a single run, which exhausted the account's real
Gemini API quota (confirmed: a direct follow-up call returned `429: quota exceeded`). The bug is
fixed (the flag is now set as soon as the AI is consulted, regardless of outcome — verified: a
rerun immediately after the fix made exactly 64 candidate-detections, in line with the mechanical
backtest's own 61), and the script now detects a quota/rate-limit error on the first occurrence and
aborts immediately rather than burning through further calls on a result that would just be more
of the same failure — but the quota was already spent by the time the fix landed, so the corrected
rerun's own 64 calls also failed, and there is currently no valid AI-assisted backtest result to
report.

**Update — confirmed a real daily quota, not just a per-minute rate limit.** Diagnosed directly:
even single calls spaced 10+ seconds apart still failed instantly with the same `429 quota
exceeded` (423ms–1.4s response times, not a hanging/slow request), ruling out a simple
requests-per-minute throttle that pacing alone would fix. Added a 5-second pacing delay plus
`withTransientRetry` around each call, and changed the abort condition to trip only after several
CONSECUTIVE rate-limit-shaped failures survive both (rather than the first one), so a genuinely
transient blip won't cause a premature abort in a future run — but the account's real daily
allowance appears to be currently exhausted regardless of pacing.

**Update — a new API key did not fix it; quota is exhausted at the Google Cloud PROJECT level, not
the key.** Generated a brand-new `GOOGLE_AI_API_KEY` under the same Google Cloud project and reran —
it hit the identical `429: quota exceeded` after only 4 calls. This means the free tier's daily cap
is tracked per-project (or per-billing-account), not per-key, so rotating the key alone can never
recover from it. **Fix**: `AutonomousGeminiProvider` is now wrapped in `AutonomousFallbackProvider`
(`autonomous-ai-fallback-provider.ts`), built via `buildAutonomousAiProvider`
(`autonomous-ai-provider.factory.ts`) — the single place both `AutonomousModule` and the scripts
construct the provider, so they can't drift apart. It tries Gemini first, then whichever of
`OPENROUTER_API_KEY`/`GROQ_API_KEY` are configured (`AutonomousGroqProvider`,
`AutonomousOpenRouterProvider` — same request shape as `ai/groq-provider.ts`/`ai/openrouter-provider.ts`,
but implementing `AutonomousAiProvider`, the trade-decision schema, not the alert-narration one).
A provider that just failed is put on a 5-minute cooldown and skipped (not retried) on subsequent
calls — added because the same provider instance is reused across many calls in a short window (the
backtest script calls `decide()` roughly once per mechanical candidate), and re-running Gemini's
full ~14s retry-and-backoff on every single call when it's already known to be quota-exhausted from
seconds ago would make a ~60-candidate backtest take 15-20+ minutes for no benefit. The cooldown is
bounded, not permanent — Gemini is tried again after it elapses, since a quota exhaustion is a
time-boxed condition (resets daily), not a permanent one.

**Update — two more bugs found getting the fallback chain actually working, then a real result.**
(1) Both `AutonomousGroqProvider` and `AutonomousOpenRouterProvider` initially reused the
alert-narration providers' `max_tokens: 1024` — too low for this schema: the fallback models are
reasoning models that spend tokens on hidden chain-of-thought before their visible JSON answer, and
this schema's own `reasoning` field is asked to be substantive (cite the friend's rules and specific
levels) unlike alert narration's shorter fields. Both hit 100% failure (`json_validate_failed` /
"not valid JSON") until raised to `max_tokens: 4096`, confirmed live afterward with a direct
single-call test against both. (2) OpenRouter's free-tier routing then turned out to take 60-70+
seconds per call against this schema's larger prompt (sometimes still invalid after the whole wait),
while Groq answered correctly in a few seconds every time — `autonomous-ai-provider.factory.ts`
therefore tries Groq BEFORE OpenRouter for this feature specifically (the opposite order from
`ai.module.ts`'s alert-narration chain, where that latency difference doesn't matter).

With both fixed, a full run finally completed all 63 of its own independently-detected mechanical
candidates (a small, expected difference from the rules-only path's 61 — see this function's own
"deliberately NOT refactored to share code" note) without needing to abort. Real result:
**AI-assisted: 36 trades opened (36/63 candidates confirmed, 19 vetoed, 8 lost to the day's provider
quota exhaustion below — not a real AI judgment on those), 16 wins / 20 losses, 44.44% win rate,
profit factor 0.80, total P&L -720 points** (with the same assumed 15pt spread) — versus rules-only's
-4140 points / 31.15% win rate / profit factor 0.45 over 61 trades. The AI layer roughly halved the
trade count and cut the total loss by ~6x, but the result is STILL NET NEGATIVE (profit factor below
1.0) — read this as "AI confirmation filters out a lot of the worst mechanical signals," not as "AI
confirmation makes this a winning system." All three configured providers (Gemini, Groq, OpenRouter)
independently hit their own real daily caps within this same session from cumulative testing —
confirms the caps are genuinely tight on free tiers, not a one-provider fluke, and that any rerun on
the same day as heavy testing risks a repeat.

A genuinely useful side-finding from this same run: the friend's own 249 real EURUSD trades with
recorded SL/TP average ~123pt stop / ~244pt target (roughly 1:2), not this rule's flat 180/180
(1:1) — worth asking him about directly, since it suggests his real practice may not match his
stated rule exactly.

This backtest also cannot replay genuinely historical news/events (this database only retains
current/forward-looking market events, not a historical archive) — treat the AI-vs-rules-only
difference above as reflecting the AI's judgment on price/level/pattern data only, not real
news-awareness.

## 5. The risk manager and kill switch (Phase 6, in progress)

`risk-manager.ts`'s `evaluateRiskManager` is the deterministic gate plan §4 calls for — it sits
between the AI decision layer and whatever execution module eventually calls MT5's `order_send`
(no such module exists in this repo yet, so this function has no live caller yet, same as every
other pipeline stage was built and tested ahead of its own orchestration this session). It
enforces exactly the plan's narrowed-down §4 scope — the demo-account gate (`accountInfo.tradeMode
!== 'DEMO'` is an automatic, unconditional reject, the single most safety-critical check in this
project), the kill switch, the friend's one-order-per-day rule, and a full independent re-check of
every number the AI already validated (exact SL/TP distance, `0.01` position size, correct side) —
and nothing else: no daily-loss cap, circuit breaker, or trading-hours window, per this project's
explicit commitment not to layer invented risk rules on top of the friend's strategy.
`kill-switch.ts`'s `isKillSwitchActive()` implements path 3 of the plan's 3 kill-switch paths (a
plain file check, `AUTONOMOUS_KILL_SWITCH_PATH` or `./KILL_SWITCH` by default) — deliberately built
first, since it's the one path that doesn't depend on the backend, Telegram, or the database being
healthy. The Telegram `/stop` command and a dashboard button (the other two paths) don't exist yet.

Also as of this session: a genuinely separate demo MT5 account now exists for this project
(`bootstrap.ts` was rerun against `BOOTSTRAP_MT5_LOGIN` pointed at the new account) — distinct from
whatever account any other collector/monitor watches, exactly the separation plan §1 requires
before any execution module can safely exist.

**The Python side now exists too**: `collector/app/executor.py` is the OTHER half of the plan's
"duplicated at both layers" defense-in-depth for the demo-account check — `verify_demo_account()`
calls MT5's own `account_info().trade_mode` directly and refuses to proceed unless it's exactly
`ACCOUNT_TRADE_MODE_DEMO`, called at the start of every single public method, every time, never
cached. `send_bracket_order()` (retry-once-on-failure, per plan §5) and `close_position()` (the
kill switch's future "close everything" action) are the only two ways this module can touch a live
account. Deliberately NOT added to `mt5_client.py` — that file's own docstring states its
read-only guarantee must never change, so this is a new, separate, equally small file instead;
`mt5_client.py`'s invariant stays exactly true, and the entire write-capable surface of this whole
project is `executor.py`, nothing else, easy to review in full (17 tests, all passing, mirroring
`test_mt5_client.py`'s own monkeypatch-the-mt5-module convention).

**The end-to-end wiring now exists too.** `AutonomousExecutionCoordinatorService` sits on top of
`AutonomousAiDecisionService`: it computes today's real order count and the account's real
`trade_mode` (from the latest `AccountSnapshot` — fail-closed to `REAL` if there is no snapshot, or
one that never recorded `trade_mode`, so "unknown" is never treated as "safe"), checks the real
file-based kill switch, and runs `evaluateRiskManager` with all of it. An approved trade is queued
as `AutonomousDecision.orderStatus = PENDING`; the collector polls
`GET /collector/:accountId/autonomous/pending-order` (`AutonomousExecutionController`, same
`CollectorTokenGuard` every other collector route uses) on its normal cycle, and that GET **atomically
claims** the order (flips it to `SENT` in the same request) so a second poll before a result comes
back can never see — and re-execute — the same order twice. The collector then calls
`executor.py`'s `send_bracket_order()` and reports the outcome back via
`POST .../pending-order/:decisionId/result`, which the backend records as `FILLED` or `FAILED`.

**The one deliberate gap left in this loop**: nothing on the backend automatically calls
`AutonomousExecutionCoordinatorService.run()`. The only way a `PENDING` order is ever created today
is a human running `npm run evaluate-autonomous-rule` (with `AUTONOMOUS_TRADING_ACCOUNT_ID` set) in
`backend/`. Symmetrically, the collector's own poll-and-execute step
(`AUTONOMOUS_EXECUTION_ENABLED` in `collector/.env`) is off by default — an existing collector's
behavior is completely unchanged unless explicitly turned on. This is intentional, not an
oversight: this system should not go from "the code exists and is tested" to "runs unsupervised"
in the same step it was first wired together. Turning either of these on is a decision for the
person running this system to make deliberately, not a side effect of this session's work.

## 6. What this module deliberately does not do

- Does not run automatically — no backend scheduler calls the execution coordinator, and the
  collector's own execution step is off by default (see the note just above). A human runs the CLI
  script; that is the only trigger that exists today.
- Does not implement the Telegram `/stop` or dashboard-button kill-switch paths — only the
  file-based one (§5 above) exists so far.
- Does not run a position-monitoring loop (plan §5's "check open positions every 10 seconds") —
  `executor.py` can open and close positions when called, but nothing polls open positions on a
  schedule yet (this matters less than it would otherwise, since SL/TP are enforced by the broker
  itself once a position is open — see the plan's own §5 resilience note).
- Does not replay historical news/events in the AI-assisted backtest (§4 above) — a real limitation
  of this database's market-event storage, not a design choice.
