# xauusd-h4-confirmed-retest-v2 — run end-20260915T064600Z__spec-45160276ec48

Mode: **HISTORICAL_STUDY** · Spec hash `45160276ec48c41b00648abc91866b04d9a4c0be1086379eb54f5683e14de0e6` · Data hash `d9686b633f55618ee129bc169102b2b8173d6e4ae479d522f8e51630b34be09c`
Frozen endpoint (close of latest completed M1 bar used): **2026-09-15T06:46:00.000Z** · Study start 2024-03-01T00:00:00 Asia/Beirut (2024-02-29T22:00:00.000Z) · Warm-up from 2023-01-25T22:00:00.000Z
Run command: `npm run confirmed-retest-v2:study -- --end 2026-09-15T06:46:00.000Z` · git 8f8de41e68d6ec2b6ec78a02f1ba8234f0d344f0 (working tree had uncommitted changes)

**No orders were placed or can be placed by this code.** Research replay only; these are fixed research assumptions, not a claim of profitability.

## Mechanical conclusion (pre-declared rule): LOSING UNDER TESTED ASSUMPTIONS

Wilson 95% upper bound 50.1% of 19/52 is below the 52.0% ASSUMED_BASE breakeven.

## Data coverage

| TF | rows | first (UTC) | last (UTC) | non-cent | OHLC viol. | non-increasing | grid misaligned | weekend bars | tz errors |
|---|---|---|---|---|---|---|---|---|---|
| M1 | 881173 | 2024-02-29T19:59:00.000Z | 2026-09-15T06:45:00.000Z | 0 | 0 | 0 | 0 | 0 | 0 |
| M5 | 176481 | 2024-02-27T20:00:00.000Z | 2026-09-15T06:40:00.000Z | 0 | 0 | 0 | 0 | 0 | 0 |
| M15 | 59835 | 2024-02-25T23:00:00.000Z | 2026-09-15T06:30:00.000Z | 0 | 0 | 0 | 0 | 0 | 0 |
| M30 | 30118 | 2024-02-19T23:00:00.000Z | 2026-09-15T06:00:00.000Z | 0 | 0 | 0 | 0 | 0 | 0 |
| H1 | 15394 | 2024-01-30T20:00:00.000Z | 2026-09-15T05:00:00.000Z | 0 | 0 | 0 | 0 | 0 | 0 |
| H4 | 5627 | 2023-01-25T22:00:00.000Z | 2026-09-15T01:00:00.000Z | 0 | 0 | 0 | 0 | 0 | 0 |
| D1 | 1008 | 2022-10-17T21:00:00.000Z | 2026-09-13T21:00:00.000Z | 0 | 0 | 0 | 0 | 0 | 0 |

M1 gaps (study period): CONFIRMED_CLOSURE 653 (440796 min) · UNCONFIRMED_BRIDGED 100 (228 min) · UNCONFIRMED_UNBRIDGED 48 (5675 min). M5 bars substituted into unconfirmed M1 holes: 1819.
Broker H4 vs M1 aggregate (study period): 3885 exact of 3929; 3 mismatched (2 with an unconfirmed M1 hole inside); 41 without M1.
Stored ticks: 0 used (no tick source attests completeness). A COMPLETED ledger row is not proof of complete coverage.

## Level formation funnel (entire replay incl. warm-up) — v2 retest rule

