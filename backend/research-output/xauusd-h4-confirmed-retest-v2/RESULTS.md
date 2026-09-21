# xauusd-h4-confirmed-retest-v2 — Results (2026-09-15, single frozen run)

**One run, on the available historical data, as instructed.** No grid search, no threshold
retuning, no automatic v3. v1 is untouched and its own zero-sample conclusion is not recycled or
reused here — v2 stands on its own result.

- Spec hash `45160276ec48c41b00648abc91866b04d9a4c0be1086379eb54f5683e14de0e6`
- Data hash `d9686b633f55618ee129bc169102b2b8173d6e4ae479d522f8e51630b34be09c`
- Frozen endpoint `2026-09-15T06:46:00.000Z`, commit `8f8de41` (spec/code committed before this
  run — see `git log` on the run's own `manifest.json.gitCommit`)
- Full machine-readable output: `runs/end-20260915T064600Z__spec-45160276ec48/`
  (`manifest.json`, `formation.json`, `levels.csv`/`.json`, `pivots.csv`, `retests.csv`,
  `events.csv`/`.json`, `event-study.json`, `paper-summary.json`, `paper-branches.json`,
  `REPORT.md` — the full formation funnel, coverage and standing limitations)

## Verdict

**LOSING_UNDER_TESTED_ASSUMPTIONS** (pre-declared mechanical rule, `spec.ts`'s `conclusionRule`,
unchanged from v1): the Wilson 95% upper bound on the resolved win rate (19 W / 33 L = 19/52 →
24.8%–50.1%) sits below the 52.0% breakeven win rate implied by the `ASSUMED_BASE` cost scenario.
This is **not** "insufficient sample" (v2 has 57 eligible events, well past the pre-declared
minimum of 30) and it is **not** "worth forward observation" under the pre-declared rule as
written. Read plainly: under v2's retest rule and these cost/session assumptions, the resolved
events lose money before spread/slippage even enters — the Wilson upper bound is already under
breakeven on the raw win rate alone.

**A losing historical result is not, on its own, proof the underlying idea is wrong** — see
"Sample uncertainty" and "What this does and doesn't establish" below — but it gives no basis to
recommend forward observation, and **a positive result would not have been authorization for
broker execution either.**

## Full formation funnel (entire replay including warm-up, all-hours — no session-window
dependency in this section)

| Stage | Resistance | Support |
|---|---|---|
| Pivot candidates | 775 | 795 |
| Qualified (≥$10 rejection close on the 2 confirming bars) | 574 | 637 |
| — not qualified | 201 | 158 |
| Body violation *before* any retest was found (retired) | 295 | 254 |
| No retest within 5–120 bars (retired) | 67 | 157 |
| **Retest found** (of which, watching for confirmation) | 202 | 225 |
| — body violation *during* the R+1/R+2 confirmation window (retired) | 71 | 61 |
| — confirmation failed: none of R/R+1/R+2 closed $10 favorably (retired, no further search) | 33 | 38 |
| **Level activated** | **98** | **126** |

(11 qualified pivots combined across both roles were still mid-retest-search or mid-confirmation,
unresolved either way, at the frozen endpoint — correctly: resolving them needs bars this run does
not have. The rows above are not forced to sum to "qualified" for that reason.)

206 levels activated inside the study period (2024-03-01 → 2026-09-15), 0 pre-existing at study
start; 24 D1-agreement tagged (descriptive only, not a filter). End states: 207 CONSUMED (a first
return occurred), 17 EXPIRED (120 H4 bars with no return). Zero activations were blocked by the
same-price/same-role dedup rule in this run (no two independent pivots happened to share an exact
price).

Contrast with v1: v1 required an *exact-price second pivot*, which happened only once (outside the
5–120 window) across the same history — hence its zero-sample result. Replacing that with "any bar
that retests L without violating the body filter" is a much looser geometric condition, so this
funnel producing a real sample, while v1's produced none, is expected and mechanical, not a
surprising finding about the market.

## Output A — event study (every qualifying first return, overlap allowed, no risk gating)

Study-period first returns by kind: 167 ORDINARY, 21 UNOBSERVABLE (excluded from W/L, gap-related),
2 GAP_CROSS (excluded from W/L). Of the 167 ORDINARY: 110 fell outside the 04:00–12:00 Beirut
window (not eligible), leaving **57 eligible**.

| | N | WIN | LOSS | AMBIGUOUS | INDETERMINATE | UNRESOLVED (still open) |
|---|---|---|---|---|---|---|
| **Full period** | 57 | 19 | 33 | 5 | 0 | 0 |
| BUY (support) | 36 | 10 | 21 | 5 | 0 | 0 |
| SELL (resistance) | 21 | 9 | 12 | 0 | 0 | 0 |

Resolved win rate 19/(19+33) = 36.5% (Wilson 95%: 24.8%–50.1%); all-eligible conservative bounds
33.3%–42.1% (treating every AMBIGUOUS as a loss, then as a win). SELL (resistance, 42.9% resolved)
outperformed BUY (support, 32.3% resolved) in this sample, but both sub-bucket Wilson intervals
(SELL 24.5%–63.5%, BUY 18.6%–49.9%) are wide enough to overlap — this is descriptive, not a
separate conclusion; the pre-declared rule was evaluated on the full-period bucket only, per spec.

By year: 2024 7/11 = 63.6%, 2025 1/16 = 6.3%, 2026 11/25 = 44.0% (partial year). The by-year swing
is large — see "Sample uncertainty" below.

### Representative chronological examples (not cherry-picked for outcome — first, a WIN, and a LOSS in
date order)

