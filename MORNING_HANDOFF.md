# Morning Handoff — 2026-09-15

## 2026-09-15 addendum: candle-sync lag fixed (follow-up task, after the first handoff)

The "unresolved issue #1" below (live candle-sync lag, documented but not fixed) **is now
fixed** — narrowly, collector-side only. Full detail, live before/after evidence, and exact
scope in `backend/research-output/xauusd-h4-confirmed-retest-v1/verification/candle-sync-fix/FIX_REPORT.md`.
One-paragraph summary: `collector/app/mt5_client.py`'s `get_candles()` was comparing a true-UTC
query bound against each bar's broker-mislabeled raw epoch, silently excluding roughly the
broker's own UTC-offset (~3h right now) worth of the most recent bars while looking fresh.
Fixed by converting the query bound the same way `get_deals_since()` already did — **the stored
`open_time` value itself is deliberately left unchanged** (still the raw mislabeled epoch,
matching the millions of already-stored rows and what `data-source.ts`'s `wallClockToUtc`
already expects); only the sync's own latency was broken, not the data's correctness once
synced. Live proof: the newest XAUUSD M1 bar went from ~3h1m genuinely stale (while displaying
as 50s old) to ~1m50s genuinely stale. 2 new regression tests; collector suite 189/189 (was
187/187). The two running collector processes (one an unexplained stray duplicate) were stopped
and one fresh one started on the fixed code — confirmed live it now syncs within ~2 minutes of
true UTC. Winter (EET, UTC+2) offset remains unverified by a live measurement, exactly as the
prior verification report already documented — not newly resolved by this fix. No strategy code,
no signal rule, and no execution path was touched; `h4-trend-h1-breakout-v1`'s own separate,
already-documented window-shift issue is unaffected (this fix changes sync latency, not what
`open_time` stores). The confirmed-retest zero-level conclusion is unaffected and not marked
provisional — it read only already-synced historical data at run time.

## 2026-09-15 second addendum: h4-trend-h1-breakout-v1 entry-window shift — still affected, not fixed

Follow-up question: does "unaffected by the collection fix" mean the entry-window shift is
resolved? No — checked directly, separately. **Still affected, not fixed, not previously
misdiagnosed.** Full detail:
`backend/research-output/xauusd-h4-confirmed-retest-v1/verification/candle-sync-fix/ENTRY_WINDOW_SHIFT_STATUS.md`.

