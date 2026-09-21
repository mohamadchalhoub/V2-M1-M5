# xauusd-h4-confirmed-retest-v1 — run end-20260911T200000Z__spec-bc43a393385f

Mode: **HISTORICAL_STUDY** · Spec hash `bc43a393385f3f77b5189a6eb797318f60bc245d77e20fb86f5e7cfe928ed695` · Data hash `ecffa99bb997bfae0ee1d8725e50e8b32d7e541445e2bdb6e178d0ea678639cb`
Frozen endpoint (close of latest completed M1 bar used): **2026-09-11T20:00:00.000Z** · Study start 2024-03-01T00:00:00 Asia/Beirut (2024-02-29T22:00:00.000Z) · Warm-up from 2023-01-25T22:00:00.000Z
Run command: `npm run confirmed-retest:study -- --end 2026-09-11T20:00:00.000Z` · git b918a0e512e4ad3576323e74b643a187fe4f075c

**No orders were placed or can be placed by this code.** Research replay only; these are fixed research assumptions, not a claim of profitability.

## Mechanical conclusion (pre-declared rule): INSUFFICIENT EVIDENCE

only 0 resolved eligible events (W+L); the pre-declared minimum is 30.

## Data coverage

| TF | rows | first (UTC) | last (UTC) | non-cent | OHLC viol. | non-increasing | grid misaligned | weekend bars | tz errors |
|---|---|---|---|---|---|---|---|---|---|
| M1 | 879503 | 2024-02-29T19:59:00.000Z | 2026-09-11T19:59:00.000Z | 0 | 0 | 0 | 0 | 0 | 0 |
| M5 | 176144 | 2024-02-27T20:00:00.000Z | 2026-09-11T19:55:00.000Z | 0 | 0 | 0 | 0 | 0 | 0 |
| M15 | 59720 | 2024-02-25T23:00:00.000Z | 2026-09-11T19:45:00.000Z | 0 | 0 | 0 | 0 | 0 | 0 |
| M30 | 30059 | 2024-02-19T23:00:00.000Z | 2026-09-11T19:30:00.000Z | 0 | 0 | 0 | 0 | 0 | 0 |
| H1 | 15364 | 2024-01-30T20:00:00.000Z | 2026-09-11T19:00:00.000Z | 0 | 0 | 0 | 0 | 0 | 0 |
| H4 | 5618 | 2023-01-25T22:00:00.000Z | 2026-09-11T13:00:00.000Z | 0 | 0 | 0 | 0 | 0 | 0 |
| D1 | 1006 | 2022-10-17T21:00:00.000Z | 2026-09-09T21:00:00.000Z | 0 | 0 | 0 | 0 | 0 | 0 |

M1 gaps (study period): CONFIRMED_CLOSURE 651 (437676 min) · UNCONFIRMED_BRIDGED 99 (225 min) · UNCONFIRMED_UNBRIDGED 47 (5517 min). M5 bars substituted into unconfirmed M1 holes: 1816.
Broker H4 vs M1 aggregate (study period): 3877 exact of 3920; 2 mismatched (1 with an unconfirmed M1 hole inside); 41 without M1.
Stored ticks: 0 used (no tick source attests completeness). A COMPLETED ledger row is not proof of complete coverage.

## Level formation (entire replay incl. warm-up)

H4 bars processed 5618; pivot candidates R 774 / S 793; qualified (≥$10 rejection close) R 573 / S 635.
Exact-price repeat pairs, any distance: R 0 / S 1; within 5..120 bars: R 0 / S 0.
Pair outcomes: {}. Activations blocked: {}.
Levels activated: R 0 / S 0 (0 activated inside the study period, 0 active at study start); D1-agreement tagged 0.
Level end states: {}.

## Output A — event study (every qualifying first return, overlap allowed)

Study-period first returns by kind: {}. Not eligible: {} (GAP_CROSS and UNOBSERVABLE are excluded from W/L and listed here separately).