1. **`lvl:S:231003:g1:29`** (SUPPORT, L=$2310.03) — pivot 2024-06-17T13:00Z, retest
   2024-06-18T13:00Z, confirmed/activated 2024-06-18T17:00Z. First eligible return
   2024-06-26T06:04Z (09:04 Beirut, inside window) → **LOSS**.
2. **`lvl:S:249355:g1:41`** (SUPPORT, L=$2493.55, D1 agreement) — pivot 2024-08-28T09:00Z, retest
   2024-09-02T05:00Z, confirmed/activated 2024-09-02T09:00Z. First eligible return
   2024-09-03T01:10Z (04:10 Beirut) → **WIN**.
3. **`lvl:R:252331:g1:46`** (RESISTANCE, L=$2523.31) — first eligible return 2024-09-11T06:02Z
   (09:02 Beirut) → **WIN**.

Full chronological list with every field: `runs/.../events.csv` (`eligible=true` rows).

## Output B — one-position paper simulation (never compared with Output A totals)

- **Primary assumed $1,000 balance: 0 trades entered in every cost scenario.** Same mechanical
  block as v1: 0.01 lot × $10 stop = $10 = 1% of $1,000, which exceeds the 0.5%-of-equity stop-risk
  cap on every eligible event (`STOP_RISK_EXCEEDS_0_5_PCT` × 54, the branch count). This is not a
  new finding — v1 documented the same $2,000 minimum-nominal-equity requirement for this cap under
  the same fixed 0.01-lot volume; unchanged here, volume/risk settings were not altered.
- **$10,000 sensitivity-only balance** (pre-declared, not a claim of real equity): 44–45 trades
  entered across 32 forked branches (branching only where an outcome was genuinely uncertain — 5
  AMBIGUOUS events), 14–18 wins, 27–30 losses, net P&L **-$90.00 to -$160.00** at
  `ASSUMED_BASE` cost, max drawdown 1.71–2.21% of equity, 0 branches halted, 0 still open at the
  frozen endpoint. Every cost scenario (including `IDEALIZED_GROSS`, zero spread/slippage/
  commission) is net negative — the loss is not a cost-scenario artifact.
- **Costs are labeled assumptions, not measured history** — no historical ask, spread, commission,
  swap or slippage data exists for this account (M1 spread column is NULL for every row); the
  $10,000 balance itself is not a real account snapshot (none exists). `IDEALIZED_GROSS` being
  negative means this isn't a "the real result would be positive without costs" case.
- Overlapping/forked branches are P&L across genuinely uncertain scenario forks, **not** a
  portfolio-level return — 32 branches sharing history are not 32 independent outcomes, and this
  number must never be read as "expected portfolio performance."

## Sample uncertainty

- 57 eligible events is a real sample (above the pre-declared 30-event floor) but still narrow:
  the Wilson interval width (24.8%–50.1%, a 25-point span) reflects that. The mechanical LOSING
  verdict is driven by the *upper* bound sitting under breakeven — with more data the true rate
  could still turn out anywhere in that band.
- Events are **not independent**: 40 distinct days had at least one eligible event, with up to 5 on
  one day, and 18 overlapping event pairs (two active positions' evaluation windows overlapping in
  time). Same regime, same broad price trend, and shared macro conditions mean the effective sample
  size is smaller than 57 independent trials — Wilson intervals assume independence and so
  understate the true uncertainty, exactly as they did for v1's documentation of this caveat.
- The by-year split (2024: 63.6%, 2025: 6.3%, 2026 partial: 44.0%) is a striking non-stationarity
  signal on its own — far more consistent with regime dependence (or with formation being sparse
  enough that a handful of bad 2025 trades dominate) than with a single stable underlying edge or
  lack of one. This is reported descriptively; the pre-declared rule does not condition on year.
- Previously inspected 2023–2026 XAUUSD history is **not a pristine holdout** — this is exploratory
  history the engine and its predecessor have both already been developed and tuned against
  generally (even though v2's specific rule was frozen before this run). Only genuinely new forward
  data would be an out-of-sample test.

## Time-evidence scope (see `TIME_EVIDENCE.md`, `XAUUSD_H4_CONFIRMED_RETEST_V2_SPEC.md` §4)

The formation funnel above is timestamp-basis-robust (no session-window dependency). The
session-window-filtered Output A/B numbers **do** depend on the EET/EEST broker-clock correction,
which is live-verified for EU summer (EEST, +3h) as of 2026-09-15 but only arithmetic-inferred, not
live-measured, for winter (EET, +2h). Touches in winter months (most of Nov–Feb across all three
years in this sample) therefore carry that unverified-offset caveat; no alternative interpretation
was computed or compared, and none was selected to favor this result.

## What this does and doesn't establish

- This is **one** bounded, frozen, GPT-authorized rule revision, tested **once**. It is not a claim
  that "retest doesn't work" in general, that v1's exact-match rule was closer to the friend's real
  method, or that any parameter of v2 is well-chosen — none of that was explored, by instruction.
- **No broker execution is authorized by this or any result** — `AUTONOMOUS_EXECUTION_ENABLED`
  stays false throughout; this task added no order path (verified statically,
  `test/research/confirmed-retest-v2/boundary.spec.ts`, 27/27 passing) and did not touch
  execution settings, EURUSD, or `h4-trend-h1-breakout-v1`.
- No further v2 iteration, parameter search, or v3 was performed, per instruction. If someone wants
  to explore tolerance/zone variants of the retest rule, that is explicitly a **new, separately
  frozen version**, not an edit here.
