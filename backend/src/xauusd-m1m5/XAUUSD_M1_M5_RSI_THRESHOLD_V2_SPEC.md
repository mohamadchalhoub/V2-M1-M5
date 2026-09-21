# xauusd-m1-m5-rsi-threshold-v2 — frozen specification

The prose half of the rules. Its machine-readable counterpart is
[`spec.ts`](./spec.ts), and `SPEC_HASH` is derived from that object. Persisted
strategy state carries the hash it was written under and is **refused**, never
silently migrated, if the rules change — mixing two rule versions inside one
state file produces decisions no audit can later explain.

Section numbers below match the authoritative specification supplied by the
user, so a reader can move between the two without translation.

---

## 1. Identity and scope

| | |
|---|---|
| Strategy id | `xauusd-m1-m5-rsi-threshold-v2` |
| Instrument | XAUUSD only |
| Timeframes | M1 and M5, independently |
| Source commit | `bf083c8` via `trading-monitor-autonomous`, copied at `4103332` |
| Account | A dedicated DEMO account, separate from every other deployment |

This is a **second, independent application**. The M1-only revision-5 bot
(`xauusd-m1-rsi-retest-extremes-v1`) and the original legacy deployment keep
running, unchanged and untouched. Resource isolation is documented in
[`PROVENANCE.md`](../../../PROVENANCE.md).

## 2. One enabled strategy, two execution paths

The application has exactly one enabled entry strategy, containing two
independent execution paths: M1 and M5. Every earlier entry route — H4
support/resistance, confirmed-retest gold, RSI peak/trough and retest,
standalone Extreme SELL/BUY, legacy EURUSD autonomous, H4/H1 trend-breakout,
and AI-assisted approval or veto — is disabled **in this copy only**.

The rule engine makes every trading decision. AI, news and calendar inputs are
informational and never gate execution.

## 3. Entry rules

Indicator: **RSI(5), PRICE_CLOSE, Wilder smoothing**, computed independently
per timeframe.

### 3.1 SELL

```
previous RSI <  91   AND   current RSI >=  91
```

### 3.2 BUY

```
previous RSI >  8.9  AND   current RSI <=  8.9
```

The qualifying **intrabar threshold crossing is itself the signal**. No peak,
trough, confirmation, pullback, rebound, falling candle, rising candle or
retest is required or consulted.

### 3.3 Precision, startup and continuity

- Comparisons use **full-precision** RSI. No rounding, no decimal equality, no
  epsilon.
- Equality at a threshold counts **when approached from the specified side**.
- The first observation after initialization cannot establish a crossing by
  itself, and an RSI already at or beyond a threshold on that first
  observation does not enter. The crossing state is born **disarmed** and arms
  only once RSI is positively observed on the permissive side.
- Warm-up observations never generate entries and never advance continuity.
- After an observation gap longer than that timeframe's budget, continuity is
  re-established **without inventing a crossing** through the unobserved
  interval, and arming is recomputed from where RSI actually is.

### 3.4 Removed behaviour

Peaks, troughs, peak/trough confirmation, pullbacks, rebounds, retests, RSI 82
and 18 invalidation, Sell 1/Sell 2 and Buy 1/Buy 2 hierarchies, and standalone
extreme entries at 98.5 or 1.5 have **no role in entry formation**.

**98.5 and 1.5 survive only as post-loss unlock conditions (§6).** No surface
may present them as entry thresholds.

## 4. Timeframe independence and occupancy

M1 and M5 keep separate RSI and candle state, observation continuity, crossing
and rearming state, signal identities, position ownership, execution and
deduplication state, occupancy, directional locks, and performance records. A
shared tick feed is acceptable; shared indicator or crossing state is not.

At most **one active, pending or uncertain exposure per timeframe**, so at most
**two** strategy positions in total. "Uncertain" counts: an unreconciled
submission may already be a position at the broker.

An M1 position does not occupy M5 and vice versa. The two may be same or
opposite direction, subject to broker hedging support and the shared account
risk, margin and permission gates, which still apply across both.