H4 bars processed 5627; pivot candidates R 775 / S 795; qualified (≥$10 rejection close on the 2 confirming bars) R 574 / S 637 (not qualified: R 201 / S 158).
Of qualified pivots, how the retest SEARCH ended — body violation before any retest was found: R 295 / S 254; no retest within the 5..120 window: R 67 / S 157; retest found: R 202 / S 225. (The three do not always sum to "qualified": 11 pivot(s) were still mid-watch, unresolved either way, at this run's frozen endpoint — correctly, since resolving them needs bars this run does not have.)
Of retests found, how the CONFIRMATION window ended — body violation during R+1/R+2: R 71 / S 61; confirmation failed (none of R/R+1/R+2 closed $10 favorably, retired): R 33 / S 38; a qualifying close was found (activated, or blocked only by same-price dedup): R 98 / S 126 activated.
Activations blocked by same-price/same-role dedup: {}.
Levels activated total: R 98 / S 126 (206 activated inside the study period, 0 active at study start); D1-agreement tagged 24.
Level end states: {"CONSUMED":207,"EXPIRED":17}.

## Output A — event study (every qualifying first return, overlap allowed)

Study-period first returns by kind: {"ORDINARY":167,"UNOBSERVABLE":21,"GAP_CROSS":2}. Not eligible: {"OUTSIDE_WINDOW":110,"UNOBSERVABLE":21,"GAP_CROSS":2} (GAP_CROSS and UNOBSERVABLE are excluded from W/L and listed here separately).

| Bucket | Eligible N | WIN | LOSS | AMBIG | INDET | UNRES | Resolved W/(W+L) | Wilson 95% | All-eligible W/N – (N−L)/N |
|---|---|---|---|---|---|---|---|---|---|
| Full period | 57 | 19 | 33 | 5 | 0 | 0 | 19/52 = 36.5% | 24.8%–50.1% | 33.3% – 42.1% |
| BUY (support) | 36 | 10 | 21 | 5 | 0 | 0 | 10/31 = 32.3% | 18.6%–49.9% | 27.8% – 41.7% |
| SELL (resistance) | 21 | 9 | 12 | 0 | 0 | 0 | 9/21 = 42.9% | 24.5%–63.5% | 42.9% – 42.9% |
| Year 2024 | 11 | 7 | 4 | 0 | 0 | 0 | 7/11 = 63.6% | 35.4%–84.8% | 63.6% – 63.6% |
| Year 2025 | 16 | 1 | 15 | 0 | 0 | 0 | 1/16 = 6.3% | 1.1%–28.3% | 6.3% – 6.3% |
| Year 2026 | 30 | 11 | 14 | 5 | 0 | 0 | 11/25 = 44.0% | 26.7%–62.9% | 36.7% – 53.3% |
| 2024-H1 | 1 | 0 | 1 | 0 | 0 | 0 | 0/1 = 0.0% | 0.0%–79.3% | 0.0% – 0.0% |
| 2024-H2 | 10 | 7 | 3 | 0 | 0 | 0 | 7/10 = 70.0% | 39.7%–89.2% | 70.0% – 70.0% |
| 2025-H1 | 9 | 0 | 9 | 0 | 0 | 0 | 0/9 = 0.0% | 0.0%–29.9% | 0.0% – 0.0% |
| 2025-H2 | 7 | 1 | 6 | 0 | 0 | 0 | 1/7 = 14.3% | 2.6%–51.3% | 14.3% – 14.3% |
| 2026-H1 | 20 | 6 | 10 | 4 | 0 | 0 | 6/16 = 37.5% | 18.5%–61.4% | 30.0% – 50.0% |
| 2026-H2 | 10 | 5 | 4 | 1 | 0 | 0 | 5/9 = 55.6% | 26.7%–81.1% | 50.0% – 60.0% |
| D1 agreement (descriptive) | 7 | 3 | 3 | 1 | 0 | 0 | 3/6 = 50.0% | 18.8%–81.2% | 42.9% – 57.1% |
| No D1 agreement | 50 | 16 | 30 | 4 | 0 | 0 | 16/46 = 34.8% | 22.7%–49.2% | 32.0% – 40.0% |

Dependence: 40 distinct days with eligible events, max 5 on one day, 18 overlapping event pairs. Wilson intervals assume independent events. Events sharing a day, a price regime or an open-trade window are not independent, so the true uncertainty is wider than shown. Previously inspected history is not a pristine holdout.

## Output B — one-position paper simulation (never compare with Output A totals)

| Balance | Costs | Branches | Trades | W | L | Net P&L | Net exp./trade | PF | Max equity DD | Exposure % | Halted | Open at end |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ASSUMED_1000_PRIMARY | IDEALIZED_GROSS | 1 | 0 | 0 | 0 | $0.00 | n/a | n/a | $0.00 (0%) | 0 | 0 | 0 |
| ASSUMED_1000_PRIMARY | ASSUMED_LOW | 1 | 0 | 0 | 0 | $0.00 | n/a | n/a | $0.00 (0%) | 0 | 0 | 0 |
| ASSUMED_1000_PRIMARY | ASSUMED_BASE | 1 | 0 | 0 | 0 | $0.00 | n/a | n/a | $0.00 (0%) | 0 | 0 | 0 |
| ASSUMED_1000_PRIMARY | ASSUMED_STRESS | 1 | 0 | 0 | 0 | $0.00 | n/a | n/a | $0.00 (0%) | 0 | 0 | 0 |
| ASSUMED_10000_SENSITIVITY | IDEALIZED_GROSS | 32 | 44 … 45 | 14 … 18 | 27 … 30 | $-160.00 … $-90.00 | $-3.64 … $-2.00 | 0.47 … 0.67 | $157.61 … $207.61 (1.57 … 2.07%) | 0.38 … 0.38 | 0 | 0 |
| ASSUMED_10000_SENSITIVITY | ASSUMED_LOW | 32 | 44 … 45 | 14 … 18 | 27 … 30 | $-168.80 … $-99.00 | $-3.84 … $-2.20 | 0.45 … 0.64 | $164.41 … $214.21 (1.64 … 2.14%) | 0.38 … 0.38 | 0 | 0 |
| ASSUMED_10000_SENSITIVITY | ASSUMED_BASE | 32 | 44 … 45 | 14 … 18 | 27 … 30 | $-178.40 … $-108.45 | $-4.05 … $-2.41 | 0.43 … 0.62 | $171.91 … $221.76 (1.71 … 2.21%) | 0.38 … 0.38 | 0 | 0 |
| ASSUMED_10000_SENSITIVITY | ASSUMED_STRESS | 32 | 44 … 45 | 14 … 18 | 27 … 30 | $-196.98 … $-126.90 | $-4.48 … $-2.82 | 0.4 … 0.57 | $186.39 … $236.22 (1.86 … 2.36%) | 0.38 … 0.38 | 0 | 0 |

Decision tallies (min … max across branches):

- ASSUMED_1000_PRIMARY × IDEALIZED_GROSS: NOT_ELIGIBLE_GAP_CROSS 2, NOT_ELIGIBLE_OUTSIDE_WINDOW 110, NOT_ELIGIBLE_UNOBSERVABLE 21, NOT_SELECTED_NEAREST 3, STOP_RISK_EXCEEDS_0_5_PCT 54
- ASSUMED_1000_PRIMARY × ASSUMED_LOW: NOT_ELIGIBLE_GAP_CROSS 2, NOT_ELIGIBLE_OUTSIDE_WINDOW 110, NOT_ELIGIBLE_UNOBSERVABLE 21, NOT_SELECTED_NEAREST 3, STOP_RISK_EXCEEDS_0_5_PCT 54
- ASSUMED_1000_PRIMARY × ASSUMED_BASE: NOT_ELIGIBLE_GAP_CROSS 2, NOT_ELIGIBLE_OUTSIDE_WINDOW 110, NOT_ELIGIBLE_UNOBSERVABLE 21, NOT_SELECTED_NEAREST 3, STOP_RISK_EXCEEDS_0_5_PCT 54
- ASSUMED_1000_PRIMARY × ASSUMED_STRESS: NOT_ELIGIBLE_GAP_CROSS 2, NOT_ELIGIBLE_OUTSIDE_WINDOW 110, NOT_ELIGIBLE_UNOBSERVABLE 21, NOT_SELECTED_NEAREST 3, STOP_RISK_EXCEEDS_0_5_PCT 54
- ASSUMED_10000_SENSITIVITY × IDEALIZED_GROSS: ENTERED 44 … 45, NOT_ELIGIBLE_GAP_CROSS 2, NOT_ELIGIBLE_OUTSIDE_WINDOW 110, NOT_ELIGIBLE_UNOBSERVABLE 21, NOT_SELECTED_NEAREST 3, POSITION_OPEN 8, SAME_MINUTE_AS_EXIT 1 … 2
- ASSUMED_10000_SENSITIVITY × ASSUMED_LOW: ENTERED 44 … 45, NOT_ELIGIBLE_GAP_CROSS 2, NOT_ELIGIBLE_OUTSIDE_WINDOW 110, NOT_ELIGIBLE_UNOBSERVABLE 21, NOT_SELECTED_NEAREST 3, POSITION_OPEN 8, SAME_MINUTE_AS_EXIT 1 … 2
- ASSUMED_10000_SENSITIVITY × ASSUMED_BASE: ENTERED 44 … 45, NOT_ELIGIBLE_GAP_CROSS 2, NOT_ELIGIBLE_OUTSIDE_WINDOW 110, NOT_ELIGIBLE_UNOBSERVABLE 21, NOT_SELECTED_NEAREST 3, POSITION_OPEN 8, SAME_MINUTE_AS_EXIT 1 … 2
- ASSUMED_10000_SENSITIVITY × ASSUMED_STRESS: ENTERED 44 … 45, NOT_ELIGIBLE_GAP_CROSS 2, NOT_ELIGIBLE_OUTSIDE_WINDOW 110, NOT_ELIGIBLE_UNOBSERVABLE 21, NOT_SELECTED_NEAREST 3, POSITION_OPEN 8, SAME_MINUTE_AS_EXIT 1 … 2

Costs are labeled assumptions — no historical ask, spread, commission, swap or slippage evidence exists (the M1 spread column is NULL for every row). The $1,000 balance is assumed (no demo equity snapshot exists); the $10,000 run is a pre-declared sensitivity only.

## Standing limitations

- Previously inspected XAUUSD history is not a pristine holdout; only future watch-only observations are forward evidence.
- Idealized continuous-price-path assumption inside each bar; ambiguity is reported, never resolved by choice.
- Gap classification is an evidence rule (recurrence + cross-series silence), not a broker session calendar.
- Per-row candle provenance columns are NULL; broker/server provenance rests on the backfill log and symbol_metadata.
- Stored bar times are broker-server wall clock (EET/EEST) and are converted here; the collector itself still labels them UTC.
- **Timestamp interpretation is NOT uniformly verified.** The EET/EEST broker-clock conversion used throughout is live-measured for EU summer (EEST, UTC+3) as of 2026-09-15; the winter offset (EET, UTC+2) is confirmed only by historical break-time arithmetic, not a live measurement (see `../confirmed-retest/verification/VERIFICATION_REPORT.md` §1.5 and `TIME_EVIDENCE.md` in this run's directory). Session-window-filtered conclusions (eligible events, the paper simulation) for touches falling in a winter month are therefore assumption-dependent, not verified, and are reported separately from the all-hours formation diagnostics above, which do not depend on the session window at all.
- v2 is a GPT-authorized research revision of v1's formation rule, not a claim about the friend's discretionary method, and not a claim that this rule change is an improvement — it is one bounded, frozen, single-run test.
