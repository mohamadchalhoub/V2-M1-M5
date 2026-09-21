# Gracefully stops ONLY the PIDs recorded by start-xauusd-rsi.ps1. Never a
# blanket node/python kill, and never touches a process this script did not
# start.
#
# Order matters. The kill switch is engaged FIRST, so no entry can slip
# through while the processes are coming down, and the strategy watch is
# stopped BEFORE the backend, so it can save its state and release its lock
# against a backend that is still answering.
#
# This script NEVER closes a broker position. It reports them instead,
# because the moment these processes stop, so does all monitoring: no
# protection checks, no closure reconciliation, and no Friday liquidation.
#
# Usage: powershell -ExecutionPolicy Bypass -File backend\scripts\stop-xauusd-rsi.ps1
$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backendRoot = Join-Path $repoRoot 'backend'
$runtimeDir = Join-Path $repoRoot '.xauusd-rsi-runtime'

# --- 1. Engage the kill switch before stopping anything ---
$switchPath = Join-Path $backendRoot 'XAUUSD_RSI_KILL_SWITCH'
$envSwitchLine = Get-Content (Join-Path $backendRoot '.env') -ErrorAction SilentlyContinue | Where-Object { $_ -match '^XAUUSD_RSI_KILL_SWITCH_PATH=' }
if ($envSwitchLine) {
    $parsed = ($envSwitchLine -split '=', 2)[1].Trim()
    if ($parsed) { $switchPath = $parsed }
}
if (-not (Test-Path $switchPath)) {
    "stopped via stop-xauusd-rsi.ps1 at $(Get-Date -Format o)" | Set-Content -Path $switchPath
    Write-Host "Engaged the strategy kill switch at $switchPath before stopping anything."
} else {
    Write-Host "Strategy kill switch already engaged at $switchPath."
}

# Direct and indirect children of one specific pid. Used ONLY to clean up
# processes our own tracked process spawned; see Stop-Component.
function Get-Descendant-Pids($rootPid) {
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
    $found = New-Object System.Collections.Generic.List[int]
    $frontier = @([int]$rootPid)
    while ($frontier.Count -gt 0) {
        $next = @()
        foreach ($parent in $frontier) {
            foreach ($proc in $all) {
                if ($proc.ParentProcessId -eq $parent -and -not $found.Contains([int]$proc.ProcessId)) {
                    $found.Add([int]$proc.ProcessId)
                    $next += [int]$proc.ProcessId
                }
            }
        }
        $frontier = $next
    }
    return $found
}

# --- 2. Stop only our own tracked PIDs, gracefully. Nothing is force-killed. ---
function Stop-Component($name, $pidFile) {
    $pidPath = Join-Path $runtimeDir $pidFile
    if (-not (Test-Path $pidPath)) {
        Write-Host "$name : no lock file, nothing to stop."
        return
    }
    $storedPid = Get-Content $pidPath -ErrorAction SilentlyContinue
    $proc = Get-Process -Id $storedPid -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Host "$name : lock file present but pid $storedPid is not running - removing stale lock."
        Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
        return
    }
    Write-Host "Stopping $name (pid $storedPid) ..."
    # Children are recorded BEFORE the parent goes, because once it exits the
    # parent link is gone and an orphan can no longer be attributed to it.
    #
    # This matters: the collector re-execs itself, and stopping only the
    # tracked pid left the child alive. The next start then refused with
    # "already running but not tracked by this script's lock file".
    #
    # The filter is deliberately narrow. A child is only ever a candidate if
    # it is a DIRECT descendant of our own tracked pid AND its command line
    # names this repository. Categories of process are never targeted.
    $ourChildren = @(Get-Descendant-Pids $storedPid | Where-Object {
        $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue).CommandLine
        $cmd -and $cmd.Contains($repoRoot)
    })
    if ($ourChildren.Count -gt 0) {
        Write-Host "  $name has $($ourChildren.Count) child process(es) belonging to this repo: $($ourChildren -join ', ')"
    }
    try {
        Stop-Process -Id $storedPid -ErrorAction Stop
        # The watch process saves state and releases its lock on shutdown, so
        # it is given a little longer than a plain service would need.
        Start-Sleep -Seconds 3
        if (Get-Process -Id $storedPid -ErrorAction SilentlyContinue) {
            Write-Warning "$name (pid $storedPid) did not exit within 3s of Stop-Process - check it manually. It was NOT force-killed by this script."
        } else {
            Write-Host "$name stopped."
            foreach ($childPid in $ourChildren) {
                $child = Get-Process -Id $childPid -ErrorAction SilentlyContinue
                if (-not $child) { continue }
                # Re-verify identity at the moment of acting: a pid can be
                # reused between the snapshot above and now.
                $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$childPid" -ErrorAction SilentlyContinue).CommandLine
                if (-not ($cmd -and $cmd.Contains($repoRoot))) {
                    Write-Warning "  child pid $childPid no longer looks like ours - leaving it alone."
                    continue
                }
                Write-Host "  stopping orphaned $name child (pid $childPid) ..."
                try { Stop-Process -Id $childPid -ErrorAction Stop } catch { Write-Warning "  failed to stop child pid ${childPid}: $_" }
            }
            Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Warning "Failed to stop $name (pid $storedPid): $_"
    }
}