A signal arriving on an occupied timeframe is **recorded as skipped with its
reason, consumed, and never queued** — it is not executed later when the
position closes.

Ownership is by magic number: **262610200 for M1, 262610201 for M5**. Anything
else is foreign — displayed, counted for exposure, never closed, modified,
adopted or relabelled.

## 5. Normal rearming

A continuous stay beyond a threshold must not repeatedly create orders.

- **SELL** — after a SELL crossing is consumed, RSI must move **below 91**
  before another crossing to 91 or above can signal.
- **BUY** — after a BUY crossing is consumed, RSI must move **above 8.9**
  before another crossing to 8.9 or below can signal.

This applies after submitted, skipped and refused signals alike. Closing a
position while RSI remains beyond the threshold does not create another entry.
Normal rearming does not override a post-loss lock.

## 6. Post-loss directional locks

Four independent, persistent locks: **M1 SELL, M1 BUY, M5 SELL, M5 BUY**.

| Lock | Activated by | Released when |
|---|---|---|
| SELL | a broker-confirmed, fully closed, **negative** realized result on a strategy-owned SELL position of that timeframe | `RSI <= 25` **OR** `RSI >= 98.5` |
| BUY | the same, on a BUY position of that timeframe | `RSI >= 75` **OR** `RSI <= 1.5` |

Equality counts. Unlock is evaluated intrabar on the **owning timeframe's**
valid, full-precision RSI.

### 6.3 Unlocking is not an entry

Unlocking changes **eligibility only**. It never submits an order, replays a
crossing skipped while locked, reuses a consumed signal, or restores a
standalone extreme setup.

This is not theoretical. A SELL lock releases at RSI >= 98.5 while a SELL entry
fires at RSI >= 91 from below, so **one observation at RSI 99 can satisfy both
at once**. The implementation therefore treats the lock's state *as the
observation arrived* as blocking for that whole observation: the direction
becomes eligible only from the next observation onward.

After a SELL unlock at 98.5, RSI must return below 91 and then cross up through
it again. After a BUY unlock at 1.5, RSI must return above 8.9 and then cross
down through it again.

### 6.4 What counts as a loss

The fully closed position's **broker-confirmed net realized result**,
aggregating every attributable deal including commission, swap and fees.

- Negative → activates the lock, **regardless of closure reason** (SL, Friday
  liquidation, protection remediation, user-authorized close).
- Positive → no lock.
- **Zero → no lock**, and reported separately, not as a win or a loss.
- Not fully reconciled → **UNRESOLVED**; no lock decision is taken.

Never activated by floating P&L, a partial closure while exposure remains, an
unconfirmed close request, a rejected entry, a skipped signal, a foreign or
manual position, or another bot's trade.

Closure reconciliation, lock activation and slot release are coordinated so no
worker can enter between them. Duplicate closure reports are **idempotent** and
cannot reactivate a lock whose lifecycle has already been unlocked.

### 6.5 Persistence and ordering

Persisted per lock: strategy, account, timeframe, direction, lock state,
losing position identity, broker-confirmed closure timestamp, net realized
result, activation timestamp, RSI evidence, unlock condition/RSI/timestamp,
and processed closure and unlock event identities.

Restart, reconnect and data loss never clear an active lock. An unlock is never
guessed through an unobserved gap and never derived from warm-up history. An
RSI observation **preceding** the losing closure can never release the lock
that closure caused.

## 7. Orders, protection and risk

| | |
|---|---|
| Default volume | **0.5 lot** (clean V2 default, explicitly configured with an audit trail — never blindly inherited) |
| Take profit | **$5.00** of quoted gold price |
| Stop loss | **$5.00** of quoted gold price |

SELL at 4450 → TP 4445, SL 4455. BUY at 4450 → TP 4455, SL 4445. These are
**price distances**, not five broker points and not guaranteed $5
account-currency results.

