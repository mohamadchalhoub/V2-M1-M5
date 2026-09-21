# xauusd-h4-confirmed-retest-v1 — Frozen Research Specification

**Status:** FROZEN 2026-09-14, before any aggregate result of this version was computed or read.
**Machine-readable form:** `spec.ts` (`SPEC`), SHA-256 of its canonical JSON = `SPEC_HASH` =
`bc43a393385f3f77b5189a6eb797318f60bc245d77e20fb86f5e7cfe928ed695`
(printed by every run and stamped on every output file; see `manifest.json` of a run).
**Scope:** research, historical replay and watch-only observation. **No order path exists.**
It does not enable broker execution, place orders, or promote itself if a backtest looks good.
These are fixed research assumptions, **not a claim of profitability.**

Separate from, and must not change: `weekly-h4-sr-v1` (archived legacy), `h4-trend-h1-breakout-v1`,
all EURUSD behaviour (volume 0.12), and the earlier `research/first-touch` module (superseded, see §9).

---

## 1. Rule provenance

| # | Principle | Source | How v1 makes it executable (GPT completion) |
|---|---|---|---|
| P1 | H4 support/resistance lying outside candle bodies or at their edges | Friend (discretionary principle) | §4.4 body filter: from first pivot through second pivot's confirmation, resistance body tops ≤ level, support body bottoms ≥ level; equality allowed |
| P2 | Repeated tests with price moving away | Friend | §4.2 strict 2/2 swing pivots + §4.3 at least one later H4 close ≥ $10 away by each pivot's confirmation |
| P3 | Exact same price | Friend | §4.3 two same-role pivot extremes equal to the broker price increment (integer cents); no tolerance, no rounding |
| P4 | Replacement after breaks | Friend | §5 lifecycle: H4-close break retires a level; a new generation needs two entirely new pivots after the break; "replacement" = choosing among independently established active levels |
| P5 | Possible H4/D1 agreement | Friend | §5.4 descriptive tag only (exact-price, same-role confirmed D1 pivot within prior 120 D1 bars) — never an entry condition |
| G1 | Pivot width 2 left / 2 right, strict | GPT | |
| G2 | Pivot distance 5..120 H4 bars | GPT | |
| G3 | $10 rejection close | GPT | |
| G4 | Activation at the close confirming the second pivot; earliest valid time | GPT | |
| G5 | 120-H4-bar expiry, break = H4 close strictly beyond | GPT | |
| G6 | First return strictly after activation; outside-window return consumes | GPT | Replaces the earlier ambiguous "first-touch" wording |
| G7 | Entry window 04:00–12:00 Asia/Beirut (DST-aware) | GPT | Supersedes the earlier 03:00–09:00 gold research window |
| G8 | ±$10 TP/SL, no deadline/trailing/breakeven/partial | GPT | |
| G9 | Paper selection, risk gates, cost scenarios, closure-evidence rule | GPT | §8–§10, §3.3 |

**This is not an exact reproduction of the friend's discretionary trading.** It is one explicit,
mechanical reading of the friend's principles. Explicitly NOT imported: the old weekly-extremes rule,
the 180-point rule, the 50-point-entry rule and the 500-point-movement rule.

## 2. Instrument, prices and time

- Symbol XAUUSD, configured broker `MetaQuotes-Demo` (login 5055783885, account trade mode 0 = DEMO per
  the 2026-09-13 backfill instrument-verification log; symbol path `Metals\XAUUSD`, digits 2, point 0.01,
  tick size 0.01, contract size 100 oz).
- All prices are integers in broker increments (1 unit = $0.01). $10 = 1000 units. Stored decimals are
  validated to be exact multiples of 0.01; any row that is not is a data-validation failure.
- Stored `open_time` is converted from broker-server wall clock (IANA `EET`, EU DST rules) to true UTC;
  entry-window and yearly buckets use `Asia/Beirut` wall clock of that UTC instant.
- A bar's interval is `[open, open + duration)`; H4 duration 4 h, D1 24 h, M1 1 min, M5 5 min.
- Touch timestamps are reported as the M1 (or M5-substitute) **interval**, never an invented second.

## 3. Data

