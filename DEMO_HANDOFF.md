# DEMO_HANDOFF — gold (XAUUSD) execution

**Status as of 2026-09-15 (latest session, isolation/reliability work): GOLD_KILL_SWITCH IS
CURRENTLY ENGAGED — new gold entries are PAUSED.** This supersedes the "kill switch cleared" line
below, which described an EARLIER point in the same day before this session's work began. See
"Update — 2026-09-15, isolation + reliability session (Telegram/kill-switch/volume/close-
execution/protection-remediation/AI/feed-status)" at the bottom of this file for what changed,
what was verified and how, and exactly what the user needs to do to resume. Do not clear the kill
switch without reading that section first.

---

*(Earlier status line, now superseded — kept for history:)* **Status: LIVE, fully verified
against the corrected code, kill switch cleared.** The user restarted the scheduler at
2026-09-15T13:36:38Z; it has completed multiple clean cycles. See "Update — 2026-09-15, post-fix
restart verified live" below for the full, independently-checked evidence. No genuine order has
occurred yet — the system is correctly idle, waiting for a new H4 level to form (zero levels are
currently active) and then for its first touch.

## Update — 2026-09-15, post-fix restart verified live

The user restarted the scheduler and removed `backend/KILL_SWITCH`. Verified independently
rather than trusting the report, covering every dimension asked:

- **Kill switch**: confirmed removed from disk; live status call confirms `killSwitchActive:
  false`.
- **Scheduler process**: exactly ONE process tree (`cmd.exe` → `node` (ts-node-dev wrapper) →
  `node` (tsx-run script), PIDs 15552/13152/19204), started 2026-09-15T13:36:35 local — no
  duplicate top-level scheduler invocation found.
- **Confirmed the restarted process is running the corrected code**, two independent ways (not
  just trusting that a process started): (1) its start time is AFTER the on-disk mtime of every
  file changed by this session's fixes (last changed 16:14:25 local; process started 16:36:36
  local); (2) its own persisted `gold-watch-state.json` now contains the `liveTouch` field,
  which only exists in the corrected `gold-signal-source.ts`/`gold-live-touch.ts` — proof the
  new code actually ran and wrote this state, not just that a process is up.
- **Collector**: single process tree unchanged (PID 16084 + its expected MT5-IPC child 5568),
  still the same instance from earlier in this session.
- **`GET /research/gold-execution-status`, fresh call**: `accountMode: "DEMO"`,
  `accountTradeMode: "DEMO"`, `stopNewEntriesActive: false`, `killSwitchActive: false`,
  `occupancy.hasExistingXauusdExposure: false`, settings unchanged from spec (0.01 lots, magic
  262610181, $10 TP/SL, 200pt deviation), `accountSnapshotStale: false` (6.7s old),
  `recentDecisions`/`closedTrades`/`openPositions` all empty.
- **Data freshness, checked independently of the status endpoint**: XAUUSD M1 true-UTC
  staleness ~5.8 minutes (correct EET conversion); live tick age ~6.7s (10s refresh cadence,
  consistent with the independently-measured collector interval from the previous update).
- **Why zero events have fired since restart, checked directly rather than assumed benign**:
  `gold-watch-state.json`'s `replay.levels.activeLevelIds` is currently EMPTY — there is no
  currently-active H4 support/resistance level at all (whatever last existed has already been
  consumed or expired). This is why every post-restart cycle correctly shows
  `actionableEvents=0` and the live-quote tracker has no baseline yet — there is nothing to
  detect a touch ON right now, not a detection failure. The system is correctly waiting for
  `confirmed-retest-v2`'s own H4/D1 formation logic (unchanged) to activate a new level before
  either detection layer has anything to watch.

**The corrected system is now genuinely live**: collector polls MT5 every ~10s (ticks/snapshot)
and gold-order-pending every ~10s (same main loop), the backend evaluates real occupancy/risk
each time a signal fires, and the scheduler runs continuously, single-instance-locked, on the
corrected code, currently idle by genuine market state (no active level), not by any remaining
defect. It will act the next time a new H4 level forms and is genuinely first-touched inside
04:00–12:00 Asia/Beirut, with every check from this session's rounds (live-quote detection,
M1 audit-only backstop, pre-send guard, signal-age/window/deviation/occupancy/kill-switch
rechecks) in effect. No code or config changes are pending.

## Update — 2026-09-15, six focused checks (one real defect fixed, one real test-env bug fixed)

Verification-only pass over the live-quote-detection round, per six specific, numbered checks.
No formation rule, price-deviation limit, or strategy parameter was touched.

**1. M1-discovered touches — real defect found and fixed.** Verified: an M1-discovered touch
still reached `GoldExecutionCoordinatorService.evaluate()`, gated only by the 600s age cap — so
a fresh-enough backlog touch, or a brief touch-and-reversal M1's own wick detection later caught
after the live-quote layer's latest-tick sampling missed it, COULD still have been submitted as
a genuine, delayed order. Fixed: `runGoldWatchCycle`'s M1 path no longer calls the coordinator,
fetches a price, or queues anything — it writes an audit-only `AutonomousDecision`
(`orderStatus: NONE`) and marks the event acted-on. The level is still consumed either way (via
v2's own unchanged `consumeLevel()`), so the opportunity can never later be mistaken for a fresh
touch by either layer. Proven with new tests covering exactly the two named scenarios (startup
backlog, missed-then-M1-caught reversal) — both now log-and-consume, never submit
(`gold-watch-cycle.spec.ts`).

**2. Shared consumption state — confirmed correct, demonstrated with a test, not just described.**
Both layers operate on the literal same in-memory `ReplayState.levels` object every cycle, and
M1 replay runs first specifically so it gets first claim on anything its own closed-candle data
can already see. Wrote an integration test with two distinct levels in one cycle: level A is
M1-discovered and consumed (now provably audit-only, never a stale order per check 1's fix);
level B is untouched by M1 and remains fully live-detectable in that SAME cycle and the next —
proving M1 running first neither creates a stale order (check 1) nor suppresses a genuinely
different, still-open opportunity. A level's first live observation is a baseline only (not a
touch) by design — that's the same "no prior reference point" rule every level starts under,
not suppression, and the test confirms the level remains active afterward.

**3. Actual intervals — verified independently, not assumed.** Two genuinely different numbers
matter and must not be conflated:
  - **Quote refresh**: `collector/app/runner.py`'s main loop calls `_push_and_print_snapshot()`
    (which reads a fresh `symbol_info_tick` for every configured symbol, XAUUSD included, and
    pushes it to `LiveTick`) every `POLL_INTERVAL_SECONDS` — **10s**, confirmed live in
    `collector/.env`. Verified independently against the actually-running collector (PID 16084,
    still up from earlier this session), not just read from code: sampled `LiveTick(XAUUSD)`
    twice, 12 seconds apart — `tickAt` advanced by exactly 10,000ms, and its own age relative to
    true wall-clock was ~1.6s and ~3.6s at each sample. The quote itself is fresh.
  - **Detection latency** (the actual number that matters for "how late can a live-detected
    touch be"): gated by the SCHEDULER's own polling cadence, not the quote's refresh rate — the
    quote could be refreshed every 10s, but `detectLiveTouches` only ever runs when the
    scheduler's `runCycle` fires, which is `GOLD_SCHEDULER_INTERVAL_SECONDS` (**default 60s**,
    not currently overridden in `backend/.env`) apart. **Worst-case live detection latency ≈ one
    scheduler interval (60s) plus that cycle's own processing time** (M1 replay/paper simulation
    + DB writes — observed at ~1-2s per cycle in this session's earlier scheduler log), not the
    10s tick refresh rate.
  - `GOLD_LIVE_OBSERVATION_MAX_GAP_SECONDS` (150s) is explicitly NOT a freshness guarantee — it
    only bounds how large a gap between two SCHEDULER-cycle observations is tolerated before
    deferring to M1; `GOLD_LIVE_TICK_MAX_STALENESS_SECONDS` (30s, checked against the tick's own
    `tickAt` vs. real "now") is the actual freshness guarantee, and it is a separate check in the
    code (`gold-live-touch.ts`'s `detectLiveTouches`), not something the 150s value substitutes
    for. Restated here because the two are easy to conflate; they were not conflated in the code
    to begin with (verified by reading the two independent checks), but this makes the
    distinction explicit for anyone reading the constants file cold.

**4. Guard → Python → `order_send` trace — confirmed, with the exact remaining gap named.**
Traced `GoldPreSendGuardService.check()` (backend, TS) through to the literal
`order_send()` call (`collector/app/executor.py`):
  - The collector's own poll for a pending order (`_poll_and_execute_pending_gold_order`) runs
    on the SAME 10s main-loop cadence as the snapshot push (`runner.py` line ~199-200) —
    independent of the 60s scheduler interval above, since polling for an already-queued order
    is much cheaper than the full detection cycle.
  - The guard runs INSIDE that same HTTP request (`GoldExecutionController.getPendingOrder`),
    immediately after the atomic PENDING→SENT claim, before the HTTP response is built. If
    approved, the order is in that same response.
  - The collector calls `executor.send_bracket_order(...)` synchronously, in the same poll
    iteration, on receiving that response — no intermediate queue.
  - `send_bracket_order` (`executor.py:330`) independently re-verifies, a THIRD time, using the
    literal connected MT5 terminal, not anything the backend told it: `verify_demo_account()`
    (real `account_info().trade_mode` against MT5's own enum — **the final connected-account
    identity/type check**), then `find_open_position(magic=GOLD_MAGIC_NUMBER, symbol='XAUUSD')`
    (a live `positions_get()` query, not cached), then `_build_bracket_request` fetches a FRESH
    `symbol_info_tick(symbol)` immediately before pricing the SL/TP — **the final quote check**
    — then calls `order_send`.
  - **Exact remaining gap**: from the moment the guard approves (inside the HTTP handler) to the
    moment `order_send` is actually called is the tail of one local HTTP response plus
    synchronous, same-process Python execution (two near-instant local MT5 API calls) — on the
    order of low hundreds of milliseconds on localhost, not minutes. This is categorically
    different from (and much smaller than) the PENDING→claim gap the guard itself exists to
    bound.
  - **Self-conflict check, confirmed false**: `find_open_position` is scoped to
    `GOLD_MAGIC_NUMBER`, and this is always the FIRST attempt for a given decision (claiming a
    DB row never touches MT5) — there is no MT5 position under this magic number yet at send
    time, so this check cannot see the order-in-flight as a conflict with itself. Separately,
    the backend guard's own account-wide occupancy check already excludes the decision's own row
    by id (`resolveOccupancy(accountId, excludeDecisionId)`, added in the previous round, tested
    in `gold-pre-send-guard.spec.ts`). Both layers are independently self-conflict-safe.

**5. `gold-dashboard.spec.ts` failure — root-caused and fixed, not dismissed.** The actual cause:
`AppModule`'s `ConfigModule.forRoot({ isGlobal: true })` loads the real `backend/.env` (not
`.env.test`) the first time any test file boots the app, using dotenv's default
`override: false` — so any key `.env.test` doesn't define falls through to whatever this
deployment's own real `.env` currently has. `GOLD_EXECUTION_MODE=DEMO` (set when gold was
activated operationally) was leaking into a test asserting the OFF default. Fixed in
`test/setup-env.ts`, which now sets `process.env.GOLD_EXECUTION_MODE = 'OFF'` explicitly before
`ConfigModule` ever runs, so its later non-destructive load leaves it alone — deterministic
regardless of this repo's own current `.env`. Reran the specific test AND the full
`gold-execution` suite: **72/72 passing, zero known failures.**

