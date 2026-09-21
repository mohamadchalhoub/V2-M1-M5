# XAUUSD M1 RSI Retest / Extremes — Frozen Specification

**Strategy identifier:** `xauusd-m1-rsi-retest-extremes-v1`
**Status:** FROZEN, revision 3. The rules are unchanged from revision 2.
Revision 3 records a scope change only: the strategy is implemented and
operated on **live DEMO data**, and historical evaluation is out of scope.
**Scope:** The single enabled entry strategy of this application. DEMO accounts only.

**Revision 2 changed three things**, all at the user's explicit instruction:

1. Extreme SELL is **98.5** everywhere. Revision 1 fired at 98 because the
   user's original text stated 98.5 as the threshold while its crossing and
   rearm examples said 98; the user has confirmed those were stale.
2. The one-position-total rule is replaced by **two independent execution
   slots** (§6A), so a retest and an extreme position may be open at once.
3. XAUUSD is observed **once per second** (§8.2).

**Revision 3 changed no rule.** At the user's explicit instruction,
historical evaluation, backtesting, trade simulation and historical
win-rate or profitability analysis are removed from scope. No simulated
figure is an activation criterion, and no rule here is adjusted on the basis
of one. Earlier simulation output is retained, clearly labelled as archived
research, in `backend/research-archive/xauusd-rsi/`. Historical broker
queries remain permitted where reconciliation of real orders, positions and
executions requires them.

This document is the authority for the rules below. Code must match it, and
`spec.ts` carries a hash of the machine-readable half of it so a runtime state
file can never be silently reused across a rule change.

Two kinds of statement appear here and are deliberately kept apart:

- **USER RULE** — stated explicitly by the user. Never changed to improve results.
- **IMPLEMENTATION ASSUMPTION** — not fully specified by the user; a documented
  default chosen here. Labelled inline, and listed together in §8.

No threshold in this document was tuned. No filter exists that the user did not
ask for. The strategy is implemented faithfully whether it makes or loses money.

---

## 1. Instrument, timeframe, indicator

| Item | Value | Provenance |
|---|---|---|
| Instrument | XAUUSD | USER RULE |
| Timeframe | M1 | USER RULE |
| Indicator | RSI, period 5 | USER RULE |
| Applied price | Close | **VERIFIED** against the terminal's own `iRSI` (§8.1) |
| Smoothing | Wilder (MT5 `iRSI` convention) | **VERIFIED** against the terminal's own `iRSI` (§8.1) |

The RSI period of 5 is read from the screenshots' own `RSI(5)` sub-window label,
which the user confirmed in prose.

## 2. Thresholds

| Setting | Value | Provenance |
|---|---|---|
| Sell 2 | 91 | USER RULE |
| Sell 1 | 82 | USER RULE |
| Buy 1 | **18** | USER RULE — explicitly overrides the `14` visible in the screenshots |
| Buy 2 | 8.9 | USER RULE (taken from the screenshot) |
| Extreme SELL | 98.5 | USER RULE — used for triggering, rearming, config, dashboard and tests |
| Extreme BUY | 1.5 | USER RULE |

All comparisons use full-precision floating point RSI values. Rounded display
values (what the chart prints) are never used for an equality or crossing test.

## 3. Entry setups

There are exactly four. No others exist, and none may be added.

### 3.1 SELL — RSI peak retest

1. RSI rises above 91 (`Sell 2`).
2. It forms a peak.
3. It retreats **without falling below 82** (`Sell 1`).
4. It rises back to that saved RSI peak.
5. Emit SELL.

The repeated level is an **RSI value**, not a gold price. Gold does not need to
revisit the price it had at the first RSI peak.

- `92 → 86 → 92` — valid SELL.
- `92 → 80 → 92` — invalidated at 80; the saved peak is discarded.

### 3.2 BUY — RSI trough retest

1. RSI falls below 8.9 (`Buy 2`).
2. It forms a trough.
3. It rebounds **without rising above 18** (`Buy 1`).
4. It falls back to that saved RSI trough.
5. Emit BUY.

- `7 → 15 → 7` — valid BUY.
- `7 → 20 → 7` — invalidated at 20.

