# Gold execution — startup / shutdown / recovery procedure

## Prerequisites before ANY activation
1. **Restart the collector** so it runs the corrected `api_mapper.py` trade_mode mapping (see
   `IMPLEMENTATION_CHECKPOINT.md` / `DEMO_HANDOFF.md` for why this is currently required and
   still outstanding as of this doc's writing).
2. Confirm exactly ONE `python main.py` collector process is running (see "Duplicate process
   check" below — two were found running simultaneously during this task and one had to be
   stopped manually; this environment's process-management restrictions prevented an agent
   from doing this itself).
3. Query the freshly-restarted collector's pushed `AccountSnapshot.tradeMode` for the MT5
   account directly and confirm it reads `"DEMO"` before setting `GOLD_EXECUTION_MODE=DEMO`.

## Starting the system
```powershell
# 1. Collector (from collector/)
cd C:\Users\user\Desktop\trading-monitor-autonomous\collector
.\.venv\Scripts\python.exe main.py
# Set GOLD_EXECUTION_ENABLED=true in collector/.env only once you intend the collector to
# actually poll and execute gold orders (backend must be in DEMO mode too - see below).

# 2. Backend (from backend/)
cd C:\Users\user\Desktop\trading-monitor-autonomous\backend
npm run dev
# Set GOLD_EXECUTION_MODE=OFF|SHADOW|DEMO and (optionally) GOLD_STOP_NEW_ENTRIES=true in
# backend's environment before starting, or export them in the same shell that runs any
# gold-execution-watch invocation.

# 3. One gold watch cycle (manual, NOT scheduled automatically — see gold-execution-coordinator
#    .service.ts's own header comment for why):
cd C:\Users\user\Desktop\trading-monitor-autonomous\backend
npm run gold-execution:watch
```

A real scheduler now exists — `npm run gold-execution:scheduler` (from `backend/`) runs the
watch cycle every `GOLD_SCHEDULER_INTERVAL_SECONDS` (default 60), restart-safe, single-instance
locked. It is not started automatically by anything else; run it explicitly once you intend
continuous operation. Ctrl+C / SIGTERM stops it cleanly.

**Before relying on it live, verify XAUUSD M1 freshness properly** (the raw stored timestamp
is broker-mislabeled, NOT true UTC):
```powershell
cd C:\Users\user\Desktop\trading-monitor-autonomous\backend
npx tsx -e "import {wallClockToUtc} from './src/research/confirmed-retest-v2/time'; import {PrismaClient} from '@prisma/client'; (async()=>{const p=new PrismaClient(); const b=await p.historicalCandle.findFirst({where:{symbol:'XAUUSD',timeframe:'M1'},orderBy:{openTime:'desc'}}); const trueUtc=wallClockToUtc('EET', b!.openTime.getTime()); console.log('true UTC open:', new Date(trueUtc).toISOString(), 'staleness min:', (Date.now()-trueUtc)/60000); await p.$disconnect();})()"
```
A staleness of more than a few minutes means the collector needs more time to resync before
trusting entry-window/signal decisions — do not activate DEMO mode while this is stale.

## Verifying health
- `GET /research/gold-execution-status` (dashboard token required) — mode, account trade_mode,
  occupancy, open positions, closed trades, recent decisions, data freshness.
- `GET /research/xauusd-confirmed-retest` — v1/v2 research-only status (unaffected by gold
  execution).
- Collector log (`collector/logs/collector_post_fix.log` or wherever the current run logs to)
  — look for `"gold_execution_enabled": true` in the startup line if gold polling is meant to
  be active.

## Duplicate-process check (do this every time before trusting "no order will double-fire")
```powershell
Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*main.py*' } | Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine
```
**Corrected understanding (per direct user correction)**: it is normal to see TWO rows here —
one `collector/.venv/Scripts/python.exe main.py` (the real one) and one
`...Python311\python.exe main.py` whose `ParentProcessId` matches the first one's `ProcessId`
(the MetaTrader5 IPC bridge's own helper subprocess) — that pair is a single process TREE, not
two independent duplicate collectors, and should NOT be treated as a problem. What to actually
check for is more than one process tree with the SAME `main.py` and DIFFERENT
`ParentProcessId=0`-or-unrelated roots (i.e., two separately-launched top-level `main.py`
invocations) — that genuinely would be a duplicate and both instances would independently poll
for and could both claim/execute pending orders.

## Stopping
```powershell
# Stop the collector (find its PID with the command above)
Stop-Process -Id <collector-pid> -Force
# Stop the backend / frontend dev servers with Ctrl+C in their own terminals, or:
Get-Process -Name node | Where-Object { $_.Path -like '*trading-monitor-autonomous*' } | Stop-Process -Force
```

## Kill switch (stops new entries immediately, independent of the above)
- File-based: create the file at `AUTONOMOUS_KILL_SWITCH_PATH` (defaults to `KILL_SWITCH` in
  the backend's working directory). `isKillSwitchActive()` is checked by both the EURUSD and
  gold risk gates on every evaluation — no restart needed, it is read fresh every time.
- Coarser, gold-only: set `GOLD_STOP_NEW_ENTRIES=true` in the backend's environment — blocks
  new gold entries specifically (rechecked immediately before every send) while leaving
  EURUSD's own kill switch/mode untouched.
- Neither switch closes an already-open position by itself; closing an open gold position
  uses `collector/app/executor.py`'s existing `close_position` with `GOLD_MAGIC_NUMBER` — no
  dedicated HTTP route for this exists yet (tracked in `IMPLEMENTATION_CHECKPOINT.md`).

## Restart recovery (what happens automatically)
- `GoldWatchStore` persists confirmed-retest-v2's replay state and the set of event IDs
  already acted on (`backend/research-state/gold-live-watch/gold-watch-state.json` by
  default) — a restart resumes from there rather than re-evaluating already-acted-on events as
  new signals.
- `GoldAccountStateService.resolveOccupancy` re-derives the one-position lock from the
  collector-synced `Position` table and any in-flight `AutonomousDecision` rows on every call
  — it does not depend on any in-memory state surviving a restart.
- A `SENT`-but-never-resolved `AutonomousDecision` row (collector claimed it, then crashed
  before reporting back) stays occupying the one-position slot until reconciled — this is the
  same posture the EURUSD path already has, not a new gap introduced by gold.