**6. Kill switch — confirmed present; test isolation confirmed complete.** `backend/KILL_SWITCH`
verified still on disk, unchanged, containing this session's original pause note. Grepped every
test file for `AUTONOMOUS_KILL_SWITCH_PATH`: `test/setup-env.ts` now sets an isolated per-worker
default before any test runs, and the two files that specifically exercise kill-switch behavior
(`test/autonomous/kill-switch.spec.ts`, `test/gold-execution/gold-pre-send-guard.spec.ts`) each
further isolate to their own throwaway tmp path in their own `beforeEach`/`afterEach` — no test
anywhere reads or writes the real repository path.

**Verified overall**: `tsc --noEmit` clean; `test/gold-execution` **72/72** (was 68/69 — the one
remaining failure from the previous round is now fixed, not just documented around); `test/autonomous`
139/139; `confirmed-retest-v2/boundary` 15/15. No formation rule, deviation limit, or strategy
parameter changed this round.

**Exact scheduler restart + verification, then clear the kill switch** (unchanged procedure from
the previous round, since the running scheduler still predates every fix to date):
```powershell
# 1. Find and stop the currently-running scheduler:
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*gold-execution-scheduler*' } | Select-Object ProcessId, CommandLine
Stop-Process -Id <that-pid> -Force

# 2. Restart it from backend/ so it loads the corrected code:
cd C:\Users\user\Desktop\trading-monitor-autonomous\backend
npm run gold-execution:scheduler
```
3. **Verify the running version** before clearing the kill switch: watch its console for a
   `cycle complete` line containing `liveTouchEvents=` (proof of the corrected code, not just a
   started process).
4. Only then clear the kill switch:
   ```powershell
   Remove-Item C:\Users\user\Desktop\trading-monitor-autonomous\backend\KILL_SWITCH
   ```
5. Re-check `GET /research/gold-execution-status` — `killSwitchActive` should read `false`.

The backend web server (`ts-node-dev`) has already auto-restarted on every file change so far
(confirmed live, `--respawn`) — only the standalone scheduler process needs the manual restart.

## Update — 2026-09-15, entry-timing correction (live-quote detection)

Direct correction received after the first entry-timing fix: M1 is the primary HISTORICAL
analysis/formation source, but live execution must not wait for an M1 candle to close — the
first fix's `GOLD_MAX_SIGNAL_AGE_SECONDS` cap only bounded how stale a backlog touch could be
before being rejected; it never made detection itself live, and was not an approved substitute
for real first-touch detection.

**What changed** — a full second detection layer, `backend/src/gold-execution/gold-live-touch.ts`:
- Operates on the exact SAME `LevelEngineState` object `confirmed-retest-v2`'s own M1 replay
  advances every cycle (unchanged, frozen — H4/D1 level FORMATION is untouched), calling that
  module's own public `consumeLevel()` — the identical function the M1 path itself calls — so a
  level retires the same way regardless of which layer detects its first return first.