### 3.3 Extreme SELL

Emit SELL when RSI reaches **98.5**. No peak-retest pattern is required.

### 3.4 Extreme BUY

Emit BUY when RSI reaches **1.5**. No trough-retest pattern is required.

## 4. Peak / trough formation — IMPLEMENTATION ASSUMPTION (§8.3)

**SELL:**
- Once RSI exceeds 91, track the running maximum.
- The peak is confirmed and frozen only when RSI **pulls back out of the
  arming zone**, i.e. falls **below Sell 2 (91)**. A merely lower reading
  that is still at or above Sell 2 does not freeze anything — the move is
  still forming.
- Then wait for the first observation that returns **to or above** that peak.
- Invalidate if RSI goes **below 82** before that return.

**BUY:**
- Once RSI falls under 8.9, track the running minimum.
- The trough is confirmed and frozen only when RSI **rebounds out of the
  arming zone**, i.e. rises **above Buy 2 (8.9)**. A merely higher reading
  that is still at or below Buy 2 does not freeze anything.
- Then wait for the first observation that returns **to or below** that trough.
- Invalidate if RSI goes **above 18** before that return.

Equal consecutive readings do **not** on their own confirm a reversal — a plateau
extends the running extreme rather than freezing it.

Touching 82 or 18 **exactly** does not invalidate. Only crossing beyond the
boundary does: invalidation is `rsi < 82` for SELL and `rsi > 18` for BUY.

No minimum pullback size and no extra confirmation candles are required. Adding
either would be an unrequested filter.

## 5. Crossing semantics — IMPLEMENTATION ASSUMPTION (§8.2)

Detection is **intrabar**, not completed-M1-close.

| Event | Condition |
|---|---|
| SELL retest | `previous < savedPeak` and `current >= savedPeak` |
| BUY retest | `previous > savedTrough` and `current <= savedTrough` |
| Extreme SELL | crossing from `< 98.5` to `>= 98.5` |
| Extreme BUY | crossing from `> 1.5` to `<= 1.5` |

> **Resolved in revision 2.** Revision 1 fired extreme SELL at 98 rather than
> 98.5, because the user's original text gave 98.5 as the threshold while its
> crossing definition and rearm rule both said 98. That discrepancy was
> surfaced rather than silently resolved, and the user has since confirmed the
> 98 references were stale text. A single value, **98.5**, is now used for
> triggering, rearming, configuration, the dashboard, this specification and
> the tests.

Extreme BUY never had such a discrepancy: 1.5 is used for the threshold, the
crossing, and the rearm.

## 6. Rearming and duplicate prevention — IMPLEMENTATION ASSUMPTION (§8.4)

- After a SELL retest signal, the SELL retest setup rearms only once RSI `< 82`.
- After a BUY retest signal, the BUY retest setup rearms only once RSI `> 18`.
- After an extreme SELL, a new one requires RSI `< 98.5` and then a fresh
  crossing back to `>= 98.5`.
- After an extreme BUY, a new one requires RSI `> 1.5` and then a fresh crossing
  back to `<= 1.5`.

Merely **remaining** inside an extreme region can never repeatedly create orders.

If more than one setup triggers on a single observation, **one decision per
rule family** is created (§6A), each carrying only its own family's reasons,
and every contributing event is consumed. Within a family, simultaneous
triggers still merge into one decision.

A position closing while RSI is still extreme does **not** produce a new entry —
rearming is driven purely by RSI leaving and re-entering the region, never by
occupancy becoming free.

## 6A. Execution slots — USER RULE (revision 2)

The four setups group into **two independent rule families**, each holding at
most one active, pending or uncertain entry of its own:

| Slot | Setups |
|---|---|
| `RETEST` | SELL peak retest, BUY trough retest |
| `EXTREME` | Extreme SELL (>= 98.5), Extreme BUY (<= 1.5) |

Consequences, stated explicitly because each is easy to get wrong:

- One retest position **may** coexist with one extreme position.
- Maximum concurrency is **two** positions.
- This is **not** one slot per directional setup. A SELL retest and a BUY
  retest compete for the same slot.