No RSI exits, trailing stops, break-even moves or partial take profits.
Positions resolve through TP, SL, user-authorized closure, required protection
remediation, or Friday liquidation.

Preserved unweakened: DEMO-only verification; per-trade stop-risk cap 0.5%;
combined stop-risk cap 1% spanning both timeframes and already-reserved risk;
daily-loss cap 2%; drawdown cap 5%; margin checks; broker volume min/max/step
validation; atomic claim and durable deduplication; reconciliation of uncertain
submissions. Volume is never silently resized and protection never widened to
force acceptance.

Also preserved: the **100-point entry-drift limit** (with broker point size
verified rather than assumed), **60-second signal age** limit, **30-second
quote age** limit, and **2-second future-clock-skew** tolerance. Ask is used
for BUY entries and bid for SELL. Tick size and broker stop/freeze constraints
are validated per order.

Recorded per order: timeframe, signal RSI and time, requested price, fill
price, slippage, requested protection and broker-reported protection.

Missing protection follows one restoration attempt → a later fresh broker
snapshot → a scoped close if protection is still missing. Remediation and
Friday liquidation are coordinated so no duplicate close is issued.

Pauses and kill switches block **new entries** without disabling reconciliation
or protective management.

## 8. MT5 execution readiness

Verified through this application's own collector connection, on its own
terminal: intended account identity, DEMO account type, terminal connected,
terminal `trade_allowed`, terminal `tradeapi_disabled`, account `trade_allowed`,
account `trade_expert`, and hedging compatibility.

Disabled, unknown or stale permission information is an **explicit execution
blocker**. Fresh market quotes are never treated as permission to trade.
Terminal-side and broker-side rejections are distinguished in the dashboard and
in Telegram. Permissions are never toggled automatically on any terminal.

## 9. Trading schedule

IANA timezone **`Asia/Beirut`**, including DST. Timestamps are kept in UTC
internally and converted explicitly for schedule decisions; broker wall-clock
timestamps are never assumed to equal UTC or Beirut time.

### 9.1 Daily entry pauses

New entries are blocked during **both** intervals, every day, on **both**
timeframes:

| Pause | Interval (Beirut) |
|---|---|
| Overnight | **23:30 inclusive → 01:00 exclusive** the following day |
| Afternoon | **14:00 inclusive → 19:00 exclusive**, same day |

The afternoon interval is same-day. The user confirmed this reading
explicitly; the earlier "19:00 exclusive the following day" wording would
describe a 29-hour block overlapping its own next occurrence and is not what
was intended.

The former 04:00–12:00 restriction remains removed.

Pauses do not close existing positions. Observation, rearming, loss-lock
processing, reconciliation and protection all continue. Signals occurring
during a pause are skipped and consumed, **never queued** for 01:00 or 19:00.

### 9.2 Friday cutoff

No new entries at or after **Friday 23:00:00 Beirut**. The cutoff is rechecked
at the actual submission boundary. Unsent entry intentions are cancelled; sent
or uncertain requests are reconciled rather than assumed cancelled.

### 9.3 Friday liquidation

Begins at the **23:00 cutoff**, targeting broker-confirmed closure before
**23:30**, leaving half an hour of retry and reconciliation headroom.

Scope is **only this application's own M1 and M5 positions and pending
orders** — never the original M1 bot's, never the legacy deployment's, never
manual or foreign trades.

Cancel owned pending orders → close owned positions → reconcile partial closes,
uncertain responses and late fills → continue until broker-confirmed owned
exposure is zero. A submitted close request is not proof of closure.

If an outage, rejection or market closure prevents completion: keep entries
blocked, continue bounded reconciliation, raise a critical dashboard and
Telegram incident, and report the missed deadline and remaining exposure. A
false flat state is never reported.

On startup after the cutoff or during the weekend, remaining exposure is
reconciled without depending on a missed timer callback. Friday liquidation
takes precedence over new entries and routine restoration.

### 9.4 Weekend reopening