- Detects a touch from the live `LiveTick.bid` (the same price basis MT5's own M1 OHLC uses),
  comparing the current tick to the last tick THIS layer itself observed. M1 replay always runs
  FIRST in every cycle, so the live layer only ever sees levels the M1 layer's already-closed
  data left active — the two layers never race for the same level.
- Detects and consumes a touch OUTSIDE the entry window too (spec's own
  `outsideWindowFirstReturnConsumesLevel` rule, unchanged) — it is never submitted, matching the
  M1 path's existing OUTSIDE_WINDOW handling, but the level is correctly retired either way so a
  later in-window return of the SAME level can never be mislabeled as the first touch.
- Persists its own baseline (`GoldWatchState.liveTouch`, one bid+timestamp per still-active
  level) across restarts. A restart with a stale baseline naturally falls into the "large
  observation gap" path below rather than manufacturing a touch from a comparison that spans an
  unknown outage.

**Honestly disclosed limitations (documented in the module's own header, not glossed over)**:
- `LiveTick` stores only the single latest bid/ask per symbol — there is no tick history to
  scan. Detection resolution is therefore bounded by how often the scheduler polls (currently
  60s by default), not true tick-by-tick granularity.
- A touch-and-full-reversal completing entirely BETWEEN two polls is invisible to this layer —
  both observations show price on the original side. This is a real, disclosed blind spot of
  latest-tick sampling, not a bug: the level stays fully active and visible to the M1 replay
  layer, whose real wick-based high/low detection still catches it, at its own slower cadence.
  Tested explicitly (`gold-live-touch.spec.ts`).
- A gap between two observations of the same level larger than
  `GOLD_LIVE_OBSERVATION_MAX_GAP_SECONDS` (150s — a restart, a stall, a missed cycle) is never
  compared directly to infer a crossing; the layer re-baselines and explicitly defers to M1
  replay's own historical record rather than guess. Tested explicitly (reconnect-backlog case).

**Broker-send-boundary recheck** — `backend/src/gold-execution/gold-pre-send-guard.service.ts`,
called by `GoldExecutionController.getPendingOrder` right after the atomic PENDING→SENT claim
but before the order is handed to the collector (the actual boundary this backend can reach
without modifying the Python executor). Re-verifies, all over again, using the freshest
`LiveTick` as its own reference "now" (not the process wall clock — see the service's own header
for why this also makes it deterministically testable): kill switch, STOP NEW ENTRIES, the
Beirut window, signal age, price deviation, occupancy (excluding the decision's own now-SENT
row), and `trade_mode == DEMO`. A failure explicitly cancels the decision (`orderStatus:
FAILED` with the reason) instead of letting an already-claimed-but-now-stale order reach the
collector. This directly closes the gap named in the correction: "a coordinator check before a
DB write does not cover subsequent queue delay" — tested explicitly with the exact "queued
before noon Beirut, freshest quote already after it closed" scenario
(`gold-pre-send-guard.spec.ts`).

**Verified**: `tsc --noEmit` clean; `test/gold-execution` 68/69 (the one failure is the same
pre-existing, already-documented, unrelated `gold-dashboard.spec.ts` env-var gap — not touched
by this correction); `test/autonomous` 139/139; `confirmed-retest-v2/boundary` 15/15. Also fixed
a genuine, previously-latent test-isolation bug found while writing these tests:
`test/setup-env.ts` was letting every test process fall back to `isKillSwitchActive()`'s default
path (`<cwd>/KILL_SWITCH`), which collided with THIS repo's own real, currently-engaged
operational kill switch and was silently failing unrelated tests
(`autonomous-execution-coordinator.service.spec.ts` included) whenever a test run happened while
the switch was engaged — now isolated to a throwaway path per test worker by default.

**No change to**: H4/D1 level formation, `confirmed-retest-v2`'s frozen rules, the 200pt price-
deviation limit, or any strategy parameter (0.01 lots, $10 TP/SL, magic 262610181).

**Exact scheduler restart + verification, then clear the kill switch:**
```powershell
# 1. Find and stop the currently-running scheduler (it predates this fix and every prior one):
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*gold-execution-scheduler*' } | Select-Object ProcessId, CommandLine
Stop-Process -Id <that-pid> -Force

# 2. Restart it from backend/ so it loads the corrected code:
cd C:\Users\user\Desktop\trading-monitor-autonomous\backend
npm run gold-execution:scheduler
```
3. **Verify the running version before clearing the kill switch**: watch its own console output
   for at least one `cycle complete` line and confirm it includes `liveTouchEvents=` in the
   message (e.g. `cycle complete at ..., actionableEvents=0, liveTouchEvents=0, liveTouchQueued=0`)
   — that field only exists in the corrected code, so its presence in the live log is direct
   proof the new process is actually running the fix, not just that a process started.
4. Only once step 3 is confirmed, clear the kill switch:
   ```powershell
   Remove-Item C:\Users\user\Desktop\trading-monitor-autonomous\backend\KILL_SWITCH
   ```
5. Re-check `GET /research/gold-execution-status` — `killSwitchActive` should read `false`.

The backend web server itself (`ts-node-dev`) already auto-restarted on these file changes
(`--respawn` watches source files) — confirmed live via a fresh
`GET /research/gold-execution-status` call after this correction (`accountMode: DEMO`,
`killSwitchActive: true`, matching the still-engaged switch). Only the standalone scheduler
process (started once via `tsx`, no file-watching) needs the manual restart above.

## Update — 2026-09-15, entry-timing verification (superseded in part — see correction above)

Traced the exact mechanism, per a direct request, without reopening a broad audit or touching
any frozen level/formation rule:

**1. What triggers a live first-touch entry.** Neither a live quote nor an open/in-progress
candle — a **completed historical M1 candle**. `replay.ts:advance()` only processes stream bars
where `bar.t + bar.dur <= endT` (`endT` = the current wall-clock time passed in as `nowT`), i.e.
a bar is only ever evaluated once it has fully closed. `classifyTouch()` then checks that closed
bar's own high/low against the level price. The live quote (`LiveTick`) is used ONLY afterward,
to price the actual bracket order once a touch is already confirmed — never to detect the touch
itself.

**2. Timestamp trace, touch → submission, and why old touches can't silently become new
orders.** `bar.t` is the M1 candle's true-UTC open time (converted from the broker's mislabeled
wall-clock storage by `wallClockToUtc('EET', ...)` in `data-source.ts` — the same conversion
`DEMO_HANDOFF`'s freshness checks use). The window check (`inWindow`) and the level-consumption
rule are both evaluated once, using that bar's own time, when the touch is first classified.
`observedAtT` is stamped with `nowT` at the moment the WATCH cycle (not backtest) processes it,
and `actedEventIds` (persisted in `gold-watch-state.json`) guarantees each event is only ever
acted on once — so a restart or a resumed backlog cannot re-fire an already-acted event. What
was MISSING, until this fix: nothing re-verified that "now" (the actual submission instant) was
still within bounds — only the touch's own bar-time was checked, at formation. Two live,
independent checks now run in `GoldExecutionCoordinatorService.evaluate()`, immediately before
any DB write, using the real `nowT` of that evaluation:
  - **Signal age**: `(nowT - signal.touchEndT) / 1000` must be ≤ `GOLD_MAX_SIGNAL_AGE_SECONDS`
    (600s — comfortably above the ~360s worst-case healthy latency of a 300s candle-sync
    interval plus a 60s scheduler cycle, tight enough to reject a same-day backlog touch
    discovered after real downtime).
  - **Current-price deviation** (pre-existing, unchanged): `entryDeviationPoints =
    |currentExecutablePrice - signalEntryPrice| / pointSize` must be ≤
    `GOLD_MAX_ENTRY_DEVIATION_POINTS` (200pt / $2.00). This is a price-drift proxy, not a time
    check — it was the ONLY guard before this fix, and a ranging market could satisfy it
    indefinitely even for a genuinely stale touch, which is exactly the gap the new age check
    closes.
  - Both rejections are logged as their own `AutonomousDecision` row (`orderStatus: NONE`,
    `riskManagerApproved: false`, a specific `riskManagerRejectionReason`), same audit-trail
    posture as the existing STOP_NEW_ENTRIES recheck.

**3. Live Beirut-window recheck, immediately before submission.** Also added in the same fix:
`beirutSecondsOfDay(nowT)` is recomputed and compared against the same
`SPEC.session.entryWindow*` bounds the touch itself was checked against — but using the
CURRENT time, not the touch's bar time. If the touch was in-window at its own bar time but
"now" has moved outside 04:00–12:00 Asia/Beirut (candle-sync/scheduler delay carried it past
the boundary), the order is refused and logged, not submitted late. The observed
12:07Z/12:08Z-UTC scheduler cycles noted in the verification request are 15:07/15:08 Beirut —
correctly outside the window either way (no event was ever actionable at that hour, backtest or
live), so they were never at risk of a wrongly-submitted order; the fix addresses the narrower,
real edge case of a touch near the boundary picked up just late enough to cross it.

**4. Concrete defect found and fixed, without widening any limit or touching level rules.**
Confirmed: yes, a real gap existed — no live re-verification of window or age at actual
submission time, only at formation time. Fixed in `gold-execution-coordinator.service.ts` (two
new reject branches) + `gold-signal-source.ts` (`toGoldSignal` now carries `event.touchEndT`
through onto the signal) + a new `GOLD_MAX_SIGNAL_AGE_SECONDS = 600` constant in
`gold-safety-constants.ts`. Nothing in `confirmed-retest-v2/` (frozen research code, level
formation, or the entry-window spec values themselves) was touched. Verified: `tsc --noEmit`
clean; `test/gold-execution` 51/51; `test/autonomous` 139/139; `confirmed-retest-v2/boundary`
15/15 (the v2→execution import direction is still one-way, matching the existing
`gold-signal-source.ts` pattern — nothing under `confirmed-retest-v2/` imports execution code).
One pre-existing, unrelated test gap noted, not touched: `gold-dashboard.spec.ts`'s "OFF by
default" test now reads the real persisted `GOLD_EXECUTION_MODE=DEMO` from `.env` instead of an
unset default — a test-isolation gap surfaced by activation itself, not a regression from this
fix, and out of scope for an entry-timing change.

**Paused, not restarted, because of a real constraint**: the fix is only live in the SOURCE —
the scheduler process already running (`tsx scripts/gold-execution-scheduler.ts`, started
earlier this session) loaded the old code at its own start time and does not hot-reload. Since
stopping that process was denied by this environment's own classifier (same restriction as the
backend restart earlier), `backend/KILL_SWITCH` was created to pause new entries (checked fresh
on every evaluation, no restart needed) while the fix was written, and **remains in place now**
specifically because the running scheduler still lacks the fix. Monitoring, the collector, and
the backend were not touched and continue running normally.

**Exact remaining manual step:**
```powershell
# Find and stop the currently-running scheduler (started earlier this session):
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*gold-execution-scheduler*' } | Select-Object ProcessId, CommandLine
Stop-Process -Id <that-pid> -Force

# Restart it (from backend/) so it loads the corrected code:
cd C:\Users\user\Desktop\trading-monitor-autonomous\backend
npm run gold-execution:scheduler
```
Then remove the kill switch to resume new entries:
```powershell
Remove-Item C:\Users\user\Desktop\trading-monitor-autonomous\backend\KILL_SWITCH
```
Watch its log for a couple of `cycle complete` lines before considering it fully resumed, same
verification done at initial activation.

## Update — 2026-09-15, activation

The user restarted the backend themselves (`ts-node-dev`, new PID 20244) with
`GOLD_EXECUTION_MODE=DEMO` explicitly set, confirming clean startup (API on :8420,
GoldExecutionModule loaded, collector snapshots/candles/ticks arriving, no errors). Re-verified
everything fresh rather than trusting the restart alone:

- `GET /research/gold-execution-status`: `"accountMode": "DEMO"`, `"accountTradeMode": "DEMO"`,
  `killSwitchActive: false`, `stopNewEntriesActive: false`, `occupancy.hasExistingXauusdExposure:
  false`, settings match the frozen spec exactly (0.01 lots, magic 262610181, $10 TP/SL, 200pt
  max deviation), `accountSnapshotStale: false` (2.3s old), `recentDecisions`/`closedTrades`
  both empty.
- XAUUSD M1 freshness re-checked with the true-UTC EET conversion: ~5 minutes stale — fresh.
  Collector process (PID 16084 + its expected MT5-IPC child 5568, single tree) confirmed alive
  and cycling in its own log, current to within the same window as the DB check.
- No scheduler process existed yet. Started `npm run gold-execution:scheduler` from `backend/`
  in the environment's own background process (this was NOT denied — only *stopping* existing
  processes is restricted here, starting new ones is not). Confirmed via
  `Get-CimInstance Win32_Process`: single scheduler process tree (`tsx
  scripts/gold-execution-scheduler.ts` → node → ts-node-dev-hook), no duplicates.
