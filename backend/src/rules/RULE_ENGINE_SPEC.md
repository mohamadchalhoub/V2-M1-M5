# Rule Engine specification — Phase 4
> See `../../../PROJECT_STATUS.md` at the repo root for the authoritative build order, phase-numbering crosswalk, and current status of every component.

Status: **Implemented and verified against a real MT5 demo account (Phase 4 review). One concurrency
issue found during post-implementation review, fixed, and regression-tested — see the addendum at
the end of this document.**

This document is the complete design for the Rule Engine, written against the already-approved
Phase 0 architecture (`Trading-Behavior-Monitor-Plan.pdf`, Revision 1, §08/§09/§15), the completed
`ANALYTICS_SPEC.md` (Phase 3), the current Prisma schema, and the live `AnalyticsService`
(`analytics.service.ts`, `analytics.types.ts`). Nothing here reopens Phase 0's shape or Phase 3's
formulas. Where Phase 0 leaves a genuine gap, it's called out explicitly in §12 rather than filled
in silently.

**Constraints this design is built to satisfy (Phase 0 Req. 2, plus your instructions):**
The Rule Engine is the only component that decides whether a trading-behavior alert is triggered.
It is a pure function of `(rule_type, parameters, current_metrics, baseline)` — no AI call, no
Telegram call, no MT5/collector query, no trade-execution capability, anywhere in its path. It
consumes `AnalyticsService` output only; it never computes trading-day boundaries itself.

---

## 1. Rule model

Per Phase 0 §08 (Req. 5): a closed `rule_type` enum, a `parameters jsonb` column validated
per-type in code, no general expression-tree DSL. Compound rules are flat AND/OR over other
rules' already-computed lifecycle state — not a re-evaluated boolean tree.

```sql
CREATE TYPE rule_type_enum AS ENUM (
  'DAILY_LOSS_LIMIT', 'DRAWDOWN', 'CONSECUTIVE_LOSSES',
  'POSITION_SIZE_MULTIPLE', 'TRADE_FREQUENCY_MULTIPLE', 'COMPOUND'
);
```

Each `parameters` shape is validated against a per-type schema **at rule-creation/update time**
(rejecting a malformed rule immediately), using `class-validator`/`class-transformer` — the same
pattern already used for `SnapshotDto`/`TradesPushDto` in `collector-ingress/dto/`, not a new
validation library. One DTO class per `rule_type`, selected by a discriminator, e.g.:

```ts
// rules/dto/rule-parameters.dto.ts
export class DailyLossLimitParams {
  @IsNumber() @Min(0) @Max(1) threshold_pct!: number;
}
export class DrawdownParams {
  @IsNumber() @Min(0) @Max(1) threshold_pct!: number;
}
export class ConsecutiveLossesParams {
  @IsInt() @Min(1) count!: number;
}
export class PositionSizeMultipleParams {
  @IsNumber() @Min(0) factor!: number;
  @IsIn(['avg', 'max']) baseline!: 'avg' | 'max';
}
export class TradeFrequencyMultipleParams {
  @IsNumber() @Min(0) factor!: number;
  @IsInt() @Min(1) window_minutes!: number;
}
export class CompoundParams {
  @IsIn(['AND', 'OR']) combinator!: 'AND' | 'OR';
  @IsArray() @ArrayMinSize(2) @IsUUID('4', { each: true }) component_rule_ids!: string[];
}
```