- A second entry is never opened for a family while its existing exposure or
  submission is unresolved — including an `UNKNOWN` submission, which holds
  its slot precisely because its outcome is not known.
- Closing a position does not by itself create a signal, and a signal skipped
  because its slot was occupied is consumed, never replayed.

This supersedes revision 1's one-XAUUSD-position-total rule **for this
strategy's own two slots only**. It does not relax the separate protection
against exposure the application cannot attribute to a slot: a foreign or
manual position, or an unresolved submission from a retired strategy, still
blocks both families entirely.

Slot reservation is **atomic at the database level** (a partial unique index),
so two concurrent evaluations cannot both take one family's slot. Aggregate
risk accounting includes already-reserved stop risk, so two signals on one
observation cannot jointly exceed the combined cap.

Each family uses its **own magic number** — `262610190` for RETEST and
`262610191` for EXTREME — so an open broker ticket is attributable to one slot
rather than merely to this strategy.

### Broker account compatibility — IMPLEMENTATION REQUIREMENT

Two independent positions on one symbol, each with its own stop and target,
exist only on a **hedging** account. On a netting account a second order
merges with, reduces or reverses the first.

The application therefore reads `account_info().margin_mode` and **refuses**
the second concurrent position unless the account is `RETAIL_HEDGING`. It does
not emulate two positions with one net position, and it treats "margin mode
unknown" as a refusal distinct from "netting".

*Verified on this deployment:* MetaQuotes-Demo account 5055783885 reports
`margin_mode = 2 (RETAIL_HEDGING)`, so the two-slot model is faithfully
supported here.

## 7. Take profit, stop loss, duration

USER RULE, identical for all four setups:

- **TP distance:** 5.00 USD of quoted gold price.
- **SL distance:** 5.00 USD of quoted gold price.

| Side | Entry | TP | SL |
|---|---|---|---|
| SELL | 4450 | 4445 | 4455 |
| BUY | 4450 | 4455 | 4445 |

The user noted that an earlier SELL example showing `SL 4555` was a typo. It is
not implemented.

These are **gold-price distances**. They are not five broker points, and they do
not guarantee a $5 account-currency profit or loss — realised P&L depends on
volume, contract size, the account currency, spread, commission, swap and
slippage.

There are **no** RSI-based exits, trailing stops, break-even moves or partial
take-profits. The screenshot labels `Buy tp1`, `Sell tp2` and similar are
indicator threshold lines, not exit rules.

A position normally stays open until TP, SL, or a user-authorised close. The one
exception is Friday's mandatory pre-weekend liquidation (§9.3).

## 8. Implementation assumptions, collected

### 8.1 RSI calculation
MT5-compatible Wilder RSI(5) applied to **Close**.

**Parity verified (revision 2).** The MetaTrader5 Python API exposes no
indicator functions, so an MQL5 script (`MQL5/Scripts/RsiReference.mq5`) was
compiled and run inside the terminal to export `iRSI(XAUUSD, PERIOD_M1, 5,
PRICE_CLOSE)` alongside the bars it was computed from. This implementation,
recomputed over exactly those closes, agrees with the terminal to
**5 x 10^-11** across 5,000 live M1 bars once the recursive average has
converged. Applied-price is therefore no longer an assumption: `PRICE_CLOSE`
reproduces the terminal's own values. A 1,200-bar extract is kept as a
regression fixture.

Intrabar values are computed from the **previous closed-bar Wilder state**
plus the forming M1 bar's current price. Each tick is *not* treated as its own
RSI period; the forming bar is recomputed from the prior closed state on every
tick, and the state is committed exactly once when the minute completes. The
projection was verified to equal the committed value for the same price, and
to leave committed state untouched.

**Flat-price behaviour, corrected again (revision 3).** Revisions 1 and 2 both
described this wrongly, in opposite directions. The correct statement:

**Flat closes leave RSI exactly unchanged. They do not raise it.** A
zero-change close contributes zero to both the gain and the loss side, so
Wilder smoothing multiplies the average gain and the average loss by the same
`(period - 1) / period` factor. Their ratio is therefore preserved, and RSI
with it. Revision 2's claim that flat closes "raise RSI", and its "~54.5"
figure, were wrong; verified against this implementation, a mixed history
reading 64.1616 still reads 64.1616 after eight consecutive flat closes.