### 3.1 Window
- Study period: first returns whose touch interval starts ≥ 2024-03-01 00:00 Asia/Beirut
  (2024-02-29T22:00Z) through the frozen endpoint = close of the latest completed M1 bar used.
- Warm-up: replay starts at the first stored H4 bar (level formation, break/retirement state and
  first-return consumption are carried into the study period — eligibility is **not** reset on the
  start date). Before the study start, consumption is tracked on H4 bars (sufficient for "was it
  touched", which is all a pre-study return needs); pre-study returns are never evaluated as trades.
- Ticks are optional. The existing tick backfill loop failed (`Terminal: Call failed`) and is not retried.

### 3.2 Time-basis evidence (why stored times are server clock, not UTC)
The XAUUSD daily maintenance break (anchored to 17:00 New York) appears at stored hour 00 in both
winter and summer, but moves to stored hour 23 exactly during the weeks when the US is on DST and the
EU is not (2024-03-12..03-28, 2024-10-29..31, 2025-03-11..27, 2025-10-28..30). No D1 bars exist on
Sundays. True-UTC data would show the break shifting between 21:00 and 22:00 and Sunday trading.
Therefore stored times = EET/EEST wall clock (`MT5_BROKER_TIMEZONE=EET` in the collector config).
The collector comment claiming candle times "genuinely are UTC" is incorrect; the collector is left
unchanged (other strategies read the same rows) and this study converts explicitly.

### 3.3 Gap classification (GPT data rule)
An M1 gap is the missing interval between consecutive stored M1 bars. It is a **CONFIRMED_CLOSURE**
only when all hold:
1. it lasts ≥ 30 minutes;
2. no broker-native M5, M15, M30 or H1 bar lies fully inside it;
3. its end (server time-of-day) is within ±5 min of a reopen time observed as a gap end on ≥ 20
   distinct dates, and its start is within ±2 min of a close time observed as a gap start on ≥ 2
   distinct dates.

Otherwise it is **UNCONFIRMED**. For unconfirmed M1 gaps, M5 bars lying fully inside the gap are
substituted into the evaluation stream (marked `M5_SUBSTITUTE`, coarser resolution), and the remaining
sub-gaps are re-classified. A remaining unconfirmed sub-gap is **BRIDGED** when every missing minute
is covered by an existing M5 bar; the bridge range is the min low / max high of those bars. Bridges
bound prices the broker recorded in any series; they do not reveal order. Anything else is
**UNBRIDGED**. Recurrence evidence is computed over the whole frozen dataset (a data-quality calendar,
not a trading signal); watch mode uses the evidence available when it runs.

A completed download ledger is not evidence of complete coverage (e.g. the M1 ledger says COMPLETED
for 2026-05-19..28 although ~9 days of M1 are missing while M5 exists).

### 3.4 Validation (reported per run in `coverage.json`)
Row counts/ranges per timeframe; strictly increasing timestamps (duplicates); grid alignment;
OHLC consistency (high ≥ max(open, close), low ≤ min(open, close)); exact-cent check; no weekend bars;
M1 gap inventory by class; broker H4 vs M1-aggregate consistency; ledger status; provenance gaps
(per-row `server` column is NULL for every stored candle — provenance rests on the backfill log and
`symbol_metadata`, disclosed as such).

## 4. Level construction (completed H4 bars only)

4.1 Bars are indexed in stored order (index distance counts available broker H4 bars).

4.2 **Pivot.** Resistance candidate at index i: `high[i] > high[i±1], high[i±2]` (strict).
Support: mirrored on lows. Knowable only at the close of bar i+2 (confirmation).

4.3 **Qualification.** A candidate qualifies when, among closes of bars i+1..i+2, at least one is
≤ level − $10 (resistance) or ≥ level + $10 (support). Otherwise rejected `NO_REJECTION_CLOSE`.

4.4 **Pair.** When a qualified pivot j confirms, every earlier qualified same-role pivot i with the
exactly equal price and 5 ≤ j − i ≤ 120 is tested with the body filter over bars i..j+2
(resistance: `max(open, close) ≤ level`; support: `min(open, close) ≥ level`). Crossings through a
nearby level are not formation tests.

4.5 **Activation** at the close of bar j+2 (the second pivot's confirmation). If several i are valid,
the earliest valid i is recorded as the partner (others listed). Formation visits are not entries.

4.6 A level's key is (role, exact price). No duplicates while a key is ACTIVE (`REDUNDANT_WHILE_ACTIVE`).

## 5. Lifecycle

States: CANDIDATE (pivot), ACTIVE, CONSUMED, BROKEN, EXPIRED.
- ACTIVE → CONSUMED at its first return (§6), whatever the window or position state.
- ACTIVE → BROKEN at a completed H4 close strictly above resistance / below support.
- ACTIVE → EXPIRED at the close of the 120th completed H4 bar after activation.
- Same instant order: D1 bar processing, then H4; at an H4 close, break is checked before expiry.
- No role reversal. A CONSUMED/EXPIRED key stays retired until a later completed H4 close strictly
  beyond its price (`subsequent confirmed break`). After any break (of an active or retired key) a new
  generation needs two pivots both after the break bar and never used as source pivots before.
  Generation numbers and source pivot ids are stored.
- An entered event is never cancelled because its level later breaks.
5.4 **D1 agreement (metadata only):** true when a same-role strict 2/2 D1 pivot with exactly the same
price exists among the 120 most recent completed D1 bars and its confirmation close ≤ activation time.

## 6. First return

- Every ACTIVE level is tracked on every evaluation bar with open ≥ activation, including outside the
  window. Confirming candles cannot count as the return.
- Resistance (support mirrored), evaluation bar b after any gap handling:
  - `b.open > level` → **GAP_CROSS** (consumed, no entry, reported separately);
  - `b.open == level` or (`b.open < level` and `b.high ≥ level`) → **ORDINARY** touch, SELL;
  - support: `b.open < level` → GAP_CROSS; `b.open == level` or (`b.open > level` and `b.low ≤ level`) → ORDINARY, BUY.
- If an UNBRIDGED gap precedes b, or a BRIDGED gap's range contains the level, the first return may
  be hidden: **UNOBSERVABLE** (consumed conservatively, reported separately, never a trade).
- ORDINARY touch whose interval starts within 04:00 ≤ t < 12:00 Asia/Beirut and in the study period is
  an **eligible event**; otherwise consumed as `OUTSIDE_WINDOW` (or `PRE_STUDY`).

## 7. Target, stop and outcome engine

- Idealized entry = level price. BUY TP = +$10, SL = −$10; SELL mirrored. Gold-price distances, not
  guaranteed account P&L. No deadline; events are followed across sessions until resolved or data ends.
- **Entry candle** (the touch bar is included): under the idealized continuous-price-path assumption
  (price moves continuously within a bar, consistent with its OHLC), the set of reachable post-entry
  results {WIN, LOSS, NONE} is computed exactly (signed axis where TP is "up"; `adv` = extreme on the
  stop side, `fav` = the other):
  LOSS reachable iff adv ≤ SL; WIN reachable iff fav ≥ TP; NONE reachable iff adv > SL and
  (open > entry ? close : fav) < TP. NONE continues the race from the next bar.
- **Later bars:** after gap handling, open at/beyond TP or SL resolves at that open (exit type GAP_OPEN
  when strictly beyond, observed open price recorded; idealized status unchanged); both TP and SL
  inside the range → AMBIGUOUS; one → WIN/LOSS; none → continue.
- **Gaps:** CONFIRMED_CLOSURE → continue with the reopen bar's open first; BRIDGED → INDETERMINATE if
  TP or SL lies within the bridge range, else continue; UNBRIDGED → INDETERMINATE. Resolution is never
  inferred from the next price after an unconfirmed gap.
- **Event status** from the reachable final results: WIN and LOSS both reachable → AMBIGUOUS (final);
  otherwise any pending branch → UNRESOLVED; otherwise any INDETERMINATE branch → INDETERMINATE;
  otherwise the single WIN or LOSS. Never pick the branch that improves results.
- **Ticks** may resolve a bar only when their source attests completeness AND the tick bids reproduce
  the bar's OHLC exactly. A 5-second maximum inter-tick gap is not proof of completeness. No tick
  source qualifies in v1 (0 stored ticks), so none are used.
- End of data → UNRESOLVED, re-evaluated when new bars arrive (watch mode).

## 8. Output A — event study
Every eligible event of every level, overlaps allowed. Answers only the conditional historical
price-movement question. Overlapping-event P&L is never presented as achievable performance.

## 9. Output B — one-position paper simulation
- One open XAUUSD position. At each evaluation-bar start the known price is the previous bar's close;
  the nearest ACTIVE resistance ≥ it and nearest ACTIVE support ≤ it are selected and frozen for that bar.
- A selected eligible event may enter only if flat. Touches of all other levels still consume them.
- Both selected sides touched in the same bar with unknown order → selection ambiguity, forked into
  both orders (no hindsight choice). Order is known only when exactly one side is reached at the open.
- No re-entry in the minute of an exit.
- Uncertain outcomes fork scenario branches (e.g. WIN in the entry minute vs. a later exit); an
  INDETERMINATE branch halts at the gap with a stated limitation; > 512 branches halts further forking.
  Reported as bounds over branches, never as an invented release time.
- Volume 0.01 lot fixed (EURUSD 0.12 untouched); never auto-resized; only the user may change it (logged).
- Starting balance: no demo equity snapshot exists → **assumed $1,000 (primary)**. Declared in advance:
  0.01 lot × 100 oz × $10 = $10 = 1% of $1,000, which breaches the 0.5% stop-risk cap, so the primary
  simulation is expected to skip every entry for that reason. An **assumed $10,000 sensitivity** is
  reported separately and labeled as such.
- Gates (new entries only; TP/SL monitoring continues): stop-risk ≤ 0.5% of equity, combined ≤ 1%,
  daily loss block at −2% vs the Beirut day's starting equity mark, drawdown block at −5% from peak
  equity mark (marks include floating P&L; no cash flows in history; no automatic reset).
- Costs are **labeled assumptions** (no historical ask/spread/commission/swap/slippage evidence):
  IDEALIZED_GROSS (not verified zero), ASSUMED_LOW, ASSUMED_BASE, ASSUMED_STRESS (see `spec.ts`).
  Current broker swap is used only as a proxy scenario, never as known historical cost.

## 10. Watch-only operation
`npm run confirmed-retest:watch` replays newly stored, settled bars into a persisted state
(`research-state/`), appends forward observations to a journal and refuses to run if the state's
`SPEC_HASH` differs. Shadow entries require a quote ≤ 5 s old, spread ≤ $1 and executable price within
$1 of the level at decision time, else skip and consume. The module imports nothing that can send
orders (enforced by test). No LLM invents levels, modifies risk, selects trades or overrides outcomes.

## 11. Statistics and validation
Chronological replay only. Full period plus Beirut calendar-year and half-year breakdowns; BUY/SELL.
WIN, LOSS, AMBIGUOUS, INDETERMINATE, UNRESOLVED reported separately; resolved win rate W/(W+L) with
numerator/denominator and Wilson 95% interval (assumes independence — likely too narrow because events
cluster); conservative all-eligible bounds W/N .. (N−L)/N with GAP_CROSS and UNOBSERVABLE listed
separately. Previously inspected history is not a pristine holdout; only future watch-only
observations are forward evidence. Too few exact-price repeats is a valid result: no tolerance,
pivot or parameter search follows from it.

**Pre-declared conclusion rule** (`SPEC.conclusionRule`). Breakeven win rate under ASSUMED_BASE costs
p* = 10.45 / 20.10 ≈ 51.99%. In order: (1) fewer than 30 resolved events (W+L) → INSUFFICIENT EVIDENCE;
(2) Wilson upper bound of W/(W+L) below p* → LOSING UNDER TESTED ASSUMPTIONS; (3) Wilson lower bound
above p*, W/N above p*, and the worst branch of the $10,000-sensitivity × ASSUMED_BASE paper run net
positive → PROMISING BUT UNPROVEN; (4) otherwise INSUFFICIENT EVIDENCE (inconclusive).

## 12. Superseded claims and the earlier first-touch engine
All earlier first-touch diagnostic figures (including any "51/72"-style counts and the
`collector/reports/level-review` case studies, whose "UTC" labels were server-clock times) are retired
and must not be cited. The earlier engine audit is in `ENGINE_AUDIT.md`.