- Watched its own log directly for two consecutive real cycles, ~60s apart as configured:
  `cycle complete at 2026-09-15T12:07:08.123Z, actionableEvents=0` and
  `cycle complete at 2026-09-15T12:08:05.332Z, actionableEvents=0` — genuinely running, not
  just started-and-assumed. `actionableEvents=0` both times is correct/expected (no confirmed
  first-return event yet), not a fault.

**The system is now genuinely live**: the collector polls MT5, the backend evaluates real
occupancy/risk/volume/currency each cycle, and the scheduler runs continuously and
single-instance-locked. It will place a real (demo-account) bracket order the next time a
first-return event confirms inside the 04:00–12:00 Asia/Beirut window with no existing XAUUSD
exposure and risk caps clear — no further code or config changes are needed for that to happen.

**To stop/pause**: Ctrl+C the scheduler's terminal (clean shutdown, no order left mid-flight
since it only ever queues via the same DB-row mechanism the collector polls), or set
`GOLD_STOP_NEW_ENTRIES=true` in the backend's environment (rechecked every cycle, no restart
needed) to halt new entries without touching EURUSD or an already-open position. See
`GOLD_STARTUP_SHUTDOWN_RECOVERY.md` for the full kill-switch/close-position notes (an explicit
"close gold position" HTTP route still does not exist — `executor.py`'s `close_position` would
need to be called directly if a position must be force-closed without the strategy's own logic
doing it via SL/TP).

Everything below this point is retained from the prior sessions for context; the blockers those
sections describe (collector down, stale data, unconfirmed backend mode) are all cleared as of
this update.

## Update — 2026-09-15, session resumed after interruption

Picked up from the prior interruption (VS Code Python extension restart, not a real blocker).
Verified fresh, did not assume anything from the old checkpoint text:

1. **Collector restarted successfully** — the environment's process classifier did NOT deny
   this (only killing processes is denied, starting is fine). Confirmed via the fresh startup
   log line: `"autonomous_execution_enabled": false, "gold_execution_enabled": true`. Single
   process tree confirmed (`collector/.venv/.../main.py` PID 16084 with its expected MT5-IPC
   child PID 5568 — no duplicate top-level instance).
2. **XAUUSD M1 freshness re-verified with the correct EET-true-UTC conversion**: staleness is
   now ~3 minutes (was ~83 minutes before this restart). Acceptable for live entry-window
   decisions.
3. **`trade_mode` re-confirmed fresh, post-restart**: latest `AccountSnapshot` (captured
   2026-09-15T11:53:52Z, 441ms old at check time) reads `tradeMode: DEMO`, `balance = equity =
   50000`. This is a NEW confirmation from a snapshot captured after this session's own
   restart, not a reuse of the prior session's 10:57:30 evidence.
4. **Found the config was already further along than the checkpoint doc said**: `collector/.env`
   already had `GOLD_EXECUTION_ENABLED=true` and `backend/.env` already had
   `GOLD_EXECUTION_MODE=DEMO` persisted (uncommitted, gitignored — set in the interrupted prior
   session but never reflected in the docs). These were NOT changed this session; they were
   found already set and verified correct against the frozen spec (0.01 lots, magic 262610181,
   $10 TP/SL, 200pt max deviation — confirmed via a live `GET /research/gold-execution-status`
   call).
5. **New blocker found (config/runtime mismatch, not a code bug)**: the *backend* dev process
   (`ts-node-dev`, started before `.env` was last edited) still has the OLD env in memory —
   `GET /research/gold-execution-status` returns `"accountMode": "OFF"` even though `.env` on
   disk says `DEMO`, because `dotenv` only loads into `process.env` once at process start and
   nothing hot-reloads it. Restarting the collector process independently fixed the collector
   (it was fully restarted, not just left running with a stale env). The backend needs the same
   treatment.
6. **Attempted to restart the backend to fix this myself; was denied.** Stopping the existing
   `ts-node-dev` process (PIDs 5884/7276) was blocked by this environment's own process
   classifier ("Interfere With Workloads") — the same restriction noted in earlier rounds for
   killing processes (starting new ones is allowed; stopping existing ones is not). The backend
   was NOT harmed by the attempt — confirmed still running and healthy afterward (still
   answering on :8420, still `accountMode: OFF` as expected pre-restart).

**Exact remaining manual step for a human with process-stop permission:**
```powershell
# Stop the current backend dev server (find/confirm PID first if unsure):
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*ts-node-dev*src\main.ts*' } | Select-Object ProcessId, CommandLine
Stop-Process -Id <that-pid-and-its-npm-parent> -Force

# Restart it (from backend/) so it re-reads .env, including GOLD_EXECUTION_MODE=DEMO:
cd C:\Users\user\Desktop\trading-monitor-autonomous\backend
npm run dev
```
Then re-check `GET /research/gold-execution-status` and confirm `"accountMode": "DEMO"` before
starting the scheduler (`npm run gold-execution:scheduler`, from `backend/`, in its own
terminal so it keeps running). Once both read correctly, the system is live and will place a
genuine demo order the next time a first-return event confirms inside the 04:00–12:00
Asia/Beirut entry window with no existing XAUUSD exposure. No genuine order has occurred yet —
`recentDecisions`/`closedTrades` were confirmed empty in the same live status call above.

Everything below this point is the prior session's account and is retained for context; the
"remaining blockers" it describes (§2/§3/§4) are the ones cleared in the update above.

## 1. Account identity — DEMO is now POSITIVELY CONFIRMED, with evidence

Corrected timeline:
- The original `api_mapper.py` trade_mode-label bug (see §2) meant the account's `tradeMode`
  read `"REAL"` in earlier data — that reading was never trustworthy, and was correctly never
  treated as a real confirmation.
- The bug was fixed (commit `07a154c`) and the collector was restarted (by the user) after the
  fix.
- **Independently re-queried directly against the real Postgres DB** (not the API, not a log
  claim): the freshest `account_snapshots` rows for account `753b3a50-205b-45a3-b770-885357539d54`
  (MT5 `5055783885`, broker `MetaQuotes-Demo`) — three consecutive rows at `10:57:09`,
  `10:57:20`, `10:57:30` UTC — all show `trade_mode = 'DEMO'`, `balance = equity = 50000`.
- **Cross-corroborated independently a second way**: `live_ticks` rows for both `XAUUSD`
  (bid 4281.39 / ask 4281.66) and `EURUSD` (bid/ask 1.15354) carry the identical timestamp
  `2026-09-15T10:57:30Z` — proof this was a live, actively-connected collector cycle at that
  moment, not a stale or synthetic row.
- **End-to-end mapping re-verified from source**: the installed `MetaTrader5` package's own
  `__init__.py` defines `ACCOUNT_TRADE_MODE_DEMO=0, CONTEST=1, REAL=2`; the corrected
  `api_mapper.py._TRADE_MODE_LABELS = {0: "DEMO", 1: "CONTEST", 2: "REAL"}` now matches this
  exactly (checked directly, not from memory). `executor.py`'s own live order-placement gate
  (`verify_demo_account`) was never affected by the old bug either way — it compares against
  the real `MetaTrader5` module's own constant directly.

**Conclusion: DEMO is positively confirmed as of ~10:57:30 UTC on 2026-09-15**, from real,
freshly-pushed, cross-corroborated data, using the corrected mapping, checked end-to-end.

## 2. But the collector is NOT currently running — this is the actual remaining blocker

Checked directly, twice, a few minutes apart: `Get-CimInstance Win32_Process -Filter
"Name='python.exe'"` shows **zero** processes with `main.py` on their command line right now.
Whatever process produced the 10:57:30 UTC data has since stopped (cleanly or not — unknown).
Starting a fresh collector process was attempted by this agent and **explicitly denied by this
environment's own "Interfere With Workloads" safety classifier** — the same restriction that
blocked killing a process in the previous round. This is a genuine external tooling
constraint, not something bypassed, and not something this agent can resolve without a human
starting the process.

**Correction to the previous version of this doc, per direct user correction**: the two
`python.exe main.py`-looking processes seen earlier (PID 4664 venv-python, PID 12532
system-python) were **not two independent duplicate collectors** — 12532 was a child process
of 4664 (the MetaTrader5 IPC bridge spawning a helper), a normal, expected process shape, not
a duplicate-instance problem. The "kill the duplicate" framing in the prior version of this
doc was wrong and is retracted. The duplicate-process check in
`GOLD_STARTUP_SHUTDOWN_RECOVERY.md` is updated accordingly (check for more than one *process
tree*, not more than one *process*).

## 3. Data freshness — XAUUSD M1 is NOT currently acceptable for live decisions

Checked directly with the same conversion layer `confirmed-retest-v2/data-source.ts` uses
(`wallClockToUtc('EET', ...)`, not the raw broker-mislabeled timestamp): the latest stored
XAUUSD M1 bar's raw label is `2026-09-15T12:44:00Z`; its TRUE UTC open time is
`2026-09-15T09:44:00Z`. At the time of this check (`2026-09-15T11:06:57Z` true UTC), that is
**~83 minutes stale**, and rising, since the collector is not running to sync further. This is
far outside an acceptable bound for trusting entry-window/signal decisions live — do NOT rely
on current M1 data for a live signal until the collector has run continuously long enough to
resync (the live tick pipe, separately, was healthy — only ~6-9 minutes stale at 10:57:30 —
suggesting the M1 candle-sync specifically had a backlog to work through when it stopped, not
a renewed version of the original candle-sync-lag bug from `MORNING_HANDOFF.md`, which that
fix already addressed for the tick-adjacent path).