`threshold_pct` is a **fraction (0–1)**, not a percentage (0–100) — this matches the convention
`ANALYTICS_SPEC.md` §2.1 already committed `AccountSessionMetrics.drawdown` to ("`0.038` for
3.8%"), applied consistently to `DAILY_LOSS_LIMIT` as well so both threshold-style rules share one
convention.

A `COMPOUND` rule's `component_rule_ids` must resolve to existing, non-`COMPOUND` rules
(enforced at validation time — this is what keeps nesting flat, per Phase 0 §08: *"flat — one
level, no nesting"*) and must contain at least 2 ids (a 1-component "compound" is meaningless).

---

## 2. Initial rule set

Reproduced from Phase 0 §08's table verbatim (meaning, parameter shape) plus the worked
compound example already given (§08 Req. 5's example, instantiated with the "bad session" numbers
from §23: *"0.50 lots after four losses at 3.8% drawdown"*).

### 2.1 `DAILY_LOSS_LIMIT`

| | |
|---|---|
| **Purpose** | Alert when the current trading day's loss reaches a configured fraction of the day's starting balance. |
| **Required metrics** | `current.account.dailyLoss`, `current.account.startingBalance` (`AccountSessionMetrics`, both already trading-day-boundary-aware per `ANALYTICS_SPEC.md` §2.1/§1) |
| **Parameters** | `{ threshold_pct: number }` (fraction, `0 < threshold_pct < 1`) |
| **Comparison** | `dailyLoss / startingBalance >= threshold_pct` |
| **Units** | `threshold_pct` fraction; `dailyLoss`/`startingBalance` in account currency |
| **Edge cases** | `startingBalance` null or `<= 0` → `INSUFFICIENT_DATA` (no anchor snapshot for today, or a broken account). `dailyLoss` null → `INSUFFICIENT_DATA` (propagated from `dailyPl` per `ANALYTICS_SPEC.md`). `dailyLoss === 0` (no loss today, or the day is currently profitable) → `NOT_TRIGGERED`, never insufficient — `0` is a known answer. |
| **Example** | `threshold_pct = 0.05`, `startingBalance = 10000`, `dailyLoss = 520` → `0.052 >= 0.05` → **TRIGGERED** |
| **Non-trigger** | Same params, `dailyLoss = 480` → `0.048 >= 0.05` → **NOT_TRIGGERED** |

### 2.2 `DRAWDOWN`

| | |
|---|---|
| **Purpose** | Alert when current equity drawdown from the account's all-time peak equity reaches a threshold. |
| **Required metrics** | `current.account.drawdown` (`AccountSessionMetrics`, already a 0–1 fraction) |
| **Parameters** | `{ threshold_pct: number }` (fraction) |
| **Comparison** | `drawdown >= threshold_pct` |
| **Units** | Both sides are 0–1 fractions |
| **Edge cases** | `drawdown` null (account has no snapshots yet) → `INSUFFICIENT_DATA`. `drawdown === 0` (currently at the all-time peak) → `NOT_TRIGGERED`. |
| **Example** | `threshold_pct = 0.03`, `drawdown = 0.038` → **TRIGGERED** (this is the "bad session" fixture value) |
| **Non-trigger** | `threshold_pct = 0.03`, `drawdown = 0.021` → **NOT_TRIGGERED** |

### 2.3 `CONSECUTIVE_LOSSES`

| | |
|---|---|
| **Purpose** | Alert when the current losing streak reaches a configured length. |
| **Required metrics** | `current.sequences.currentConsecutiveLosses` (`BehavioralSequenceMetrics`) |
| **Parameters** | `{ count: number }` (positive integer) |
| **Comparison** | `currentConsecutiveLosses >= count` |
| **Units** | Integer count of consecutive losing closing deals |
| **Edge cases** | `currentConsecutiveLosses` is **never** null (`ANALYTICS_SPEC.md` §2.5: `0` for a zero-trade account) — this rule never returns `INSUFFICIENT_DATA` on its own; a brand-new account correctly evaluates to `NOT_TRIGGERED` (`0 >= count` is false for any valid `count >= 1`). A breakeven trade breaks the streak (per `ANALYTICS_SPEC.md` §2.5), which this rule inherits for free. |
| **Example** | `count = 4`, `currentConsecutiveLosses = 4` → **TRIGGERED** (the "bad session" fixture) |
| **Non-trigger** | `count = 4`, `currentConsecutiveLosses = 3` → **NOT_TRIGGERED** |

### 2.4 `POSITION_SIZE_MULTIPLE`

| | |
|---|---|
| **Purpose** | Alert when an open position is unusually large relative to the trader's own historical sizing. |
| **Required metrics** | `current.position.maximumPositionVolume` (`PositionBehaviorMetrics`, live); baseline: `historicalBaselines.averagePositionVolume` **or** `historicalBaselines.maximumNormalPositionVolume`, selected by `parameters.baseline` |
| **Parameters** | `{ factor: number, baseline: 'avg' \| 'max' }` |
| **Comparison** | `maximumPositionVolume >= factor * baselineValue`, where `baselineValue = baseline === 'avg' ? averagePositionVolume : maximumNormalPositionVolume` |
| **Units** | Lots (same unit as `positions.volume`/`trades.volume` in the schema) |
| **Edge cases** | No open positions → `maximumPositionVolume` is `null` → **`NOT_TRIGGERED`**, not insufficient (see §8 rationale: "nothing open" is a known state, not missing data). `baselineValue` null (brand-new account, empty 90-day window) → `INSUFFICIENT_DATA`. `baselineValue === 0` (never opened a position of any size in the window — theoretically possible on a very new/idle account) → `INSUFFICIENT_DATA`, not a trivially-satisfied `>= 0` (see §8). |
| **Example** | `factor = 2`, `baseline = 'avg'`, `averagePositionVolume = 0.20`, `maximumPositionVolume = 0.50` → `0.50 >= 0.40` → **TRIGGERED** (the "bad session" fixture's 0.50-lot position, illustrative baseline) |
| **Non-trigger** | Same params, `maximumPositionVolume = 0.35` → `0.35 >= 0.40` → **NOT_TRIGGERED** |

### 2.5 `TRADE_FREQUENCY_MULTIPLE`

| | |
|---|---|
| **Purpose** | Alert when trading frequency over a trailing window spikes relative to the trader's own historical average for a same-length window (overtrading / revenge-trading pattern). |
| **Required metrics** | Current: count of closing deals in the trailing `window_minutes`. Baseline: the historical average count of closing deals over a window of that same length. **Neither of these exists in `AnalyticsService` today** — see §12, this requires a small additive extension. |
| **Parameters** | `{ factor: number, window_minutes: number }` (`window_minutes` positive integer) |
| **Comparison** | `tradesInWindow(window_minutes) >= factor * averageTradesPerWindow(window_minutes)` |
| **Units** | Integer trade counts; `window_minutes` in minutes |
| **Edge cases** | `windowCompleteDays === 0` (brand-new account) → baseline `null` → `INSUFFICIENT_DATA`. Baseline average `=== 0` → `INSUFFICIENT_DATA` (same degenerate-multiply-by-zero rationale as §2.4 — otherwise any single trade would trigger). `tradesInWindow === 0` with a valid nonzero baseline → **`NOT_TRIGGERED`**. |
| **Example** | `factor = 3`, `window_minutes = 60`, `averageTradesPerHour = 1.5`, trades in the last 60 minutes = 6 → `6 >= 4.5` → **TRIGGERED** |
| **Non-trigger** | Same params, trades in last 60 minutes = 4 → `4 >= 4.5` → **NOT_TRIGGERED** |

### 2.6 `COMPOUND` (Phase 0 §08's worked example)

| | |
|---|---|
| **Purpose** | Combine other rules' current lifecycle state with flat AND/OR — no raw-metric re-evaluation. |
| **Required inputs** | The persisted `rule_state.state` (`ACTIVE`/`INACTIVE`, see §4) of every `component_rule_ids` entry, **for the same account**, freshly evaluated earlier in the same pass (see §3 ordering) |
| **Parameters** | `{ combinator: 'AND' \| 'OR', component_rule_ids: uuid[] }` |
| **Comparison** | `AND`: every component's `rule_state.state === 'ACTIVE'`. `OR`: at least one component's `rule_state.state === 'ACTIVE'`. |
| **Edge cases** | A disabled component is forced to `INACTIVE` the moment it's disabled (§4) so a stale `ACTIVE` reading can never leak into a compound. A component whose own evaluation this tick was `INSUFFICIENT_DATA` simply leaves its `rule_state.state` unchanged (§8) — the compound sees whatever that component's state already was, no special-casing needed. |
| **Worked example (Phase 0's own — "unusual size AND loss streak AND drawdown")** | A `"Risk escalation"` compound rule: `combinator = 'AND'`, components = [the §2.4 `POSITION_SIZE_MULTIPLE` rule, the §2.3 `CONSECUTIVE_LOSSES` rule, the §2.2 `DRAWDOWN` rule]. Against the "bad session" fixture (0.50 lots, four losses, 3.8% drawdown) all three components are `ACTIVE` → compound **TRIGGERED**. |
| **Non-trigger** | Same three components, but the losing streak is only 2 (its rule `INACTIVE`) → AND compound **NOT_TRIGGERED** even though the other two are `ACTIVE`. |
| **OR example** | A `"Loss event"` compound: `combinator = 'OR'`, components = [`DAILY_LOSS_LIMIT`, `DRAWDOWN`]. Either one alone being `ACTIVE` → compound **TRIGGERED**. |

---

## 3. Rule evaluation

```
AnalyticsService.getCurrentMetrics(accountId, now)
AnalyticsService.getHistoricalBaselines(accountId, { now })
        ↓
RuleEngineService.evaluateAccount(accountId, now)
        ↓  (for each enabled, non-COMPOUND rule, then each enabled COMPOUND rule)
RuleEvaluator.evaluate(ruleType, parameters, currentMetrics, baseline, componentStates?)
        ↓
RuleEvaluationResult { status: TRIGGERED | NOT_TRIGGERED | INSUFFICIENT_DATA, ... }
        ↓
AlertLifecycleService.apply(result)  →  rule_state transition, Alert row if applicable
```

- `RuleEngineService.evaluateAccount` calls `AnalyticsService` **exactly once per account per
  pass** (one `getCurrentMetrics` + one `getHistoricalBaselines` call), then evaluates every
  enabled rule for that account against that single snapshot of metrics — never a per-rule
  analytics query, and never a metric recomputed mid-pass.
- **Evaluation order within a pass:** all non-`COMPOUND` rules first, each one's `rule_state`
  persisted immediately after evaluation; `COMPOUND` rules evaluated last, reading their
  components' just-updated `rule_state.state`. This makes `COMPOUND` correct without needing a
  second analytics fetch or a stale-state read. (If two `COMPOUND` rules reference each other's
  results, that's rejected at creation time per §1 — components must be non-`COMPOUND`.)
- `RuleEvaluator.evaluate(...)` is the pure function from Phase 0 §08's "Req. 2 — enforced by
  construction" box: synchronous, no I/O, no `Promise`, unit-testable with plain fixture objects.
  It never touches Prisma, `AnalyticsService`, MT5, the collector, AI, or Telegram.
- `RuleEngineService` (the orchestrator) is the only thing with database access in this module —
  it loads `rule_definitions`, calls `AnalyticsService`, calls the pure evaluator, and hands the
  result to `AlertLifecycleService`.
- **Trigger point (open decision, flagged in §12):** what calls `evaluateAccount` on a schedule.
  Phase 4 does not require Redis/BullMQ for this — see §12 for the two lightweight options.

---

## 4. Rule state

Per Phase 0 §09: *"Same state machine... one `rule_state` row per (rule_id, account_id)"*, with
four conceptual states — `Inactive → Active → Cooldown → Resolved` — and these transitions:

```
Inactive --[condition true]--------------------------------> Active   (create alert, snapshot, notify)
Active   --[notification sent]---------------------------------> Cooldown
Cooldown --[condition still true, within cooldown]------------> Cooldown   (no new alert)
Cooldown --[cooldown elapsed AND condition still true]---------> Active    (re-notify)
Active/Cooldown --[condition false]----------------------------> Resolved
Resolved --[condition true]-------------------------------------> Active   (new cycle)
```

**Persisted representation (recommended — see §12 for the literal-4-state alternative):** the
four conceptual states collapse to two persisted values plus a cooldown timestamp, with identical
externally-observable behavior and a smaller state space to test:

```
rule_state.state:          ACTIVE | INACTIVE
rule_state.cooldown_until: timestamptz | null
```

Mapping: `Inactive` and `Resolved` are both represented as `state = INACTIVE` (they are
behaviorally identical going forward — both simply mean "not currently alerting," matching the
same pattern the schema already uses for `health_incidents`, which tracks `status_from`/
`status_to`/`resolved_at` rather than a fifth enum value). `Active` and `Cooldown` are both
represented as `state = ACTIVE` — the diagram's `Cooldown` is "still `Active`, but
`cooldown_until` is in the future"; the diagram's momentary `Active` (the instant an alert fires,
before "notification sent") collapses into the same write, because Phase 4 has no async
notification step yet (§11) — creating the `Alert` row **is** the recordable event for this phase,
so the state write and the "notification sent" transition happen atomically in one write.

**Transition logic** (this **is** the answer to "does a new alert row get created," §5/§6):

| Current `rule_state` | This tick's evaluation | Action |
|---|---|---|
| `INACTIVE` (or no row yet) | `NOT_TRIGGERED` | No-op |
| `INACTIVE` | `INSUFFICIENT_DATA` | No-op (§8) |
| `INACTIVE` | `TRIGGERED` | Create `Alert` row (§6). `state = ACTIVE`, `cooldown_until = now + cooldownSeconds`, `last_triggered_at = now`. |
| `ACTIVE`, `cooldown_until > now` | `TRIGGERED` | No-op — condition remains true, still within cooldown. **No new alert.** |
| `ACTIVE`, `cooldown_until <= now` | `TRIGGERED` | Create a **new** `Alert` row (re-notify). `cooldown_until = now + cooldownSeconds`. `state` stays `ACTIVE`; `last_triggered_at` unchanged (it marks the start of the current continuous-true streak, not the last notification — `resolved_at` below tells you when it ended). |
| `ACTIVE` (any `cooldown_until`) | `NOT_TRIGGERED` | `state = INACTIVE`, `cooldown_until = null`, `resolved_at = now`. This is the diagram's "Resolved." |
| `ACTIVE` | `INSUFFICIENT_DATA` | **No-op — state is left exactly as-is.** A transient data gap must never silently resolve a genuinely active alert (§8). |

Re-running the evaluator with unchanged inputs is idempotent by construction: the transition table
is a pure function of `(current rule_state, this tick's status)`, so re-evaluating the same tick
twice (e.g. a retried job) lands on the identical `rule_state` row without a second write having
any additional effect beyond the first, and — critically — never creates a second `Alert` row for
the same continuous-true streak within one cooldown window. Restart-safety follows directly: all
of `state`, `cooldown_until`, and `last_triggered_at` live in Postgres, so a process restart loses
no in-memory timer and cannot cause a spurious re-notify or a missed resolve.

**Disabling a rule** (`enabled: false` via CRUD) is defined to reset its `rule_state` to
`{ state: INACTIVE, cooldown_until: null, resolved_at: now }` as part of the same operation — this
exists specifically so a disabled rule can never leave a stale `ACTIVE` reading for a `COMPOUND`
rule that references it (§2.6).

---

## 5. Cooldown and deduplication

Directly answered by the transition table in §4. Working through your example:

```
Rule: POSITION_SIZE_MULTIPLE, factor 2× baseline
Condition becomes true at t=0, remains true continuously until t=70min
cooldownSeconds = 1800 (30 min) — RULE_DEFAULT_COOLDOWN_SECONDS
```

| Time | `rule_state` before | Evaluation | Action |
|---|---|---|---|
| t=0 | `INACTIVE` | `TRIGGERED` | **Alert #1** created. `state=ACTIVE`, `cooldown_until=t30`. |
| t=0–30 | `ACTIVE`, `cooldown_until=t30` | `TRIGGERED` each tick | No-op — deduplicated. |
| t=30 | `ACTIVE`, `cooldown_until=t30` (elapsed) | `TRIGGERED` | **Alert #2** created (re-notify). `cooldown_until=t60`. |
| t=30–60 | `ACTIVE`, `cooldown_until=t60` | `TRIGGERED` each tick | No-op. |
| t=60 | `ACTIVE`, `cooldown_until=t60` (elapsed) | `TRIGGERED` | **Alert #3** created. `cooldown_until=t90`. |
| t=70 | `ACTIVE`, `cooldown_until=t90` | `NOT_TRIGGERED` (condition cleared) | `state=INACTIVE`, `resolved_at=t70`. |

**Result: three alerts** over the 70-minute episode (one at trigger, one at each 30-minute cooldown
boundary while still true), not one alert total and not one per evaluation tick. This is the
literal reading of Phase 0's own diagram (*"cooldown elapsed AND condition still true → re-notify"*)
— chosen over "one alert until recovery" specifically because Phase 0 draws a `Cooldown → Active`
edge that only makes sense if re-notification actually happens there. If the condition had cleared
at t=15 instead, exactly **one** alert would have fired (no re-notify, since cooldown never
elapsed while true), then a fresh trigger later starts a brand new streak with its own Alert #1.

Deduplication and cooldown state both live in the single `rule_state` row per (rule_id,
account_id) in Postgres — no in-memory timers, no separate dedup cache, survives a process
restart by construction (§4).

---

## 6. Trigger-time snapshots

Per Phase 0 §09 (Req. 9), captured on every `Alert` row creation (every `INACTIVE→ACTIVE` and every
re-notify in §5's table — i.e. on every row of that table that says "Alert created"):

- **`trigger_values`** — the exact current-side numbers `RuleEvaluationResult.triggerValues` used
  in the comparison (e.g. `{ maximumPositionVolume: 0.50 }`).
- **`baseline_snapshot`** — the exact baseline-side numbers `RuleEvaluationResult.baselineValues`
  used (e.g. `{ averagePositionVolume: 0.20, windowDays: 90, windowStart: ..., windowEnd: ... }`);
  `{}` for rule types with no baseline dependency (`DAILY_LOSS_LIMIT`, `DRAWDOWN`,
  `CONSECUTIVE_LOSSES`, `COMPOUND`).
- **`rule_snapshot`** — a full, denormalized copy of the `rule_definitions` row at that instant
  (`id`, `name`, `ruleType`, `parameters`, `cooldownSeconds`, `enabled`), taken by value into the
  JSON column, not a foreign-key-only reference.

Because all three are plain JSON copies written once at `Alert` creation, a later edit to the live
`rule_definitions.parameters` or a later shift in the 90-day rolling baseline can never retroactively
change what an old alert says happened — reading an alert from six months ago never requires
reconstructing historical state via a `rule_definition_history` join, exactly as Phase 0 specifies.

---

## 7. Timezone behavior

The Rule Engine performs **zero** timezone or trading-day-boundary computation. Every `now` it
uses is the single `Date` passed into `RuleEngineService.evaluateAccount(accountId, now)`, which
is threaded through unchanged into `AnalyticsService.getCurrentMetrics(accountId, now)` and
`AnalyticsService.getHistoricalBaselines(accountId, { now })`. `DAILY_LOSS_LIMIT`'s "trading-day
loss" already reflects the account's `trading_day_timezone`/`trading_day_reset_hour` because
`AccountSessionMetrics.dailyLoss` does (`ANALYTICS_SPEC.md` §1/§2.1) — the rule engine simply reads
the number. No `trading-day.ts` logic is duplicated anywhere in `rules/`.

---

## 8. Missing / insufficient data

**General principle, inherited directly from `ANALYTICS_SPEC.md`'s own null-vs-zero convention:**
a metric that is `null` means *undefined/unknown*; a metric that is `0` (or a computed fraction
like `0` drawdown) means *known, and the known answer happens to be zero*. The Rule Engine adds
exactly one rule on top of that: **a `null` input to a comparison always yields `INSUFFICIENT_DATA`
for that rule, never `false`.** A rule must never report `NOT_TRIGGERED` merely because a number
it needed was unavailable — `INSUFFICIENT_DATA` is a third, distinct status precisely so the
difference between "we checked, it's fine" and "we couldn't check" is never lost.

| Scenario | Status |
|---|---|
| No historical baseline at all (brand-new account, `windowCompleteDays === 0`) | `INSUFFICIENT_DATA` for any rule reading a baseline field (`POSITION_SIZE_MULTIPLE`, `TRADE_FREQUENCY_MULTIPLE`) |
| Baseline value present but exactly `0` (e.g. `averagePositionVolume = 0`) | `INSUFFICIENT_DATA` — multiplying a factor by zero makes the threshold trivially `0`, which would make any nonzero activity spuriously trigger; treated as "not enough signal to compute a meaningful multiple," not as a satisfied comparison |
| A required current metric is `null` (`dailyLoss`, `drawdown`, `startingBalance`) | `INSUFFICIENT_DATA` |
| No open positions (`maximumPositionVolume === null`) | **`NOT_TRIGGERED`** — deliberate exception: "nothing is open" is a known state (there is verifiably no oversized position right now), not an unknown one, so it reads the same as "known and boring," not "couldn't tell" |
| Zero trades ever (`currentConsecutiveLosses === 0`, `totalTrades === 0`) | Evaluated normally — these fields are never `null` (`ANALYTICS_SPEC.md` §0 "Null vs. zero"); `0 >= count` for `count >= 1` is a legitimate `NOT_TRIGGERED` |
| Account just created, no snapshots yet | `INSUFFICIENT_DATA` for `DRAWDOWN`/`DAILY_LOSS_LIMIT` (their current-side inputs are `null`); `NOT_TRIGGERED` for `CONSECUTIVE_LOSSES` (no trades → `0`) |
| Insufficient history for a rule's specific window (e.g. account is 10 days old, baseline window is 90 days) | Not a special case — `HistoricalBaselines` already answers this correctly per `ANALYTICS_SPEC.md` §3 (the window clips to what actually exists; only a *fully empty* window returns `null`) |
| A `COMPOUND` rule where a component's own tick was `INSUFFICIENT_DATA` | No special case needed — the component's `rule_state.state` simply doesn't change this tick (§4), and the compound reads whatever that state already was |

`RuleEvaluationResult.status = INSUFFICIENT_DATA` never triggers §4's `INACTIVE→ACTIVE` or
`ACTIVE`'s re-notify transitions, and — as established in §4 — never resolves an already-`ACTIVE`
alert either. It is a true no-op tick.

---

## 9. Rule evaluation output

```ts
// rules/types/rule-engine.types.ts
export enum RuleEvaluationStatus {
  TRIGGERED = 'TRIGGERED',
  NOT_TRIGGERED = 'NOT_TRIGGERED',
  INSUFFICIENT_DATA = 'INSUFFICIENT_DATA',
}

export interface RuleEvaluationResult {
  ruleId: string;
  accountId: string;
  ruleType: RuleType;
  evaluatedAt: Date;                                   // the `now` passed into this pass
  status: RuleEvaluationStatus;
  reasonCode: string;                                  // e.g. 'DRAWDOWN_ABOVE_THRESHOLD',
                                                         // 'BASELINE_WINDOW_EMPTY',
                                                         // 'NO_OPEN_POSITIONS',
                                                         // 'COMPONENT_NOT_ACTIVE'
  triggerValues: Record<string, unknown>;               // plain JSON-serializable data — scalars or
  baselineValues: Record<string, unknown>;               // nested records (e.g. COMPOUND's per-component map)
  parameters: Record<string, unknown>;                 // this rule's parameters at evaluation time
}
```

*(Implementation note: the original draft above typed these two fields as flat
`Record<string, number | string | boolean | null>` — widened to `Record<string, unknown>` once the
`COMPOUND` evaluator needed to nest a per-component state map inside `triggerValues`. Everything
else about §9 is unchanged.)*

`reasonCode` is a fixed, enumerable string per evaluator (not free text) — it exists so a future
consumer (the dashboard, or Phase 6's AI narrator reading `trigger_values`/`baseline_snapshot`
later) can distinguish *why* without re-deriving it from raw numbers. Deliberately **absent**, per
your instructions: any AI-generated text, any `recommendation`/`action`/`suggested_next_step`
field — this type only ever describes what was computed and compared, never what to do about it.

---

## 10. Test matrix

All tests run against fixture inputs (`CurrentMetrics`/`HistoricalBaselines`-shaped plain objects,
same style as `test/analytics/fixtures/*.json`) — **no live MT5, no real Postgres required for the
pure-evaluator tests**; the state-machine/persistence tests reuse the existing `test/helpers/db.ts`
+ `docker-compose.test.yml` pattern already proven in Phase 2/3's suite.

### 10.1 Per rule type (`DAILY_LOSS_LIMIT`, `DRAWDOWN`, `CONSECUTIVE_LOSSES`,
`POSITION_SIZE_MULTIPLE`, `TRADE_FREQUENCY_MULTIPLE`) — same matrix shape for each:

| Case | Expectation |
|---|---|
| Normal condition, well below threshold | `NOT_TRIGGERED` |
| Exactly at threshold (`==`) | `TRIGGERED` (comparison is `>=`, inclusive) |
| Just below threshold (smallest representable step) | `NOT_TRIGGERED` |
| Just above threshold | `TRIGGERED` |
| Required current metric is `null` | `INSUFFICIENT_DATA` |
| Required baseline metric is `null` (new account / empty window) | `INSUFFICIENT_DATA` |
| Baseline metric is exactly `0` (`*_MULTIPLE` rules only) | `INSUFFICIENT_DATA` |
| Repeated evaluation, condition unchanged | Same `status` both times; **no new `Alert` row** on the second call once `rule_state` is already `ACTIVE` and within cooldown |
| Condition remains `TRIGGERED` across a full cooldown boundary | Exactly one additional `Alert` row at the boundary (§5) |
| Condition becomes `NOT_TRIGGERED` after being `ACTIVE` | `rule_state → INACTIVE`, `resolved_at` set, no `Alert` row |
| Condition becomes `TRIGGERED` again after resolving | New `Alert` row, fresh `last_triggered_at`, independent of the previous episode's cooldown clock |
| Cooldown behavior with a custom (non-default) `cooldownSeconds` | Re-notify timing matches the configured value, not `RULE_DEFAULT_COOLDOWN_SECONDS` |
| Restart simulation (reload `rule_state` from DB mid-episode, evaluate again) | Identical transition to the non-restarted case — no duplicate `Alert`, no lost cooldown |

### 10.2 `COMPOUND`

| Case | Expectation |
|---|---|
| AND, all components `ACTIVE` | `TRIGGERED` |
| AND, one component `INACTIVE` | `NOT_TRIGGERED` |
| OR, one component `ACTIVE` | `TRIGGERED` |
| OR, all components `INACTIVE` | `NOT_TRIGGERED` |
| A component is disabled mid-episode while previously `ACTIVE` | Component forced to `INACTIVE` (§4); dependent AND compound immediately stops being satisfiable |
| Full three-rule worked example (§2.6) against the "bad session" fixture | All three components `ACTIVE` → compound `TRIGGERED`; matches `expected_alerts` in the fixture file per §23's schema |

### 10.3 Cross-cutting

| Case | Expectation |
|---|---|
| Account isolation | Rule evaluation and `rule_state`/`Alert` rows for account A never read or are affected by account B's metrics or state, even for the *same* `rule_definitions` row evaluated against both accounts in the same pass |
| Rule parameter validation — valid payload per type | Rule saved |
| Rule parameter validation — invalid payload (wrong type, out-of-range, missing field) per type | Rejected at creation/update time (HTTP 400-equivalent), never persisted, never reaches the evaluator |
| Disabled rule | Never evaluated (skipped entirely by `RuleEngineService`); does not appear in any `RuleEvaluationResult` list for that pass |
| Multiple rules triggering simultaneously for one account | Each produces its own independent `Alert` row in the same pass; no cross-rule interference (verifies the "one `AnalyticsService` call, many evaluators" design in §3 doesn't leak state between evaluators) |
| Two accounts, same `rule_definitions` row, opposite outcomes in the same pass | Confirms `rule_state` truly keys on `(rule_id, account_id)`, not `rule_id` alone |
| `COMPOUND` referencing a nonexistent or `COMPOUND`-typed `component_rule_ids` entry | Rejected at creation time, per §1 |

Also required (per §23's existing fixture format, extended rather than replaced): the two
canonical fixtures already named in Phase 0 — a "good session" (asserts nothing over-fires) and
the "bad session" (asserts the compound and its three components all fire) — gain an
`expected_alerts: [{ rule_type, should_trigger }]` block exactly as shown in the plan, now
actually exercised by this module's tests instead of only documented as a target shape.

---

## 11. No AI / Telegram / Redis-BullMQ yet

Confirmed against the design above: nothing in `rules/` or `alerts/` imports an AI provider,
Telegram client, or `bullmq`. `RuleEngineService` and `AlertLifecycleService` depend only on
`PrismaService` and `AnalyticsService`. Phase 4 ends at a materialized `alerts` table — a
deterministic record of what happened and why — exactly per your instruction:

```
PostgreSQL → Analytics → RuleEngine → deterministic alert events
```

The one thing this phase needs a minimal, non-AI, non-Telegram answer for is *what calls
`evaluateAccount` on a schedule* — see §12, "Trigger point," for the two options, neither of which
requires Redis/BullMQ.

---

## 12. Definition of Done

### 12.1 Rule type inventory
Six `rule_type_enum` values: `DAILY_LOSS_LIMIT`, `DRAWDOWN`, `CONSECUTIVE_LOSSES`,
`POSITION_SIZE_MULTIPLE`, `TRADE_FREQUENCY_MULTIPLE` (five leaf types, exactly Phase 0's set) plus
`COMPOUND`. Full spec in §2.

### 12.2 Parameter schemas
`class-validator` DTO per type, §1. No generic/arbitrary-shape `parameters` column — validated at
write time.

### 12.3 Evaluation semantics
Pure function `(ruleType, parameters, currentMetrics, baseline, componentStates?) →
RuleEvaluationResult`, no I/O, per rule type table in §2, orchestrated per §3.

### 12.4 State machine
Two persisted values (`ACTIVE`/`INACTIVE`) + `cooldown_until` timestamp, behaviorally equivalent
to Phase 0's four-state diagram; full transition table in §4.

### 12.5 Cooldown/deduplication
Per-rule `cooldownSeconds` (defaults to `RULE_DEFAULT_COOLDOWN_SECONDS`), persisted
`cooldown_until` on `rule_state`, re-notify-after-cooldown-while-still-true confirmed as the
correct reading of Phase 0's diagram; worked example in §5.

### 12.6 Trigger-time snapshot design
`trigger_values` / `baseline_snapshot` / `rule_snapshot`, all JSON copies taken at `Alert`
creation, immutable thereafter. §6.

### 12.7 Missing-data behavior
`INSUFFICIENT_DATA` as a first-class third status, full scenario table in §8.

### 12.8 Compound-rule behavior
Flat AND/OR over components' persisted `rule_state.state`, evaluated after all leaf rules in the
same pass, §2.6/§3.

### 12.9 Test matrix
§10, in full.

### 12.10 Files/modules to be created

```
backend/prisma/schema.prisma                          (edited — see 12.11)
backend/prisma/migrations/<timestamp>_rule_engine/     (new migration)

backend/src/rules/
  rules.module.ts
  rule-definitions.service.ts        # CRUD + per-type parameter validation
  rule-engine.service.ts             # orchestrator: §3
  evaluators/
    daily-loss-limit.evaluator.ts
    drawdown.evaluator.ts
    consecutive-losses.evaluator.ts
    position-size-multiple.evaluator.ts
    trade-frequency-multiple.evaluator.ts
    compound.evaluator.ts
    index.ts                         # registry keyed by rule_type
  dto/
    rule-parameters.dto.ts           # §1
    create-rule.dto.ts / update-rule.dto.ts
  types/
    rule-engine.types.ts             # §9
  RULE_ENGINE_SPEC.md                # this document

backend/src/alerts/
  alerts.module.ts
  alert-lifecycle.service.ts         # §4 transition table + Alert row creation
  alerts.service.ts                  # Alert CRUD/read
  types/alert.types.ts

backend/src/analytics/
  metrics/frequency.metrics.ts       # EDITED — add tradesInTrailingWindow(), additive (12.12)
  baselines/baselines.ts             # EDITED — add averageTradesPerWindow(), additive (12.12)
  analytics.service.ts               # EDITED — expose the two new methods
  analytics.types.ts                 # EDITED — new return types for the two new methods only;
                                      #   CurrentMetrics/HistoricalBaselines shapes untouched

backend/test/rules/                  # mirrors test/analytics/ structure
  evaluators/*.spec.ts               # one file per rule type, §10.1
  compound.spec.ts                   # §10.2
  lifecycle.spec.ts                  # §4/§5, restart-simulation cases
  fixtures/*.json                    # extends the two canonical fixtures with expected_alerts
```

### 12.11 Schema migrations required

```prisma
enum RuleType {
  DAILY_LOSS_LIMIT
  DRAWDOWN
  CONSECUTIVE_LOSSES
  POSITION_SIZE_MULTIPLE
  TRADE_FREQUENCY_MULTIPLE
  COMPOUND
}

enum RuleRunState {
  INACTIVE
  ACTIVE
}

model RuleDefinition {
  id              String   @id @default(uuid())
  name            String
  ruleType        RuleType @map("rule_type")
  parameters      Json
  enabled         Boolean  @default(true)
  cooldownSeconds Int?     @map("cooldown_seconds")   // null = use RULE_DEFAULT_COOLDOWN_SECONDS
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  states RuleState[]
  alerts Alert[]

  @@map("rule_definitions")
}

model RuleState {
  ruleId          String        @map("rule_id")
  accountId       String        @map("account_id")
  state           RuleRunState  @default(INACTIVE)
  cooldownUntil   DateTime?     @map("cooldown_until")
  lastTriggeredAt DateTime?     @map("last_triggered_at")
  resolvedAt      DateTime?     @map("resolved_at")
  updatedAt       DateTime      @updatedAt @map("updated_at")

  rule    RuleDefinition @relation(fields: [ruleId], references: [id], onDelete: Cascade)
  account TradingAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)

  @@id([ruleId, accountId])
  @@map("rule_states")
}

model Alert {
  id               String   @id @default(uuid())
  ruleId           String   @map("rule_id")
  accountId        String   @map("account_id")
  triggeredAt      DateTime @default(now()) @map("triggered_at")
  triggerValues    Json     @map("trigger_values")
  baselineSnapshot Json     @map("baseline_snapshot")
  ruleSnapshot     Json     @map("rule_snapshot")

  rule    RuleDefinition @relation(fields: [ruleId], references: [id], onDelete: Cascade)
  account TradingAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)

  @@index([accountId, triggeredAt(sort: Desc)])
  @@map("alerts")
}
```

Plus the corresponding back-relations added to `TradingAccount` (`ruleStates RuleState[]`,
`alerts Alert[]`) and a new `.env`/`.env.example` key:

```
RULE_DEFAULT_COOLDOWN_SECONDS=1800
```

No changes to any existing table (`trading_accounts`, `account_snapshots`, `positions`, `trades`,
`sync_cursors`, `collector_heartbeats`, `api_credentials`).

### 12.12 Assumptions and unresolved decisions — need your call before implementation

1. **Rules are account-agnostic templates, not account-scoped rows.** Phase 0 emphasizes *"one
   `rule_state` row per (rule_id, account_id)"* — a phrasing that only needs stating if one
   `rule_definitions` row can apply to more than one account. I've modeled it that way: no
   `account_id` on `RuleDefinition`, every enabled rule evaluated against every active
   `TradingAccount`, per-account tracking living entirely in `RuleState`/`Alert`. **Alternative:**
   `RuleDefinition.accountId` required (rules are per-account from creation), which would make the
   `(rule_id, account_id)` composite key in `RuleState` trivially 1:1 rather than genuinely
   many-to-many. I recommend the account-agnostic version — it's what the emphasized composite key
   implies, and it's the natural shape once a rule-editing UI (Phase 9) needs to apply "daily loss
   5%" to two accounts without duplicating the row — but Phase 0's text doesn't give the original
   `rule_definitions` DDL verbatim (only the `ALTER TABLE ... DROP condition, ADD rule_type, ADD
   parameters` diff against it), so this is my inference, not a quote.

2. **`TRADE_FREQUENCY_MULTIPLE` requires two small additive `AnalyticsService` methods** that
   don't exist yet: a trailing-window trade count (today's `frequency.metrics.ts` only has the
   fixed `tradesPerHour`/`tradesPerDay`) and its 90-day-baseline equivalent (`baselines.ts` only
   has `averageTradesPerHour`/`averageTradesPerDay`). Proposed: `tradesInTrailingWindow(prisma,
   accountId, windowMinutes, now)` and `averageTradesPerWindow(..., windowMinutes)` (the latter
   derived the same way `averageTradesPerHour` already is — `totalClosingDealsInWindow /
   (windowCompleteDays * 24 * 60 / windowMinutes)`), following the exact conventions
   `ANALYTICS_SPEC.md` already documents (explicit `now`, null-safe, account-scoped, rounded).
   This is additive — no existing method's signature or return shape changes — but it is a genuine
   (if small) Phase 3 touch, flagged per your "don't redesign previous phases unless a concrete
   dependency requires it" instruction, because this one does.

3. **`POSITION_SIZE_MULTIPLE`'s "open position volume" reads `maximumPositionVolume`** (the
   single largest open position right now), not `currentTotalVolume` (sum of everything open).
   Phase 0's table says only *"Open position volume ≥ factor × baseline"* without disambiguating a
   trader with three simultaneous 0.3-lot positions (would that be "0.3" or "0.9" against a
   0.2-lot average baseline?). I read the rule's intent as "is any single position unusually big,"
   matching `maximumPositionVolume`'s own doc comment ("the biggest position open right now") — a
   summed-volume rule would be a materially different behavioral signal ("is the trader overall
   overexposed") and I'd want that as an explicit sixth rule type rather than folding it into this
   one silently.

4. **Trigger point for `evaluateAccount`** — not specified by Phase 0 beyond "the rule engine gets
   called," and explicitly out of scope for Redis/BullMQ this phase. Two options, both avoiding
   new infrastructure:
   - **(a) Piggyback on ingestion** — call `evaluateAccount` synchronously at the end of
     `CollectorIngressController.postSnapshot`/`postTrades`, right after the existing
     `upsertHeartbeat` call. Zero new moving parts, evaluates within the existing 30s/60s cadence
     Phase 2 already established.
   - **(b) A lightweight `@nestjs/schedule` cron** inside a new (tiny) module, iterating active
     accounts every `N` seconds. Decouples evaluation cadence from ingestion cadence, but is a
     second thing that can be "up" or "down" independently of the collector.
   I'd default to **(a)** — it's the smaller addition, keeps "one thing pushes, the pipeline
   reacts" as the only data-flow shape in the system (matching Phase 0 §01's invariant that "the
   collector is a client of the API, never a peer it polls"), and Phase 4's own scope statement
   (*"PostgreSQL → Analytics → RuleEngine → deterministic alert events"*) reads most naturally as
   a synchronous chain, not a separately-scheduled job. Flagging for your decision rather than
   assuming.

5. **`resolved_at` granularity.** `RuleState.resolvedAt` records only the *most recent* resolution
   for a `(rule, account)` pair, not a per-episode history. Phase 6's AI narrator will eventually
   want *"resolved within 40 minutes"* per past alert (Phase 0 §10's own example), which needs
   per-episode start/end, not just the latest one. I've deliberately left this out of Phase 4 —
   it's derivable later by pairing consecutive `Alert.triggeredAt` timestamps with the gap to the
   next `INACTIVE` transition, and building it now would be speculative for a Phase 6 need. Noting
   it here so it isn't forgotten, not because Phase 4 needs to solve it.

6. **Global alert-fatigue controls** (a cross-rule "mute for N hours," a per-severity minimum
   interval) are listed in Phase 0 §29 as *still genuinely undecided*, not deferred-but-decided.
   Phase 4 as specified here does **not** implement them — only per-rule cooldown (§5), which
   *is* fully specified. Out of scope for this phase by Phase 0's own admission, not an oversight.

7. **No `severity` field.** Phase 0's text never assigns a severity to a rule or alert (§28 notes
   *"no field anywhere names a specific severity threshold... in code"*). None is added here. If
   Phase 5/6 need one for Telegram routing or the AI narrator's `statistical_context`, that's a
   forward migration at that point, not a gap in this one.

---

**Next step:** review §§1–12 above (§12.12 in particular — six of those seven points are
judgment calls I made in the absence of a fully-reproduced Revision 0 `rule_definitions`/`alerts`
DDL, and I'd rather you overrule any of them now than have them baked into a migration). No
implementation has been started — no migration run, no module scaffolded.

---

## Addendum — Phase 4 post-implementation review (concurrency fix)

Implemented as specified above, with decisions #1–#7 from the Phase 4 approval message applied
(rules are account-specific; `TRADE_FREQUENCY_MULTIPLE` got the minimal `tradesInTrailingWindow`
analytics addition; `POSITION_SIZE_MULTIPLE` uses `maximumPositionVolume`/`averagePositionVolume`/
`maximumNormalPositionVolume` exactly as specified; evaluation is wired into the existing ingestion
path, not a cron). Verified end-to-end against a real MT5 demo account — see the session's Phase 4
verification report for the full procedure and results.

**One concrete bug found during review, not present in this document's design:** `AlertLifecycleService.apply()`'s
read-decide-write sequence (§4's transition table) had no transactional locking. Two concurrent
calls for the same `(rule, account)` — e.g. two overlapping ingestion requests — could both read
`INACTIVE`, both decide `TRIGGERED`, and both create an `Alert` row: a duplicate this document's
dedup guarantee (§5) was never meant to allow. Not a spec error — the transition table itself is
correct — an implementation gap in translating "one row per (rule_id, account_id)" into something
that actually serializes concurrent writers.

**Fix:** `AlertLifecycleService.apply()` now runs the entire transition inside `prisma.$transaction`,
holding a `SELECT ... FOR UPDATE` row lock on the rule's `rule_state` row for the duration
(`RuleStateService.lockForUpdate`). A second concurrent evaluation of the same rule blocks until the
first transaction commits, then correctly sees the just-updated state (e.g. `ACTIVE` within
cooldown) and no-ops. `RuleDefinitionsService.create()` now also creates the rule's initial
`rule_state` row (`INACTIVE`) atomically with the rule itself, so the lock always has a row to hold
from the rule's first evaluation onward; a bounded single retry in `apply()` catches the narrow
unique-constraint race this closes for any rule that predates the fix. Regression test:
`test/rules/lifecycle.spec.ts` — *"two concurrent apply() calls for the same rule+account/TRIGGERED
result never create two alerts."*

---

## Addendum — Adding a new leaf rule type (extension checklist)

Written for a specific need: a trader with their own plain-language trading rules, who will hand
them over one at a time, needing each translated into a deterministic, testable rule without a
redesign per rule. This section is the recipe — no new rule type is added by this addendum itself.

**The closed-enum decision (§1, §2.6) is deliberate and stays.** There is no general-purpose
expression DSL, and none should be added speculatively. Every rule type is still one leaf evaluator
function, added through the same mechanical, compiler-enforced checklist below — proven twice
already (the original 9 leaf types at Phase 4, then `HIGH_IMPACT_EVENT_EXPOSURE` added later as the
first rule type reading data beyond the standard current-metrics/baseline shape).

**Two things a plain-language rule can become, before writing any code:**

1. **"Alert when existing condition A AND/OR existing condition B are both true"** — if A and B are
   each already an existing leaf rule type (just with the parameter values this specific rule
   needs), this needs **zero new code**. Create two leaf `RuleDefinition` rows (the individual
   conditions — they can stay `enabled: true` in their own right, or the leaf rows can exist purely
   to be referenced), then one `COMPOUND` row referencing both `component_rule_ids` with
   `combinator: 'AND'` or `'OR'` (`compound.evaluator.ts`). Real limits to know before reaching for
   this: flat only (a `COMPOUND` cannot reference another `COMPOUND`), no negation (no "A AND NOT
   B"), and it reads each component's **already-computed** `rule_state.state` (ACTIVE/INACTIVE), not
   a re-evaluation of raw numbers — so a component's own threshold/window parameters still fully
   control when it goes ACTIVE.

2. **Anything else — a genuinely new condition (a new data source, a negation, a comparison shape
   that doesn't exist yet)** needs one new leaf `RuleType`. The touch points, in order, with the
   real files that show the pattern:

   | # | File | What changes | Worked example already in this codebase |
   |---|---|---|---|
   | 1 | `prisma/schema.prisma` | Add the new value to the `RuleType` enum; run a migration. No other schema change — `RuleDefinition.parameters` is already a free-form `Json` column. | `HIGH_IMPACT_EVENT_EXPOSURE` added in migration `20260905141631_add_high_impact_event_exposure_rule_type`. |
   | 2 | `rules/dto/rule-parameters.dto.ts` | Add one `class-validator` DTO class for the new type's parameters (or an empty class if it takes none, like `NoStopLossParamsDto`), plus a plain TS type alias. | `HighImpactEventExposureParamsDto` / `HighImpactEventExposureParams` (`minutes_before`, `minimum_exposure_volume`). |
   | 3 | `rules/dto/validate-rule-parameters.ts` | Add one entry to `PARAMS_CLASS_BY_TYPE: Record<RuleType, ...>`. TypeScript's exhaustiveness check on this `Record` makes a missing entry a **compile error**, not a silent gap. | Same map, same file. |
   | 4 | `rules/evaluators/<new-name>.evaluator.ts` | One pure function: `(params, current: CurrentMetrics, baseline?: HistoricalBaselines, extra?: EvaluatorExtras) => RuleComparisonOutcome`. No I/O, no wall-clock reads (`extra.now` instead), no AI/Telegram/MT5 access — the orchestrator fetches everything first (§3). Must return `INSUFFICIENT_DATA` (not throw, not silently pass) when the data it needs isn't available yet (§8). | `high-impact-event-exposure.evaluator.ts` — the closest existing template for a condition that isn't a plain account-metric threshold. |
   | 5 | `rules/evaluators/index.ts` | Add the type to `LEAF_RULE_TYPES` and one `case` in `evaluateLeafRule`'s switch. The `const exhaustive: never = ruleType` line at the end of that switch makes a missing case a **compile error** too. | Same file. |
   | 6 | `alerts/rule-engine.service.ts`'s `buildExtras()` | **Only if** the new evaluator needs data beyond the standard `CurrentMetrics`/`HistoricalBaselines` every rule already gets (account/position/activity/frequency/sequence numbers — `analytics/types/analytics.types.ts`). Add one `if (rule.ruleType === RuleType.X)` branch that fetches the extra data and returns it on `EvaluatorExtras`, then add the new field to the `EvaluatorExtras` interface (`rules/types/rule-engine.types.ts`) with a comment naming which rule type it's for. | `HIGH_IMPACT_EVENT_EXPOSURE`'s branch (`rule-engine.service.ts:110-130`) fetches from `MarketEventQueryService` and adds `upcomingHighImpactEvents` to `EvaluatorExtras` — the template for wiring in a genuinely new data source (this is also where technical-indicator or historical-EURUSD-pattern data would enter, if a future rule needs it: compute it once here, hand the evaluator an already-computed, already-sliced value — never let an evaluator reach for a data source itself). |

   **Frontend: no change needed.** The rules page (`frontend/src/app/rules/[accountId]/page.tsx`)
   renders `rule.parameters` generically (`Object.entries(...)`); rule creation is CLI-only today
   via `scripts/manage-rules.ts create <accountId> <RULE_TYPE> --param key=value [--cooldown N]
   [--name ...]`.

**One architectural fact to know before phrasing a rule, not a limitation of this checklist:**
this system is alert-only. Nothing anywhere in this codebase blocks, cancels, or intercepts a
trade — there is no order-blocking/execution-prevention concept at all, by design (§11: no
MT5/collector query, no trade-execution capability). A rule phrased *"do not enter BUY when X and Y
are true"* becomes, mechanically, *"alert the moment X and Y are both true"* — informative, not
preventive. If actual order-blocking is ever wanted, that is a different system (an MT5-side Expert
Advisor or a broker-side control), not an extension of this rule engine.