Entries stay disabled after the Friday cutoff until the broker session is
**confirmed** open, data is fresh and tradable, neither daily pause is active,
recovery is complete, and no risk, permission or maintenance block remains.

Reopening is never hardcoded to Sunday 00:00. While unknown, the state is
reported as **"awaiting confirmed broker reopening"**.

## 10. Observation architecture

One-second target observation cadence, with observation and submission latency
measured and reported **separately** — a one-second observation loop does not
imply a one-second order-polling loop.

Ticks are not RSI periods: the forming bar is recomputed from prior closed-bar
state on every tick, and committed exactly once when that timeframe's bar
completes. Replaying a tick is therefore idempotent and tick density has no
effect on the value.

Maintained: ordered broker timestamps, timestamp normalization applied exactly
once, duplicate and out-of-order handling, gap detection, freshness checks,
independent M1/M5 state, persisted signal evidence, and measured latency.

The **coherent quote contract** is preserved: bid, ask, timestamp, age and
source all describe the same selected observation. An explicit server
evaluation time is used for age and schedule checks. Immediately before each
entry submission attempt, including retries, a freshly fetched MT5 tick is
validated.

If only sampled quotes are available the mode is labelled **"sampled
intrabar"** with its missed-crossing limitation disclosed. Absence of an
observed crossing is never taken as proof that no crossing occurred.

Startup and reconnect warm the indicators without historical entries, establish
continuity, reconcile decisions and exposure, and preserve post-loss locks.
Persisted state is versioned by strategy, account and timeframe, and carries
the configuration hash, cursor, RSI state, crossing state, consumed identities
and recovery metadata.

## 11. Historical-data scope

**No backtests, no historical profitability evaluation, no parameter
optimization, no research comparisons.** No old strategy research is imported
as evidence for this strategy. No data from any research start date is
required.

Historical information is permitted only where operationally necessary:
sufficient recent bars to initialize and verify RSI; broker order and deal
history for ownership and reconciliation; broker-confirmed realized results for
loss locks and reporting; and existing audit evidence needed for recovery.

Indicator initialization produces no entry signals and no historical unlock
events. Synthetic unit tests and simulated-broker integration tests are
required and are not profitability research. Actual DEMO performance is
reported separately from every test fixture.

## 12. Dashboard

Independent from the existing bot's dashboard. Displays bot and strategy
identifier, running build and spec version, DEMO account identity and
verification freshness, MT5 execution permissions, indicator settings and
parity provenance, M1 and M5 RSI, observation timestamps/freshness/cadence,
entry thresholds (SELL 91, BUY 8.9), independent crossing and rearming states,
per-timeframe occupancy, last signals and evidence, execution/cancellation/skip
reasons, volume and protection distances, risk and reserved-risk state,
broker-confirmed positions with timeframe ownership, protection state and
confirmed closures, actual net realized P&L, separate M1/M5 performance,
collector and processing heartbeats, and gaps and observation limitations.

All four locks are shown with ACTIVE/INACTIVE, causing trade, net realized
loss, activation timestamp, current owning-timeframe RSI, required unlock
condition and last unlock event. The required wording is exactly:

- SELL — `Waiting for RSI <=25 OR RSI >=98.5.`
- BUY — `Waiting for RSI >=75 OR RSI <=1.5.`

**98.5 and 1.5 are never labelled as entry thresholds.** Old peak/trough/
retest/extreme state is never displayed as active behaviour.

Schedule states are shown distinctly: eligible (subject to candidate checks),
overnight pause, afternoon pause, Friday cutoff, Friday liquidation underway,
liquidation confirmed, deadline missed, weekend/session closure, other
execution blockers — together with the next known eligibility time and the
Friday deadline.

## 13. Telegram

V2-specific configuration and independent durable delivery records. Existing
recipients may be reused if explicitly configured, but the original bot's
routing is never modified.