## 4. Effective `GOLD_EXECUTION_ENABLED` value — cannot be read from a live process right now

`collector/.env` has no `GOLD_EXECUTION_ENABLED` line at all (defaults to `false` per
`config.py`). The user separately reported setting `$env:GOLD_EXECUTION_ENABLED = "false"` in
the PowerShell session used to relaunch the collector — and `main.py`'s own `load_dotenv()`
call is confirmed, by its own comment, to **never override an existing process env var**
(python-dotenv's default `override=False`), so a process-level override like that would win
over `.env` regardless of the file's contents. Since no collector process is currently
running, there is no live process to read an effective value from at all right now — this
must be re-checked from the actual startup log line (`"gold_execution_enabled": ...`,
`runner.py`'s own startup log) the next time the collector is started, not assumed from either
the `.env` file or a shell variable alone.

## 5. Scheduler — built this round (was missing before)

`backend/src/gold-execution/gold-execution-scheduler.ts` + `backend/scripts/gold-execution-scheduler.ts`
(`npm run gold-execution:scheduler`): a real, restart-safe, single-instance-locked (reuses
v1's own `ProcessLock`), periodic (default 60s, `GOLD_SCHEDULER_INTERVAL_SECONDS`) invocation
of the gold watch cycle. Never overlaps cycles, never crashes the loop on one cycle's error,
handles SIGINT/SIGTERM cleanly. 6 new tests (fake timers), all passing. It is NOT currently
running (nothing is, per §2) and has never been run continuously in production — only
unit-tested in isolation.

## 6. EUR/USD currency conversion — added this round

`evaluateGoldRiskManager` now requires `accountCurrency`/`profitCurrency`/a live
`profitCurrencyToAccountCurrencyRate` and fails closed (rejects) rather than assume 1:1 when a
conversion is actually needed (confirmed live: this account's currency is EUR, gold's real
`SymbolMetadata.profitCurrency` is USD) but no live rate is available.
`GoldAccountStateService.resolveConversionRate` derives the rate from the same live
`LiveTick('EURUSD')` row gold's own price comes from. 6 new tests, including one that proves
the real conversion and a naive 1:1 assumption produce genuinely different pass/reject
verdicts on the same input (not just different numbers).

## 7. What IS implemented (code, tested, committed locally — not pushed)

- `backend/src/gold-execution/` — constants, risk manager (now currency-aware), OFF/SHADOW/DEMO
  mode switch, coordinator, account-state resolver (occupancy/equity/trade_mode/volume
  constraints/currency, all live-queried, all fail closed), collector poll/report routes,
  dashboard endpoint, signal source bridging confirmed-retest-v2 (without modifying it), and
  the scheduler (§5).
- Collector-side: independent `GOLD_EXECUTION_ENABLED` flag, gold poll/report calls, reuse of
  `executor.py`'s existing symbol/point-size parameters (no executor.py change needed), and the
  `api_mapper.py` trade_mode fix (§1/§2 of the prior finding).
- Docs: `FRIEND_RULES_AND_IMPLEMENTATION.md`,
  `backend/src/research/XAUUSD_H4_CONFIRMED_RETEST_GOLD_LIVE_V1_SPEC.md`,
  `backend/src/gold-execution/GOLD_LIVE_HISTORICAL_EVALUATION.md`,
  `GOLD_STARTUP_SHUTDOWN_RECOVERY.md`, this file.

## 8. Tested, and how (evidence) — scoped, not the full 1200+ suite re-run every time

`tsc --noEmit` clean throughout. `test/gold-execution/` — 51 tests across risk-manager
(including currency conversion), e2e collector-route symbol-scoping + occupancy + volume +
currency resolution (against the real test Postgres DB), signal-mapping, dashboard, and
scheduler (fake-timer) suites — all passing. `test/autonomous/` 139 tests unaffected. v1/v2
research-boundary suites 34 tests unaffected. Collector pytest suite 194/194 (includes the
trade_mode-mapping fix and its corrected test). A full 1229-test backend run was done once
earlier this task and found 3 pre-existing, already-documented flaky failures unrelated to
gold — it was **not** re-run again for this round's smaller, scoped changes, per instruction;
scoped-suite passing is good evidence, not absolute proof against a regression somewhere
entirely untouched by this work.

## 9. Whether genuine orders have occurred

**No.** `AutonomousDecision` rows with `symbol='XAUUSD'` and `orderStatus` other than `NONE` do
not exist. Verify via `GET /research/gold-execution-status`'s `recentDecisions`/`closedTrades`
(both empty) or a direct query.

## 10. Whether demo automation is active right now

**No, on every axis**: `GOLD_EXECUTION_MODE` was left at its default `OFF` (not flipped to
DEMO by this agent — see §11 for why), `GOLD_EXECUTION_ENABLED` was not set, the scheduler was
not started, and — separately, factually — no collector process is running at all right now
regardless of any flag.

## 11. Why activation was NOT completed even though DEMO is confirmed

Positive DEMO confirmation (§1) was the PRIMARY blocker from the previous round, and it is now
cleared. But three things still make activation premature right now, and this agent
deliberately did not flip `GOLD_EXECUTION_MODE`/`GOLD_EXECUTION_ENABLED` to true in any
persisted config given all three:
1. **No collector process is running** (§2) — flipping the switches now would do nothing
   except silently arm a system that will start acting the moment someone next launches the
   collector, possibly without them re-checking the two items below first.
2. **XAUUSD M1 data is ~83 minutes stale** (§3) — entry-window and signal correctness depend
   on this data; it must be fresh (which requires the collector running continuously for a
   period to resync) before any live signal decision can be trusted.
3. **The full live operational checklist** (occupancy under real contention, protection
   placement, restart recovery, kill switch against a live process, no-duplicate-process check
   — corrected per §2) has not been re-run against an actually-running system this round,
   since none is running to test against.

## 12. Exact next steps for a human with process-management access

1. Start the collector (`GOLD_STARTUP_SHUTDOWN_RECOVERY.md` has the command) and let it run
   long enough for XAUUSD M1 to resync to a small staleness (re-check with the same
   `wallClockToUtc('EET', ...)` method used in §3 — do not trust the raw label).
2. Confirm the collector's own startup log line's `gold_execution_enabled` value directly
   (§4) — do not assume from `.env` alone.
3. Re-confirm `trade_mode == 'DEMO'` one more time from a snapshot captured after that fresh
   start (cheap, and removes any doubt from the process having restarted again).
4. Only then set `GOLD_EXECUTION_MODE=DEMO` and `GOLD_EXECUTION_ENABLED=true` and start
   `npm run gold-execution:scheduler`.
5. Historical evaluation (Outputs A/B) is already done and reported honestly as a loss under
   tested assumptions — see `GOLD_LIVE_HISTORICAL_EVALUATION.md`. This does not block
   activation by itself.
6. Still not built: an explicit "close gold strategy positions" HTTP route (task step 6E) —
   `executor.py`'s existing `close_position` can be called with `GOLD_MAGIC_NUMBER`, but no
   route/test exists yet.

---

## Update — 2026-09-15, isolation + reliability session (Telegram/kill-switch/volume/close-execution/protection-remediation/AI/feed-status)

This session did NOT touch confirmed-retest-v2 strategy logic, entry timing, or risk-cap
thresholds. It built out gold's Telegram/kill-switch isolation from the legacy EURUSD strategy,
then (in a follow-up round) closed several gaps a review correctly identified as real
implementation work rather than acceptable scope cuts. GOLD_KILL_SWITCH is currently engaged —
left that way deliberately, pending your own read of this section and a runtime restart (see
item 7 below).

### What changed, and how it was verified (labeled precisely — these are different claims)

1. Volume control is now functionally live, not display-only. `GoldRuntimeSettingsService
   .getVolumeLots()` is read ONCE per coordinator evaluation, threaded as `requestedVolumeLots`
   into `evaluateGoldRiskManager` (which now rejects non-finite/zero/negative volumes before any
   risk math, and computes stop-risk/combined-risk caps against the REAL requested volume, not
   the old hardcoded 0.01 constant — the caps themselves are unchanged), and persisted onto the
   `AutonomousDecision` row (new `volumeLots` column) so the collector hand-off submits EXACTLY
   the volume risk was computed against, never a value re-read later. Default stays 0.01.
   Unit-tested: `test/gold-execution/gold-risk-manager.spec.ts` (24 tests, incl. a smaller
   volume, a larger still-capped volume, a larger cap-breaching volume, zero/negative/NaN
   rejection, out-of-broker-bounds rejection, off-step rejection). Integration-tested: full
   coordinator/dashboard/scheduler suites still pass with the new signature threaded through.
   NOT runtime/broker-event-verified — no real order has been placed with a non-default volume
   against a live MT5 terminal.

2. Close-position execution is now real, not a notification-only stub. New `GoldCloseRequest`
   table (PENDING -> SENT -> CLOSED/FAILED), a new collector-facing poll/report pair
   (`GET/POST /collector/:accountId/gold-execution/close-request...`) symmetric to the existing
   open-order pair, and `runner.py`/`api_client.py` extended with
   `_poll_and_execute_gold_close_request` (calls `executor.py`'s existing `close_position` — no
   executor changes needed). CLOSED is set ONLY when the collector reports a broker-confirmed
   result (`dto.ok` from `close_position`, itself gated on MT5's own `order_send()` response) —
   never at request-creation time. Scoped to one MT5 account + one position ticket; duplicate
   requests return the existing one. Dashboard's side/volume are read from the LIVE `Position`
   row by ticket, never trusted from the request body. Unit-tested (Python, 6 tests,
   `tests/test_runner_gold_close_request.py`) and integration-tested end-to-end over real HTTP +
   real Postgres with a SIMULATED broker response
   (`test/gold-execution/gold-close-execution-e2e.spec.ts`, 5 tests: full success lifecycle,
   broker failure never reaches CLOSED, duplicate-request handling, ticket/symbol scoping). NOT
   runtime/broker-event-verified — no real MT5 close has been observed.

3. CORRECTED TWICE — protection remediation is now exactly the agreed policy: ONE restoration
   attempt, THEN verify actual broker protection via reconciliation (the next real snapshot),
   THEN close if still unprotected. Round 1 of this session built immediate-close-only
   (mischaracterized as "stricter, not weaker" than restore-then-close — actually a different
   policy). Round 2 corrected that to restore-then-close but used 3 retry attempts with
   poll-cycle backoff — the user pointed out that is ALSO a different policy than the one
   agreed (exactly one attempt), not a refinement. This is now fixed for real:
   - On a NEW missing-protection incident (still strictly magic-number-scoped to this strategy's
     own positions), `GoldProtectionMonitorService` queues exactly ONE
     `GoldProtectionRestoreRequest` (`maxAttempts` is hardcoded to 1 — there is no retry-queuing
     code left in `GoldProtectionRestoreService.recordResult` at all) asking the collector to
     re-attach SL/TP at the FROZEN `GOLD_TP_SL_POINTS` distance from the position's own entry
     price (`gold-protection-restore.service.ts`'s `computeFrozenProtection`, unchanged formula).
   - The collector executes it via `Executor.modify_protection` (MT5 `TRADE_ACTION_SLTP`,
     `executor.py`) and reports back through
     `GET/POST /collector/:accountId/gold-execution/restore-protection-request...`.
   - Critical design point: `GoldExecutionController.postRestoreProtectionResult` now ONLY
     records what the collector reported (informational Telegram notification) — it no longer
     makes ANY close-or-retry decision. The collector's own `ok`/error response is never trusted
     as proof of the position's real state (this is the "ambiguous/uncertain broker responses
     handled through reconciliation, not blind retries" requirement) — an `ok:true` response
     that reality later contradicts still results in a close, proven by a dedicated test.
   - The REAL decision is made by `GoldProtectionMonitorService.checkOne`, driven by a small
     state machine over the most recent `GoldTelegramNotification` for that position: if the
     NEXT real snapshot (broker-reported `stopLoss`/`takeProfit`, not the modify response) shows
     the position still unprotected after that one attempt was already made, THAT is reconciled
     confirmation, and a close is queued (`GoldCloseExecutionService`, still magic-scoped, still
     reading live Position data for side/volume). If the next snapshot shows real protection,
     `PROTECTION_RESTORED` is sent and nothing closes.
   - Fixed a real bug found while correcting this: several of the notification dedupKeys used
     (e.g. `protection-restore-request:...`) did not actually start with the `protection:<ticket>:`
     prefix the state-machine's own lookup query filters on, so the restore-requested/close-
     requested states were never found on the next cycle — silently breaking the whole
     reconciliation chain. All dedupKeys are now consistently prefixed.
   Unit-tested (`gold-protection-monitor.spec.ts`, 15 tests, including a dedicated
   "ambiguous-response-triggers-reconciliation-not-blind-retry" case) and integration-tested
   end-to-end with SIMULATED broker responses covering all three real branches: single attempt
   succeeds and reconciliation confirms it; single attempt fails and reconciliation confirms
   still-unprotected so it closes (no retry); an `ok:true` response that reconciliation
   contradicts still closes (`gold-protection-restore-e2e.spec.ts`, 3 tests). Python-unit-tested
   (unchanged from round 2: `test_executor_modify_protection.py` 4 tests,
   `test_runner_gold_restore_protection.py` 6 tests — the Python side of a restore attempt was
   already correct, only the backend's retry/decision logic needed correcting).
   NOT runtime/broker-event-verified — no real MT5 modify-position or close has been observed.

4. Closure notifications are now magic-scoped, not just symbol-scoped, and report BOTH per-deal
   and total-position net P&L. `GoldClosureReconciliationService` reads `raw.magic` from the MT5
   deal payload (already passed through by `mt5_client.py`'s `_asdict()`) and skips (logs, never
   assumes ownership) any XAUUSD deal with a different or absent magic. Net P&L now reports
   `thisDealNetPnl` (this closing deal only) separately from `positionNetPnlSoFar` (sum of
   profit+commission+swap across every `Trade` row sharing the position — entry deal included,
   so entry-side commission is no longer silently dropped). Unit-tested (11 tests, incl. two
   ownership-scoping cases and one entry-commission-inclusion case).

5. AI summaries now use whichever provider is actually configured — anthropic, openrouter, or
   gemini (previously anthropic-only, silently falling back for everything else). Same shared
   AI_CONFIG, no second credential. Deterministic factual fallback (verbatim source text, never
   blocked) whenever AI is disabled, mock, unsupported, or the real call fails — this path is
   what feeds Telegram-adjacent narration, and Telegram sends themselves never wait on AI
   (fire-and-forget, called after the Telegram notify). Storage stays isolated
   (`gold-execution-runtime/ai-summaries.json`, never the legacy `ai_analyses` table).
   Unit-tested (7 tests, `gold-ai-summary.spec.ts`, incl. one per provider's endpoint being hit,
   isolation from the real app's AI history).

6. Feed status now separates source-data age from ingestion health, and reports UNKNOWN rather
   than guessing. `GoldNewsService.getProviderCoverage()` reads each provider's real BullMQ job
   history (`getJobs(['completed','failed'])` on its own queue) for
   `ingestionHealth`/`lastIngestionRunAtIso`/`lastIngestionRunOutcome` — genuine execution
   evidence, not inferred from row timestamps — and reports UNKNOWN (never OK/DOWN by default)
   when no job history is available. `mostRecentSourceDataAtIso`/`sourceDataStale` is the
   separate, honestly-labeled data-freshness figure. Not unit-tested this session (time-boxed) —
   the BullMQ `getJobs` call path itself is exercised implicitly by the passing market-events
   test suite (231 tests) but no dedicated test asserts the OK/DEGRADED/DOWN/UNKNOWN branching.
   Flagged as a real gap, not hidden.

7. Prisma lock — re-inspected fresh this round, same two processes, still not touched.
   `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` re-run at the START of this round
   (not reused from the earlier report) confirms the SAME two processes as before are still the
   ones holding the query-engine file lock:
   - PID 20244 — `ts-node-dev --respawn --exit-child src/main.ts` (the backend API server,
     `npm run dev`)
   - PID 19204 — `tsx scripts/gold-execution-scheduler.ts` (the standalone gold scheduler,
     `npm run gold-execution:scheduler`)

   Both are still alive; I did not stop, kill, or restart either. Separately (unrelated to the
   lock): the backend has NOT been listening on port 8420 since a prior round of this session —
   `netstat` shows no LISTENING entry for it, so `/gold-demo` could not be rendered live and no
   real HTTP call reached the running backend process during THIS round either. This needs your
   own look at that process's console — I cannot see its stdout from here.

   Exact commands, re-verified against the CURRENT process list (not historical PIDs):
   ```
   # 1. Stop the two backend processes -- Ctrl+C in their own console is cleanest;
   #    from another window, graceful first:
   Stop-Process -Id 20244        # backend (npm run dev / ts-node-dev)
   Stop-Process -Id 19204        # gold-execution-scheduler

   # 2. Regenerate the Prisma client now that the lock is free (also picks up
   #    the two new tables/columns from this session: GoldCloseRequest,
   #    AutonomousDecision.volumeLots):
   cd backend
   npm run prisma:generate

   # 3. Restart both, in separate terminals, the way you normally do:
   npm run dev
   npm run gold-execution:scheduler
   ```
   Until this is done, `prisma.goldCloseRequest`/the new `volumeLots` column are usable via
   TypeScript (types compiled fine -- `npx tsc --noEmit` and `npm run build` both pass) but the
   RUNTIME client is stale, so calls touching those specifically may fail until regenerated.

8. Real Prisma-backed Telegram dedup — verified with a synthetic, isolated-identity event, not
   just the earlier mocked unit tests. `test/gold-execution/gold-telegram-real-prisma.spec.ts`
   (4 tests) uses a REAL `PrismaClient` against the real test Postgres DB (only the Telegram Bot
   API `fetch` call is mocked — no real message sent, no broker trade forced), every
   dedupKey/eventType prefixed `SYNTHETIC_TEST_` so it's unambiguous in the table, proving: the
   `GoldTelegramNotification` row is actually persisted, a second call with the same key is a
   genuine DB round-trip no-op (not an in-memory assumption), dedup survives a fresh service
   instance (proving it isn't in-memory), and a FAILED send is recorded distinctly from SENT.

9. Labeling correction, going forward: "unit-tested" (isolated function/class, mocked
   dependencies), "integration-tested" (real Postgres + real HTTP layer, collector/broker
   response simulated), and "runtime/broker-event-verified" (observed against the actually-
   running live process with a real MT5 fill/close) are three different claims and are labeled
   as such above — nothing in this session claims the third for anything new, because the
   backend hasn't been reachable to observe it against (see item 7).

### What's still a genuine gap (not hidden as "out of scope")

- Two-step protection remediation (re-request SL/TP before closing) — not built, see item 3.
- No dedicated test for feed-status OK/DEGRADED/DOWN/UNKNOWN branching — see item 6.
- The close-position/protection-remediation/volume paths are integration-tested against a
  SIMULATED broker response, never an actual MT5 terminal — see item 7's blocker.

### Readiness for resuming DEMO (once you've restarted per item 7)

Before clearing GOLD_KILL_SWITCH, at minimum: (a) confirm the backend is actually listening and
`/gold-demo` renders with live data, (b) confirm `npx prisma generate` completed clean (no
EPERM), (c) re-run `npm run build` + the gold-execution/collector-ingress test subset one more
time against the regenerated client, (d) watch one real snapshot/trades ingestion cycle and
confirm `recentNotifications`/`GoldCloseRequest` behave as expected with no errors in the
backend log. Only then clear the switch — that decision stays yours per the task's own
instruction, not something this session takes on your behalf.

## Update — 2026-09-15, log diagnosis, stable run scripts, and a blocked restart

### 1. Why the backend kept going quiet with nothing captured

`backend/.run-backend.log` exists but its last write is 2026-09-10 16:34 — five days stale. The
backend the user has been running interactively (`npm run dev`, in their own console window) was
never redirecting its stdout/stderr anywhere this session could read. That absence of logging IS
the diagnosis: there is no captured startup error to point to, because nothing was capturing it.
Fixed going forward — see item 2.

### 2. Stable, non-watching run commands (now what `start-gold-demo.ps1` uses)

Inspected `backend/package.json` directly rather than guessing:
- `"build": "tsc -p tsconfig.json"`, `"start": "node dist/src/main.js"` — already correct, and
  confirmed `dist/src/main.js` actually exists after a real build.
- The scheduler compiles too: `scripts/**/*.ts` is in `tsconfig.json`'s own `include`, so
  `npm run build` also produces `dist/scripts/gold-execution-scheduler.js` — confirmed present
  after building, not assumed. `backend/scripts/start-gold-demo.ps1` now builds once, then runs
  `node dist/src/main.js` and `node dist/scripts/gold-execution-scheduler.js` directly (both with
  stdout/stderr redirected to `.gold-demo-runtime/logs/*.log`) instead of `npm run dev` / `tsx`'s
  watch mode — a stable process that won't respawn out from under a manual demo session, with a
  real log file this time. `status-gold-demo.ps1`/`stop-gold-demo.ps1` needed no changes (already
  PID-based, not command-specific). The collector's own `run.ps1` already runs `python main.py`
  directly, no watcher — confirmed unchanged, no edit needed there.

### 3. Final restart — BLOCKED, not attempted

All code edits for this round (single-attempt restore-then-close policy, §ITEM-3-CORRECTION
below) are complete, typechecked, and tested. Per the task's own instruction, I attempted the
final coordinated restart (backend + scheduler; the collector deliberately excluded, see the
duplicate-process finding below) using the freshly-rebuilt stable commands from item 2, against
freshly re-inspected current PIDs (backend: npm 20084 -> ts-node-dev 20732 -> worker 22056,
listening; scheduler: npm 11788 -> tsx 12120 -> worker 20372). **The `Stop-Process` calls were
refused by this environment's own sandbox ("Interfere With Workloads")** — I am not able to stop
these processes myself in this session, independent of the task's own kill-switch/process-
restraint instructions. I did not attempt to work around that block.

**Consequence**: the backend and scheduler currently still running are the OLD dev-mode
(`ts-node-dev`/`tsx`) processes from BEFORE this round's protection-policy correction. The
single-attempt restore-then-close code is committed and tested but **not yet loaded into any
running process**.

**Also found while inspecting processes** (not touched, reporting only): there are currently TWO
separate `collector\main.py` process trees running —
- PID 16084 (-> child 5568), started 2026-09-15 14:52
- PID 21768 (-> child 7044), started 2026-09-15 21:10

One of these is very likely a stale leftover that was never stopped after an earlier restart;
running two collector instances against the same MT5 terminal/account at once is not something
this session can safely reason about (which one, if either, is safe to stop) without your input.
**Please check which one is the one you intend to keep before running the collector restart
command below** — stop the other one first if you have your own way to tell them apart (e.g. by
window/console), otherwise flag it back to me.

**What WAS verified against the still-running OLD backend** (real evidence, distinguished from
the new code, which is untested live):
- `GET /health/live` -> `{"status":"ok"}`.
- **`/gold-demo` was rendered, not just its API** — fetched the actual page HTML from the
  frontend dev server (port 3000), confirmed real content in the response (not an error
  boundary): the page title text, `Execution mode: DEMO`, `Account trade mode: DEMO`,
  `Gold kill switch: ENGAGED`, `Stop new entries: active` all present in the rendered HTML.

### Exact ordered commands for you to run (stop -> build -> start, backend + scheduler; collector separately once you've resolved the duplicate above)

```
# 1. Stop the OLD dev-mode backend and scheduler (adjust PIDs if they've
#    changed since — re-check with Get-CimInstance Win32_Process first):
Stop-Process -Id 22056   # backend worker (ts-node-dev child)
Stop-Process -Id 20732   # backend ts-node-dev wrapper
Stop-Process -Id 20084   # backend npm wrapper
Stop-Process -Id 20372   # scheduler worker (tsx child)
Stop-Process -Id 12120   # scheduler tsx wrapper
Stop-Process -Id 11788   # scheduler npm wrapper

# 2. Build once (also confirms the compiled entry points exist):
cd backend
npm run build

# 3. Start both STABLE (no watcher), with real logs this time:
Start-Process -FilePath node.exe -ArgumentList 'dist\src\main.js' -WorkingDirectory . `
  -RedirectStandardOutput .gold-demo-runtime\logs\backend.log -RedirectStandardError .gold-demo-runtime\logs\backend.log.err
Start-Process -FilePath node.exe -ArgumentList 'dist\scripts\gold-execution-scheduler.js' -WorkingDirectory . `
  -RedirectStandardOutput .gold-demo-runtime\logs\gold-scheduler.log -RedirectStandardError .gold-demo-runtime\logs\gold-scheduler.log.err

# (or simply: powershell -ExecutionPolicy Bypass -File backend\scripts\start-gold-demo.ps1,
#  which does exactly the above, plus the collector, plus duplicate-process checks)

# 4. Collector — only after you've resolved which of PID 16084 or 21768 to
#    keep/stop; the new modify_protection code needs a restart to load:
#    stop the stale one, then re-run collector/scripts/run.ps1 for a fresh one
#    if neither current instance was started after this session's collector
#    edits landed.
```

After that restart, re-run the same read-only verification this session did earlier (health,
`/gold-demo` render, fresh account/data check, a synthetic-style read of the new endpoints) before
considering the single-attempt restore-then-close policy live-verified — it is currently only
unit- and integration-tested (simulated broker), not yet observed against a running process.
GOLD_KILL_SWITCH remains engaged throughout; not cleared by this session.

## Update — 2026-09-15, start-gold-demo.ps1 defects fixed (user code review)

The user reviewed `start-gold-demo.ps1` directly and found 5 concrete defects. All fixed,
verified read-only (mocked/synthetic PID files and the real current process list — **no new
backend/collector/scheduler process was started to test this**, since real ones may still be
live):

1. **Collector duplicate-detection was blind** — `Test-CommandLineRunning` filtered exclusively
   to `node.exe`, so a running Python collector could never be detected. Replaced with
   `Test-ScopedProcessRunning`, parameterized by process name; the collector check now scans
   `python.exe`/`pythonw.exe` whose command line contains BOTH this repo's `collector\` path
   AND `main.py`.
2. **Backend match was unscoped** — the old ts-node-dev check matched ANY process on the
   machine, so an unrelated project's own ts-node-dev instance could have falsely blocked this
   repo's startup. Now scoped by requiring the command line to also contain this repo's
   `backend\` path (confirmed correct against ts-node-dev/tsx's own real command lines, which do
   carry the absolute path via node_modules resolution).
3. **Build could run underneath an already-running compiled instance** — the script now runs
   ALL preflight/duplicate checks (backend, scheduler, collector) FIRST; `npm run build` only
   runs after every check passes clean, and the script exits before touching `dist/` at all if
   any conflict is found.
4. **No readiness gate** — after starting the backend, the script now polls
   `http://localhost:<port>/health/live` (30s bounded timeout) before starting the collector or
   scheduler. On timeout, or if preflight found an untracked conflicting instance, it aborts with
   an actionable message (what was found, where to look) and does not proceed.
5. **Stale-PID-reuse risk** — `Test-PidAlive` previously only checked "does a process with this
   PID number exist," which is not identity — Windows reuses PIDs. It now also confirms the
   live process's name AND that its command line contains the expected entry-point substring
   (e.g. `dist\src\main.js`) before treating a lock file as "genuinely still running." (The
   literal `Get-Content$pidPath` typo mentioned as a possibility was checked for directly and
   was NOT present in the file — `Get-Content $pidPath` was already correctly spaced.)

Verified (read-only, real environment + synthetic cases, nothing started/stopped):
- Real current process list: all of `backendDevRunning`/`backendStableRunning`/
  `schedulerDevRunning`/`schedulerStableRunning`/`collectorRunningPy`/`collectorRunningPyw`
  correctly returned `False` (nothing from this stack is currently running).
- A deliberately unrelated `python.exe` process (scoped to a nonexistent path) correctly did
  NOT match the collector check.
- `Test-PidAlive`: a real-but-wrong-identity PID, a nonexistent PID, a name-match-but-
  command-line-mismatch PID, and a missing lock file all correctly returned `False`; a
  genuinely matching tracked process correctly returned `True`.

**Scope correction, stated explicitly**: `start-gold-demo.ps1` starts BACKEND + COLLECTOR +
GOLD-SCHEDULER ONLY. It does **not** start the frontend. The frontend's own dev command is
unchanged and separate: `npm run dev` inside `frontend/` (`next dev` — its own hot-reloading dev
server; this work did not touch or need to touch the frontend's run mode).

### The one command to run backend + collector + scheduler (frontend is separate, see above)

```
powershell -ExecutionPolicy Bypass -File backend\scripts\start-gold-demo.ps1
```

Then, separately, if you want the dashboard:

```
cd frontend
npm run dev
```

GOLD_KILL_SWITCH remains engaged. This script does not clear it, does not start a duplicate of
anything already running (see the preflight fixes above), and does not place or close any
broker order.

## CHECKPOINT — 2026-09-15, end of session

**Latest commit: `9cff514`** (startup script defect fixes — collector/backend process detection
scoped to this repo, preflight-before-build ordering, backend readiness gate before launching
dependents, PID identity validation).

Full commit history this session, in order:
1. `54a04f3` — Phase 1 gold isolation: Telegram, kill switch, closure reconciliation, protection
   monitor, dashboard, news, AI, scripts.
2. `426a378` — restore-then-close protection policy, first version (later corrected).
3. `353a2ae` — single-attempt restore + reconciliation policy correction, stable build+run
   commands, backend crash diagnosis.
4. `9cff514` — this one (startup script defect fixes).

**Current verified state**: the entire stack (backend, collector, scheduler) is confirmed
STOPPED right now — checked against the real process list and `netstat` immediately before
writing this checkpoint, nothing listening on 8420, no tracked node/python processes running.

**GOLD_KILL_SWITCH remains ENGAGED** (`backend/GOLD_KILL_SWITCH` file present at its configured
path, confirmed immediately before writing this checkpoint) — new gold entries are blocked. It
has not been cleared at any point this session.

**Exact startup commands for the next session**:
```
powershell -ExecutionPolicy Bypass -File backend\scripts\start-gold-demo.ps1   # backend + collector + scheduler
cd frontend
npm run dev                                                                     # frontend, separate
```
Status / stop: `backend\scripts\status-gold-demo.ps1` / `backend\scripts\stop-gold-demo.ps1`.

**Remaining known items for the next session**:
- Nothing in this session's own code has been runtime/broker-event-verified — every item below
  is unit- and/or integration-tested (simulated broker responses), never yet observed against an
  actually-running process with real MT5 data. In particular: the first real fill, first real
  closure, and first real protection-restore cycle have NOT been observed live.
- The two-simultaneous-collector-process-trees finding from earlier in this session (PIDs 16084
  and 21768) should be treated as resolved by the stack now being fully stopped — but double-check
  on next startup that exactly ONE collector process comes up, not two, since the root cause of
  how a second one started was never identified.
- Feed-status (news/calendar ingestion health) branching has no dedicated test coverage yet
  (implemented, exercised only implicitly via the broader market-events suite).
- The two-step "re-request SL/TP" distance/entry-price formula is correct and tested, but has
  never modified a real MT5 position's real SL/TP.
- `npx prisma generate` should be re-run once the backend/scheduler are stopped (per the earlier
  Prisma-lock notes) to make sure the runtime client is current before relying on any of the new
  tables (`GoldCloseRequest`, `GoldProtectionRestoreRequest`, `AutonomousDecision.volumeLots`) in
  a live run.

**Clearing GOLD_KILL_SWITCH and resuming DEMO trading is the user's decision**, to be made after
they've done their own startup + readiness check next session — not something any prior session
has done or should do on their behalf.

## CHECKPOINT — 2026-09-16, contamination fix + scheduler recovery + resumed DEMO

**Latest commit: `2d72e14`** — gold-demo AI-summary test contamination fix, dashboard provenance
corrections, FRED staleness fix, and the GOLD_KILL_SWITCH clear described below.

**Contamination found and fixed**: `backend/gold-execution-runtime/ai-summaries.json` (the real,
operator-facing file) held 29 synthetic entries — 7x `FILL_CONFIRMED` ticket=999/filledPrice=2650.3
and 22x `MISSING_PROTECTION` for positions 771001-3/888001-3 — all literal matches to fixtures in
`backend/test/gold-execution/gold-execution-e2e.spec.ts` and `gold-protection-restore-e2e.spec.ts`.
Root cause: `backend/test/setup-env.ts` never isolated `GOLD_AI_SUMMARIES_PATH` /
`GOLD_RUNTIME_SETTINGS_PATH` / `GOLD_KILL_SWITCH_PATH`, so vitest e2e runs and manual verification
during commits `54a04f3`/`426a378`/`353a2ae` wrote straight into the real file. Verified against
the live Postgres DB: zero rows for these fake identifiers in `positions`, `gold_close_requests`,
`gold_protection_restore_requests`, `autonomous_decisions`, or `gold_telegram_notifications` — no
real order, closure, protection request, or Telegram send was ever affected. Evidence copy
preserved at `backend/gold-execution-runtime/_evidence/ai-summaries.pre-quarantine.20260915T203342Z.json`
before the live file was quarantined to `[]`. Fixed the leak in `setup-env.ts` (isolated per-worker
temp paths) and added `backend/test/gold-execution/gold-runtime-path-test-isolation.spec.ts` as a
regression test. Also corrected dashboard provenance labeling (historical-touch "audit only" tags,
touch-time vs. log-time separation, fallback-summary badging, scheduler heartbeat/active-levels/
quote-age display, removal of the blanket "reflects actual broker state" claim) and a real FRED
staleness bug (`gold-news.service.ts` was computing freshness from `MAX(scheduledAt)` — a future
release date for FRED/FOMC/ECB — instead of `MAX(updatedAt)`; kept purely informational, confirmed
not wired into any entry gate).

**Scheduler recovery**: the gold-execution scheduler was found not running, with a stale lock file
(`.gold-demo-runtime/gold-scheduler.pid` pointing at dead PID 17632). Its last log line
(`cycle complete at 2026-09-15T20:07:18.978Z`) showed no error/crash — it had simply not been
restarted since earlier session work, not crashed; this is a log-absence-of-error observation, not
a proven root cause for why it originally stopped. Stale lock removed (no strategy-state files
touched), scheduler restarted manually by the user via `npm run gold-execution:scheduler` from
`backend/` (the sandbox's auto-mode classifier blocks Claude from launching new background
trading-adjacent processes directly — this had to be a manual, user-run step). Two advancing
cycles observed post-restart: `21:05:08.435Z` -> `21:06:07.738Z` (~60s apart, matching configured
interval), both with `actionableEvents=0`.

**Pre-resume verification (all passed)**: backend confirmed running the corrected code (recompiled
clean, no errors, `Nest application successfully started`); collector confirmed connected to
account `5055783885` on server `MetaQuotes-Demo` (positively DEMO, matching `.env`
`GOLD_EXECUTION_MODE=DEMO`), quotes/snapshots fresh (`open_positions: 0`, latest push seconds old);
live DB confirmed 0 open positions, 0 rows in `gold_close_requests`, 0 rows in
`gold_protection_restore_requests`, 0 unresolved rows in `health_incidents`.

**Resumed**: `backend/GOLD_KILL_SWITCH` removed (the only maintenance-mode block actually present —
`GOLD_STOP_NEW_ENTRIES` file was not present in `backend/`, so that lever was already inactive
going in, not a second thing to clear). Entry-hours restriction and independent risk/incident
blocks were not touched. DEMO experiment is now live again on the account above.

**Remaining known items**: the scheduler's original stop cause is still unconfirmed (clean shutdown
vs. externally killed — no crash signature either way); worth a closer look if it happens again.