The single exception is the degenerate case where average loss is **already**
zero — a history containing no downward change at all, which includes an
all-flat series from initialization. MT5 reports 100 there and keeps
reporting it, and that is reproduced rather than filtered. Across 5,000 live
M1 bars the longest run of unchanged closes was shorter than the RSI period,
so this case did not arise.

This correction is to the **explanation only**. The RSI calculation is
unchanged and remains the MT5-verified one (§8.1).

**Timestamp basis (revision 3).** Stored tick and M1 candle timestamps are
broker-server wall clock (EET/EEST) wearing a UTC label, not true UTC. The
strategy converts them once, at the read boundary, via
`src/xauusd-rsi/tick-time.ts`. Measured on 2026-09-20: the newest stored
XAUUSD tick read three hours ahead of real time, which put observation
timestamps in the future, disabled the staleness test (a negative age always
passes a `<= 30s` comparison) and persisted `observed_at` three hours ahead
of the event. Stored rows are NOT rewritten; the conversion is applied on
read, and a watch cursor recorded on the old basis is discarded rather than
trusted.

**Quote freshness at the send boundary (revision 3).** The 30s limit in
`observation.maxStalenessMs` is enforced at detection, at the backend
pre-send check, and — newly — against a freshly fetched MT5 tick immediately
before `order_send`, on every attempt including the retry. Cadence is not
freshness: a one-second loop guarantees a one-second read, not a
one-second-old market price, and the two are reported separately.

### 8.2 Live timing
Intrabar detection, per §5. Completed-M1-close detection is never silently
substituted; if only closed bars are available the observation mode is
reported as such and the limitation is disclosed.

**Observation cadence — USER RULE (revision 2): once per second.** Both halves
are required and both are implemented: the collector reads XAUUSD every second
on its own dedicated thread, and the strategy's watch loop evaluates at the
same cadence. A one-second collector feeding a sixty-second evaluator would
not satisfy this.

The collector fetches **incremental ticks** (`copy_ticks_from`) against a
cursor rather than only sampling the instant each poll lands on, so movement
between polls is captured. The cursor's boundary tick is never re-pushed, an
unchanged quote produces no synthetic observation, and a failed push does not
advance the cursor. Actual cadence, observation age and cycle latency are
measured and reported rather than assumed.

The collector's main poll loop keeps its own interval, so unrelated EURUSD
collection is unchanged.

### 8.3 Peak / trough formation
Per §4.

### 8.4 Rearming
Per §6.

### 8.5 Warm-up
Wilder RSI needs seeding. The engine requires `period` (5) seed bars plus a
warm-up margin of 250 additional closed M1 bars before any signal may be emitted,
so the recursive average has converged well past its seeding transient. During
warm-up the engine observes and updates state but emits nothing.

### 8.6 Gaps
After a data gap longer than the configured continuity limit, pattern state is
**reset**, not carried across. A pattern may never be inferred through an
unobserved interval, and absence of an observed crossing is never treated as
proof that no crossing occurred.

## 9. Trading schedule

Timezone: **`Asia/Beirut`** (IANA), including daylight-saving transitions. All
timestamps are stored internally as UTC and converted explicitly for every
schedule decision. The broker clock is never assumed to equal UTC or Beirut time.

This section supersedes every earlier schedule in this application. The old
04:00–12:00 entry restriction is removed.

### 9.1 Daily entry pause — USER RULE
New entries are prohibited every day from **23:30 inclusive** to **01:00
exclusive** the following day, Beirut time.

Outside the pause, entries may occur whenever the broker is trading and all
execution checks pass.

On an ordinary weekday a position opened before 23:30 may stay open through the
pause and past 01:00. Neither boundary forces a close. Position protection and
reconciliation continue throughout.

### 9.2 Friday entry cutoff — USER RULE
On Friday, new entries stop at **23:00 Beirut**. The allowed interval is strictly
`< 23:00:00`; at and after 23:00:00 no new entry may be submitted.