Every trade-related message identifies **this bot, its account, and M1 or M5**.
Notifications cover signals, confirmed fills, skipped or cancelled entries
where relevant, rejected or uncertain submissions, protection incidents,
confirmed closures, outages and recoveries, loss-lock activation, loss-lock
removal, and Friday liquidation completion or failure.

Fills, closures and flat exposure are never reported from a request
acknowledgement alone. Loss-lock messages identify the affected timeframe and
direction, the realized result and the unlock conditions, and state that other
directions and timeframes are unaffected by that lock while remaining subject
to their own gates. Unlock messages are informational and never cause an entry.

Execution and notifications never depend on AI availability.

### 13.1 Automatic 24-hour performance report

Sent every 24 hours while the application and required infrastructure are
available, covering **M1 wins/losses, M5 wins/losses, and combined totals**,
and identifying the bot, account and reporting interval.

Sourced only from broker-confirmed, fully closed, strategy-owned positions
whose closure falls in the reporting interval. Classified by net realized
result: positive = win, negative = loss, **zero reported separately**,
unresolved reported separately until reconciled — for TP, SL, Friday,
remediation and user-authorized closures alike.

Partial-exit deals are aggregated into their owning position; multiple exit
deals are never counted as multiple completed positions. Open positions,
pending requests and foreign trades are excluded.

Reporting intervals are non-overlapping and persisted along with included
position identities and per-recipient delivery status, so neither a restart nor
a concurrent worker can duplicate a period. **Reporting or Telegram failure
never affects trading.**

## 14. Manual operation and activation

Startup stays **manual only**. No Windows startup tasks, reboot autostart or
unattended supervisors are installed without explicit authorization.

While running, the application continues observing and processing after wins,
losses, skips, rejections and recoverable errors, using bounded retries and
reconciling uncertain orders before attempting another submission. Monitoring
and application-driven liquidation require the host, processes and broker
connection to remain available.

Before activation: verify resource isolation; apply migrations only to this
application's database; confirm its separate DEMO account; confirm terminal
permissions; confirm unused magic numbers and ownership; confirm exactly one
execution instance; confirm old entry paths are disabled here; confirm M1/M5
state and occupancy isolation; confirm schedule and controls; and confirm the
runtime code matches the intended build.

**Execution stays OFF until those checks pass and activation is authorized.**
The existing M1 bot is never paused or cut over, and none of its positions
transfer here. No order is ever forced to demonstrate completion.

---

## Implementation assumptions

Recorded explicitly, because they are decisions the specification left to the
implementation rather than rules the user stated.

1. **Warm-up margin — 250 closed bars beyond the RSI seed, per timeframe.**
   Wilder's recursive average carries its seeding transient for many multiples
   of the period. A generous margin, not a tuned value; it delays first
   eligibility and can never create an entry.
2. **Continuity gap budget — one full bar plus 50% margin**, so 90 s on M1 and
   450 s on M5. Beyond it, that timeframe's crossing state resets rather than
   spanning an interval the engine did not observe.
3. **Friday liquidation starts at the 23:00 cutoff** rather than at 23:29, so
   there is half an hour of retry headroom before the 23:30 deadline.
4. **Weekend window outer bound — Friday 23:00 through Monday 00:00 Beirut.**
   This is not a claim about broker hours; it is the span in which the schedule
   refuses to assume availability and insists on positive confirmation. A
   broker reopening Sunday evening is tradable then, subject to both pauses.
5. **Skip-reason precedence** — post-loss lock, then occupancy, then schedule.
   Entries are blocked either way; this only fixes which reason is recorded,
   and the lock is reported first because it has the longest consequence.
6. **Ambiguous Beirut wall times** (autumn repeat) resolve to the first
   occurrence, so a pause boundary starts earlier and ends later in wall-clock
   terms — never shorter than the user asked for. A wall time that does not
   exist (spring gap) is skipped forward.
7. **Magic numbers 262610200 (M1) and 262610201 (M5)**, chosen clear of every
   number known to belong to another application on this broker, and asserted
   disjoint at startup.