Summary: `backend/src/trend-breakout/backtest.ts:133` and `:375` call
`isWithinEntryWindow(candle.openTime)` with `candle.openTime` read straight from
`historical_candles.open_time` — still the raw broker-mislabeled value (deliberately unchanged
by the collection fix, see the first addendum above) — with no correction applied anywhere in
`src/trend-breakout/` or `src/market-data/` (confirmed by grep: no `wallClockToUtc`/`EET`
reference exists there, unlike the confirmed-retest module's `data-source.ts`). Proved live
against the real `schedule.ts` functions (`entry_window_shift_evidence.ts` /
`.out.txt`): a concrete stored bar time evaluates as "within window" via the code path the
backtest actually uses, while the true UTC instant it corresponds to is actually outside the
window — a genuine boundary-crossing mismatch, not a hypothetical one. Any
`h4-trend-h1-breakout-v1` backtest result reporting session/time-of-day-dependent statistics
should be treated as **provisional**. The live coordinator (`trend-breakout-coordinator.service.ts`)
carries the same latent defect but is confirmed unreachable — no scheduler, controller, or script
anywhere calls `evaluateAll()` (matches `TREND_BREAKOUT_SPEC.md`'s own documented item 5) — so it
is dormant, not actively wrong in production. No winter offset inferred, no strategy parameter
changed, no broad suite rerun, execution untouched. The confirmed-retest zero-level finding is
unrelated and unaffected — that module has its own, already-correct EET conversion layer.


Branch `research/xauusd-h4-confirmed-retest-v1`. Everything below is local commits — nothing
pushed, nothing deployed, no order placed or capable of being placed. **v1's frozen rules and
its zero-sample conclusion are unchanged.** No parameter was tuned, no new strategy version was
created, no broker execution was enabled.

## Completed tasks and local commits

| # | Task | Commit |
|---|---|---|
| 1 | Verification pass: timestamp basis resolved, zero-level result re-derived independently, three flaky tests investigated (not dismissed) | `5abcfab` |
| 2 | Gold collection alongside EURUSD (per-symbol timeframes, per-symbol live quotes, bounded first-sync) | `8a49cff` |
| 3 | Restart-safe, single-instance watch-only watcher | `8a49cff` (code), verified live this session |
| 4 | Dashboard shows live, honest operational status; "No sample" instead of 0% | `60178bd` |
| 5 | Focused tests for the collector-ingress `liveTicks[]` change | `f10c9c9` |
| — | Re-ran the study on the newly collected gold data | latest commit (`Re-run confirmed-retest study on freshly collected gold data...`) |

Full detail and evidence for task 1: `backend/research-output/xauusd-h4-confirmed-retest-v1/verification/VERIFICATION_REPORT.md`.

## What was actually run, and the result

- **Timestamp basis: RESOLVED.** Stored MT5 bar/tick epochs are broker-server wall clock
  (EET: UTC+2 winter / UTC+3 summer), confirmed live and independently of the historical
  pattern (a position-based fetch with no datetime argument reads +3.000h vs an externally
  verified clock, right now). v1's existing conversion was already correct. **New finding, not
  fixed:** the live incremental candle sync (`collector/app/runner.py` → `mt5_client.py`'s
  `copy_rates_range` date bounds) runs a rolling ~2–3h behind while looking fresh — documented
  in the verification report, left for a future session as instructed (no strategy/collector
  behavior was changed to fix it — the fresh-quote and per-cycle candle sync both still work,
  they're just missing the newest few hours until that specific bug is fixed).
- **Zero-level result: RE-CONFIRMED**, independently and on newer data. Hand-written SQL (not
  reusing the TS engine) reproduces the same pivot/rejection counts and the same single
  exact-price pair (713 H4 bars apart, outside the 5–120 window). Re-running the full study
  after collecting 3 more days of real gold data still finds zero levels.
- **Full-suite flakiness:** the 3 previously-intermittent tests were run to completion 4 times
  (2× on the pre-change baseline commit, 2× on the current commit) under the same concurrent
  dev-server load that produced the original failures — 0 failures on either commit, all 4
  times. Treated as pre-existing flakiness, evidenced, not assumed.
- **Gold collection: LIVE**, as of this session. `collector/.env` now has
  `CANDLE_SYMBOLS=EURUSD,XAUUSD` and `CANDLE_TIMEFRAMES_XAUUSD=M1,M5,M15,M30,H1,H4,D1`; the
  collector was restarted and confirmed pulling real XAUUSD M1 through D1 bars and a live
  XAUUSD bid/ask every ~10s, alongside EURUSD unchanged. Historical tick backfill was **not**
  retried (still known-failing; out of scope, and the instruction said not to retry it).
- **Watch-only watcher: implemented and bounded-run-verified**, not left running. Verified this
  session, live, against the real database: bootstrap, idempotent resume (no duplicate journal
  entries, no state change on a no-new-data cycle), the single-instance lock correctly refusing
  a concurrent second instance, and — found live, not hypothetically — a stale lock left by a
  hard-killed process (an artifact of this Windows/Git-Bash test setup's unreliable SIGTERM
  delivery, not the watcher's own code) was taken over immediately on the next run rather than
  waiting out the stale-timeout, exactly as designed.
- **Dashboard:** rendered live against the real backend/database (fetched over HTTP, not
  simulated) — shows order-execution status, timestamp-verification status with a live
  re-check taken at page load, last stored M1 close and its staleness with units, per-symbol
  live quotes with receipt age, collector/MT5 connection state, and "No sample" instead of a
  fabricated 0% win rate.

## One thing I broke and fixed mid-session (disclosed, not hidden)

Cleaning up the two temporary `git worktree`s I created for the flakiness comparison
accidentally deleted `backend/node_modules/.bin` and `backend/node_modules/.prisma` in the
*real* checkout (a Windows/git-worktree junction-removal interaction, not anything in this
repo's own code). I noticed immediately from a broken `tsx` invocation, ran `npm install` (no
`package-lock.json` change — confirmed via `git diff`, so no dependency actually changed) and
`npx prisma generate` (stopping/restarting the backend dev server to release its file lock on
the query-engine DLL), then re-ran the full confirmed-retest suite (111/111) and the collector
suite (187/187) to confirm nothing else was affected. Backend and collector are running again
with no functional change from before the incident.

## Unresolved issues and their exact impact

1. ~~Live candle-sync lag bug (§1.3 of the verification report), not fixed.~~ **FIXED in the
   2026-09-15 follow-up** — see the addendum at the top of this file and
   `verification/candle-sync-fix/FIX_REPORT.md`. Collector-only change (`mt5_client.py`'s
   `get_candles()` query bound), live-proven, stored `open_time` format unchanged.
2. **Winter broker offset (+2h) is confirmed only by historical arithmetic, not a live
   measurement** (today is deep in EU summer DST). Left explicitly unresolved rather than
   assumed — see the verification report §1.5.
3. **`h4-trend-h1-breakout-v1`'s entry window is measurably shifted** by the same timestamp
   basis (quantified, not fixed, per the task's own instruction not to change strategy code).
4. **No live XAUUSD quote young enough for the shadow-entry gate's 5-second freshness bar was
   captured in a stored watch cycle** during today's runs (quotes seen live were fresh; whether
   a quote-gated shadow decision ever actually fires depends on a level forming first, which
   hasn't happened).
5. **No demo equity snapshot exists for this account** — the $1,000/$10,000 paper scenarios
   remain labeled assumptions, as before.

## Commands

**Start collection** (already running as of this handoff — only needed after a restart):
```powershell
cd C:\Users\user\Desktop\trading-monitor-autonomous\collector
.\.venv\Scripts\python.exe main.py
```
Requires `collector/.env`'s `CANDLE_SYMBOLS=EURUSD,XAUUSD` and
`CANDLE_TIMEFRAMES_XAUUSD=M1,M5,M15,M30,H1,H4,D1` (already set).

**Watch-only, one cycle:**
```powershell
cd C:\Users\user\Desktop\trading-monitor-autonomous\backend
npm run confirmed-retest:watch
```

**Watch-only, persistent** (one command; not currently running — start it if you want continuous
forward observation):
```powershell
cd C:\Users\user\Desktop\trading-monitor-autonomous\backend
npm run confirmed-retest:watcher
```
Bounded test form: `npm run confirmed-retest:watch -- --max-cycles 3 --interval-seconds 30`.

**Re-run the historical study** (safe to re-run any time; read-only against the database):
```powershell
cd C:\Users\user\Desktop\trading-monitor-autonomous\backend
npm run confirmed-retest:study
```

**Dashboard:** already running — http://localhost:3000/research/xauusd-confirmed-retest
(backend on :8420 must be up).

## Processes currently running (left up, as they were found)

- `autonomous-trading-postgres`, `autonomous-trading-redis`,
  `autonomous-trading-postgres-test`, `autonomous-trading-redis-test` — Docker, unchanged.
- Backend (`npm run dev`, NestJS, port 8420) — was already running this session; restarted once
  mid-session (see the disclosed incident above) and once more automatically by `ts-node-dev`'s
  own file-watch on the two files this task edited. Currently up.
- Frontend (`npm run dev`, Next.js, port 3000) — running, unchanged since it was started.
- Collector (`python main.py`) — running, restarted twice total: once (prior handoff) to pick up
  `CANDLE_SYMBOLS=EURUSD,XAUUSD`, once more (this addendum) to deploy the candle-sync fix; also
  killed an unexplained stray duplicate `python main.py` process found running alongside it
  (PID 10524) — both were stopped and one fresh process started. Currently syncing both symbols,
  execution disabled, log at `collector/logs/collector_post_fix.log`.
- **The watch-only watcher is NOT currently running** — per instruction, it was verified with
  bounded runs and then stopped, not left as a background service. No OS scheduled task or
  service was installed for it, or for anything else.

## Confirmation: no broker orders, no strategy changes

- `AUTONOMOUS_EXECUTION_ENABLED=false` throughout — verified in every fresh collector startup
  log this session, and by the config test suite (asserts it stays `false` unless the literal
  string `"true"` is set; `"yes"` etc. do not enable it).
- The one place gold's contract metadata was read (`capture_contract_metadata.py`) explicitly
  never imports or calls any `order_*` MT5 function — checked directly in that file.
- `h4-trend-h1-breakout-v1` and `weekly-h4-sr-v1` source code is untouched this session (the
  breakout window-shift finding was measured by calling its own existing function, not by
  editing it).
- No parameter of `xauusd-h4-confirmed-retest-v1`'s frozen spec was changed; no new strategy
  version exists.