This is rechecked at the **actual submission boundary**. A signal or queued
decision created before the cutoff must not submit after it. Unsent entry
intentions are cancelled at the cutoff. Anything already sent, or whose outcome
is uncertain, is **reconciled** — never assumed cancelled.

### 9.3 Friday mandatory closure — USER RULE
Every position and pending order owned by this application's managed gold
strategies must be closed or cancelled **before Friday 23:30 Beirut**.

Operating default (IMPLEMENTATION ASSUMPTION): liquidation begins immediately at
the 23:00 cutoff, not at 23:29. Starting at 23:00 is a means of meeting the
23:30 deadline, not a trading signal.

The procedure cancels broker-side pending entry orders, submits closes for owned
open positions, reconciles partial fills, uncertain submissions and late
discovered fills, and continues until broker-confirmed owned exposure and owned
pending orders are zero.

Scope is this application's **owned** gold exposure, including any explicitly
registered old gold position still under migration management. Manual trades and
another system's positions are never closed merely for sharing the XAUUSD symbol.
Foreign or manual exposure is displayed separately; the application never claims
the whole account is flat when only strategy-owned exposure is flat.

If the broker's real Friday session ends earlier, closure starts early enough for
that session. The requested clock time is never assumed to guarantee broker
availability.

Closure counts as successful **only on broker evidence**. A submitted close
request is not proof of closure.

If connectivity, broker rejection or market closure prevents liquidation: new
entries stay disabled, bounded reconciliation and retry continue, a critical
dashboard state and a gold Telegram incident are raised, and the report states
plainly that the deadline was missed and what exposure remains. Success is never
falsely reported and a position is never assumed to have disappeared.

On startup after the Friday cutoff, or during the weekend, the application
reconciles first and handles remaining owned exposure. It never depends on a cron
callback having fired while the computer was off.

### 9.4 Weekend pause and reopening — USER RULE
After the Friday cutoff, new entries stay disabled until the broker's actual
post-weekend XAUUSD session reopens. `Sunday 00:00` is **not** hardcoded.

Entries resume only when all of the following hold: the post-weekend broker
session is confirmed open; fresh tradable data is available; the daily
23:30–01:00 pause is not active; recovery and reconciliation are complete; and no
independent risk or maintenance block remains.

If the market reopens during the daily pause, the application keeps waiting until
01:00. If broker session availability cannot be established, it stays paused and
says why.

### 9.5 Signals during blocked periods — USER RULE
RSI observation and state processing continue whenever valid data is available.

A signal occurring during a daily, Friday, weekend, occupancy or risk block is
logged as **skipped**, with its reason, and **consumed** under the normal
rearming rules of §6. It is never queued for later execution — not at 01:00, not
after the weekend, and not when another position closes.

After a data gap or market closure, a valid RSI pattern is never inferred through
the unobserved interval.

## 10. Execution and risk

DEMO only. The existing execution infrastructure is reused, and these properties
are preserved: fresh DEMO-account verification, gold pause and kill-switch
controls, existing risk/margin/drawdown limits, broker volume limits and step
validation, quote and signal freshness, maximum entry deviation, atomic decision
claim with durable deduplication, reconciliation of uncertain submissions, and at
most one active/pending/uncertain XAUUSD exposure at a time.

Volume: the current valid configured value is kept. Where no valid explicit
setting exists, the default is **0.5 lot**. Volume is never increased, caps are
never weakened, and an order is never silently resized to make it acceptable.

Ownership is unambiguous: a distinct strategy version string and a magic number
not used by any previous strategy. Existing old-strategy positions retain their
original identity and protective management and are never silently adopted or
relabelled.

Bid/ask are used correctly for entries, exits, SL and TP. Broker protection is
requested and then reconciled against the actual fill; requested price, fill
price, slippage, desired brackets and broker-reported brackets are all recorded.
Broker tick size and stop/freeze constraints are validated, and the $5 stop is
**never** silently widened to make an order acceptable — such an order is
rejected instead.

For new-strategy positions the existing escalation is preserved: one protection
restore attempt, then a later fresh broker snapshot, then a scoped close if
protection is still missing. Old positions' protection distances are not changed
to $5.