| Bucket | Eligible N | WIN | LOSS | AMBIG | INDET | UNRES | Resolved W/(W+L) | Wilson 95% | All-eligible W/N – (N−L)/N |
|---|---|---|---|---|---|---|---|---|---|
| Full period | 0 | 0 | 0 | 0 | 0 | 0 | 0/0 = n/a | n/a | n/a – n/a |
| BUY (support) | 0 | 0 | 0 | 0 | 0 | 0 | 0/0 = n/a | n/a | n/a – n/a |
| SELL (resistance) | 0 | 0 | 0 | 0 | 0 | 0 | 0/0 = n/a | n/a | n/a – n/a |
| D1 agreement (descriptive) | 0 | 0 | 0 | 0 | 0 | 0 | 0/0 = n/a | n/a | n/a – n/a |
| No D1 agreement | 0 | 0 | 0 | 0 | 0 | 0 | 0/0 = n/a | n/a | n/a – n/a |

Dependence: 0 distinct days with eligible events, max 0 on one day, 0 overlapping event pairs. Wilson intervals assume independent events. Events sharing a day, a price regime or an open-trade window are not independent, so the true uncertainty is wider than shown. Previously inspected history is not a pristine holdout.

## Output B — one-position paper simulation (never compare with Output A totals)

| Balance | Costs | Branches | Trades | W | L | Net P&L | Net exp./trade | PF | Max equity DD | Exposure % | Halted | Open at end |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ASSUMED_1000_PRIMARY | IDEALIZED_GROSS | 1 | 0 | 0 | 0 | $0.00 | n/a | n/a | $0.00 (0%) | 0 | 0 | 0 |
| ASSUMED_1000_PRIMARY | ASSUMED_LOW | 1 | 0 | 0 | 0 | $0.00 | n/a | n/a | $0.00 (0%) | 0 | 0 | 0 |
| ASSUMED_1000_PRIMARY | ASSUMED_BASE | 1 | 0 | 0 | 0 | $0.00 | n/a | n/a | $0.00 (0%) | 0 | 0 | 0 |
| ASSUMED_1000_PRIMARY | ASSUMED_STRESS | 1 | 0 | 0 | 0 | $0.00 | n/a | n/a | $0.00 (0%) | 0 | 0 | 0 |
| ASSUMED_10000_SENSITIVITY | IDEALIZED_GROSS | 1 | 0 | 0 | 0 | $0.00 | n/a | n/a | $0.00 (0%) | 0 | 0 | 0 |
| ASSUMED_10000_SENSITIVITY | ASSUMED_LOW | 1 | 0 | 0 | 0 | $0.00 | n/a | n/a | $0.00 (0%) | 0 | 0 | 0 |
| ASSUMED_10000_SENSITIVITY | ASSUMED_BASE | 1 | 0 | 0 | 0 | $0.00 | n/a | n/a | $0.00 (0%) | 0 | 0 | 0 |
| ASSUMED_10000_SENSITIVITY | ASSUMED_STRESS | 1 | 0 | 0 | 0 | $0.00 | n/a | n/a | $0.00 (0%) | 0 | 0 | 0 |

Decision tallies (min … max across branches):

- ASSUMED_1000_PRIMARY × IDEALIZED_GROSS: 
- ASSUMED_1000_PRIMARY × ASSUMED_LOW: 
- ASSUMED_1000_PRIMARY × ASSUMED_BASE: 
- ASSUMED_1000_PRIMARY × ASSUMED_STRESS: 
- ASSUMED_10000_SENSITIVITY × IDEALIZED_GROSS: 
- ASSUMED_10000_SENSITIVITY × ASSUMED_LOW: 
- ASSUMED_10000_SENSITIVITY × ASSUMED_BASE: 
- ASSUMED_10000_SENSITIVITY × ASSUMED_STRESS: 

Costs are labeled assumptions — no historical ask, spread, commission, swap or slippage evidence exists (the M1 spread column is NULL for every row). The $1,000 balance is assumed (no demo equity snapshot exists); the $10,000 run is a pre-declared sensitivity only.

## Standing limitations

- Previously inspected XAUUSD history is not a pristine holdout; only future watch-only observations are forward evidence.
- Idealized continuous-price-path assumption inside each bar; ambiguity is reported, never resolved by choice.
- Gap classification is an evidence rule (recurrence + cross-series silence), not a broker session calendar.
- Per-row candle provenance columns are NULL; broker/server provenance rests on the backfill log and symbol_metadata.
- Stored bar times are broker-server wall clock (EET/EEST) and are converted here; the collector itself still labels them UTC.