# Watch process first: it needs the backend up to finish cleanly.
Stop-Component 'strategy watch' 'rsi-scheduler.pid'
Stop-Component 'collector' 'collector.pid'
Stop-Component 'backend' 'backend.pid'

# --- 3. A stale watch lock left by a hard kill would block the next start. ---
$watchLock = Join-Path $backendRoot 'xauusd-rsi-runtime\xauusd-rsi-watch.lock'
if (Test-Path $watchLock) {
    Write-Host ""
    Write-Host "NOTE: the watch process lock file is still present at:"
    Write-Host "  $watchLock"
    Write-Host "  If the process exited cleanly it removes this itself. If it is still there, the"
    Write-Host "  next start will refuse until the lock goes stale (15 minutes) or you delete it."
    Write-Host "  Delete it ONLY after confirming with status-xauusd-rsi.ps1 that no watch process is running."
}

# --- 4. Report open exposure, because monitoring stops here ---
Write-Host ""
Write-Host "== open XAUUSD positions at shutdown =="
Write-Host "   (monitoring, protection checks and Friday liquidation STOP NOW - re-verify on next start)"
Push-Location $backendRoot
try {
    $query = @'
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
(async () => {
  const positions = await prisma.position.findMany({
    where: { symbol: "XAUUSD", status: "OPEN" },
    select: { externalPositionId: true, side: true, volume: true, openPrice: true, stopLoss: true, takeProfit: true, profit: true, rawPayload: true },
  });
  if (positions.length === 0) {
    console.log("  none open");
  } else {
    for (const p of positions) {
      const magic = p.rawPayload && typeof p.rawPayload === "object" ? p.rawPayload.magic : null;
      const owner = magic === 262610190 ? "ACTIVE RSI strategy" : magic === 262610181 ? "retired H4 gold strategy" : "FOREIGN/manual - never touched by this application";
      console.log(`  ticket=${p.externalPositionId} side=${p.side} volume=${p.volume} open=${p.openPrice} SL=${p.stopLoss ?? "NONE"} TP=${p.takeProfit ?? "NONE"} floating=${p.profit} owner=${owner}`);
    }
  }
  const inFlight = await prisma.xauusdRsiDecision.findMany({
    where: { orderStatus: { in: ["PENDING", "SENT", "UNKNOWN"] } },
    select: { id: true, orderStatus: true, direction: true },
  });
  if (inFlight.length > 0) {
    console.log("");
    console.log("  UNRESOLVED submissions - these need reconciling on next start:");
    for (const d of inFlight) console.log(`    decision=${d.id} ${d.direction} status=${d.orderStatus}`);
  }
  await prisma.$disconnect();
})().catch((err) => { console.error("  could not query open positions:", err.message); process.exit(1); });
'@
    $query | node --input-type=commonjs
} catch {
    Write-Warning "Could not query open positions (Postgres/Prisma unavailable): $_"
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "Open broker positions are NOT closed by this script. Close them manually in the"
Write-Host "terminal if needed."
Write-Host ""
Write-Host "IF A POSITION IS OPEN AND FRIDAY 23:30 BEIRUT IS APPROACHING, THE DEADLINE WILL" -ForegroundColor Yellow
Write-Host "NOT BE MET WHILE THIS STACK IS STOPPED. Restart it, or close the position by hand." -ForegroundColor Yellow