Friday liquidation takes precedence over opening entries and routine restoration.
Close and remediation requests are coordinated so two workers cannot submit
duplicate closes. Entry pauses and kill switches never disable protective
closures, reconciliation or Friday liquidation for owned positions.

## 11. Continuous operation

While manually started and with its infrastructure available, the application
monitors continuously and processes eligible signals automatically, continuing
after wins, losses, rejected orders and recoverable errors.

"Always working" does not mean always placing orders, and never means bypassing
the schedule, DEMO identity, risk, occupancy, data or broker restrictions. Retry
is bounded and backed off, and an uncertain order is reconciled before retry.

**Manual start only.** No Windows startup task, service, reboot autostart or
unattended supervisor is installed. It follows that Friday liquidation cannot be
performed by local software when the laptop, the required processes or the broker
connection are unavailable. Approaching deadlines and outages are made visible;
guaranteed closure is never claimed.


---

## Revision 4 — the rebound must be real

**Corrected after a live entry that should never have been opened**
(2026-09-21, ticket 58555388969).

Revisions 1-3 froze the peak or trough on the **first strictly contrary
observation** — any tick in the opposite direction, however small. That made
the recorded entry possible:

| | |
|---|---|
| Frozen trough | 8.0752 |
| Previous RSI | 8.1199 |
| Current RSI | 8.0752 |
| Total movement | **0.045**, across three ticks |

There was no rebound and no second trough: one continuous dip with a wiggle
in it. The same defect existed on the SELL side, and fired there too (peak
92.2464, previous 92.2114, current 92.5632 — 0.035 of movement).

It also made the invalidation thresholds unreachable. If a 0.03 wiggle counts
as the rebound, RSI can never travel far enough to test Buy 1 or Sell 1, so
those levels could never do their job.

**The rule, as the user states it:** wait for a trough genuinely below Buy 2,
wait for RSI to leave it, and wait for RSI to come back down to the same RSI
value as the trough. The mirror applies to the SELL side.

**Implemented as:** the extreme freezes when RSI leaves the arming zone —
below Sell 2 for a peak, above Buy 2 for a trough — and the entry still
requires the subsequent return to the frozen level, with Sell 1 / Buy 1
invalidating throughout. Nothing else changes: thresholds, volume, brackets,
slots, schedule and risk controls are all unchanged.


---

## Revision 5 — closed-bar progression, intrabar entry

Revision 4 was wrong and was never deployed. It required the rebound to rise
above Buy 2, which the user rejected: *"i dont mind if it is above 8.9, what
i want is to still below 18."* The rule as the user states it:

**BUY**
1. An M1 bar **closes** with RSI below **Buy 2 (8.9)** — the trough. Deeper
   closes while below Buy 2 move the trough down.
2. At least one later bar **closes strictly higher** — "at least one candle
   should be rising". Its size is irrelevant: a close of 8.12 after a trough
   of 8.00 confirms exactly as well as a close of 17.9 does.
3. Every bar in between must **close below Buy 1 (18)**. A bar that closes
   above it kills the trough, and a fresh one below Buy 2 must form.
   **An intrabar spike above Buy 1 does not invalidate** — only the close
   counts: *"if rsi rise above 18 and the candle closed when rsi was below 18
   --> keep testing."*
4. **Intrabar**, the moment RSI returns to the trough's RSI value or lower,
   the entry fires. It does not wait for a close.

**SELL** is the mirror on Sell 2 (91) and Sell 1 (82).

The separation is the point: **progression is read off the closed-bar RSI
line — the line on the chart — while the entry is intrabar.** Ticks can never
arm, freeze or invalidate anything. That is what makes the 2026-09-21 entry
impossible: its three readings (8.0752, 8.1199, 8.0752) were ticks inside
bars, invisible on the chart, and under this rule they move no state at all.

Warm-up seeding calls `applyClosedBar` with `advancePattern = false`, so
historical bars still make RSI computable without leaving a trough or peak
that the first live tick could retest.

The extremes (98.5 / 1.5) are unchanged and remain intrabar crossings.
Thresholds, volume, brackets, slots, schedule and risk controls are all
unchanged.
