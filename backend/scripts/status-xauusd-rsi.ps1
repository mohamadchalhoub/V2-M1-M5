# Reports on the xauusd-m1-rsi-retest-extremes-v1 stack started by
# start-xauusd-rsi.ps1: process liveness (identity-validated, not just a PID
# number), listening ports, controls, the strategy's own persisted watch
# state, and whether a retired strategy's process is still running.
#
# Read-only. Running this changes nothing.
#
# Usage: powershell -ExecutionPolicy Bypass -File backend\scripts\status-xauusd-rsi.ps1
$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backendRoot = Join-Path $repoRoot 'backend'
$runtimeDir = Join-Path $repoRoot '.xauusd-rsi-runtime'
$logDir = Join-Path $runtimeDir 'logs'

# Identity-validated: a PID number alone proves nothing, because Windows
# reuses PIDs and a stale lock file could match an unrelated process.
function Show-Component($name, $pidFile, $logFile, [string[]]$requiredSubstrings) {
    $pidPath = Join-Path $runtimeDir $pidFile
    Write-Host "== $name =="
    if (Test-Path $pidPath) {
        $storedPid = Get-Content $pidPath -ErrorAction SilentlyContinue
        $row = Get-CimInstance Win32_Process -Filter "ProcessId = $storedPid" -ErrorAction SilentlyContinue
        if (-not $row) {
            Write-Host "  pid $storedPid : NOT RUNNING (stale lock file - safe to remove: $pidPath)"
        } else {
            $identityOk = $true
            foreach ($s in $requiredSubstrings) {
                if ($row.CommandLine -notlike "*$s*") { $identityOk = $false }
            }
            if ($identityOk) {
                $proc = Get-Process -Id $storedPid -ErrorAction SilentlyContinue
                Write-Host "  pid $storedPid : RUNNING (started $($proc.StartTime))"
            } else {
                Write-Host "  pid $storedPid : A DIFFERENT PROCESS now holds this PID - the tracked one is GONE." -ForegroundColor Yellow
                Write-Host "    command line: $($row.CommandLine)"
            }
        }
    } else {
        Write-Host "  no lock file - never started by start-xauusd-rsi.ps1, or already stopped"
    }
    $logPath = Join-Path $logDir $logFile
    if (Test-Path $logPath) {
        Write-Host "  last log lines ($logPath):"
        Get-Content $logPath -Tail 6 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" }
    }
    $errPath = "$logPath.err"
    if ((Test-Path $errPath) -and (Get-Item $errPath).Length -gt 0) {
        Write-Host "  last STDERR lines:" -ForegroundColor Yellow
        Get-Content $errPath -Tail 4 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
    }
    Write-Host ""
}

Show-Component 'backend' 'backend.pid' 'backend.log' @('dist\src\main.js')
Show-Component 'collector' 'collector.pid' 'collector.log' @('run.ps1')
Show-Component 'strategy watch' 'rsi-scheduler.pid' 'rsi-scheduler.log' @('xauusd-rsi-scheduler.js')

Write-Host "== ports =="
$backendPort = 8420
$envPortLine = Get-Content (Join-Path $backendRoot '.env') -ErrorAction SilentlyContinue | Where-Object { $_ -match '^PORT=' }
if ($envPortLine) {
    $parsed = ($envPortLine -split '=', 2)[1].Trim()
    if ($parsed) { $backendPort = [int]$parsed }
}
$listening = Get-NetTCPConnection -LocalPort $backendPort -State Listen -ErrorAction SilentlyContinue
if ($listening) { Write-Host "  backend port $backendPort : LISTENING" } else { Write-Host "  backend port $backendPort : not listening" }
Write-Host ""

Write-Host "== controls =="
$paths = @{
    'kill switch (strategy)'      = Join-Path $backendRoot 'XAUUSD_RSI_KILL_SWITCH'
    'kill switch (gold, honoured)' = Join-Path $backendRoot 'GOLD_KILL_SWITCH'
    'stop entries (strategy)'     = Join-Path $backendRoot 'XAUUSD_RSI_STOP_NEW_ENTRIES'
    'stop entries (gold, honoured)' = Join-Path $backendRoot 'GOLD_STOP_NEW_ENTRIES'
}
foreach ($key in $paths.Keys) {
    if (Test-Path $paths[$key]) {
        Write-Host "  $key : ENGAGED" -ForegroundColor Yellow
        Write-Host "    $($paths[$key])"
    } else {
        Write-Host "  $key : not engaged"
    }
}
$modeLine = Get-Content (Join-Path $backendRoot '.env') -ErrorAction SilentlyContinue | Where-Object { $_ -match '^XAUUSD_RSI_EXECUTION_MODE=' } | Select-Object -First 1
if ($modeLine) { Write-Host "  execution mode : $(($modeLine -split '=',2)[1].Trim())" } else { Write-Host "  execution mode : OFF (unset)" }
Write-Host ""

Write-Host "== strategy watch state =="
$statePath = Join-Path $backendRoot 'xauusd-rsi-runtime\xauusd-rsi-watch-state.json'
if (Test-Path $statePath) {
    try {
        $state = Get-Content $statePath -Raw | ConvertFrom-Json
        Write-Host "  strategy       : $($state.strategyVersion)"
        Write-Host "  spec hash      : $($state.specHash)"
        Write-Host "  last cycle     : $($state.recovery.lastCycleAtUtc)"
        Write-Host "  recovery done  : $($state.recovery.recoveryComplete)"
        Write-Host "  restarts       : $($state.recovery.restartCount)"
        Write-Host "  bars applied   : $($state.engine.closedBarsApplied)"
        Write-Host "  ticks applied  : $($state.engine.ticksApplied)"
        Write-Host "  gap resets     : $($state.engine.gapResets)"
        if ($state.recovery.lastCycleAtUtc) {
            $age = (New-TimeSpan -Start ([datetime]$state.recovery.lastCycleAtUtc).ToUniversalTime() -End ([datetime]::UtcNow)).TotalSeconds
            if ($age -gt 300) {
                Write-Host "  LAST CYCLE IS $([int]$age)s OLD - the watch process is not currently cycling." -ForegroundColor Red
            } else {
                Write-Host "  last cycle age : $([int]$age)s"
            }
        }
    } catch {
        Write-Host "  state file present but unreadable: $_" -ForegroundColor Yellow
    }
} else {
    Write-Host "  no state file - the watch process has never completed a cycle in this environment."
}
Write-Host ""

Write-Host "== retired strategies =="
function Test-ScopedProcessRunning($processName, [string[]]$requiredSubstrings) {
    $rows = Get-CimInstance Win32_Process -Filter "Name = '$processName'" -ErrorAction SilentlyContinue
    foreach ($row in $rows) {
        if (-not $row.CommandLine) { continue }
        $allMatch = $true
        foreach ($s in $requiredSubstrings) {
            if ($row.CommandLine -notlike "*$s*") { $allMatch = $false; break }
        }
        if ($allMatch) { return $true }
    }
    return $false
}
$goldRunning = Test-ScopedProcessRunning 'node.exe' @('gold-execution-scheduler')
$trendRunning = Test-ScopedProcessRunning 'node.exe' @('trend-breakout-execution-scheduler')
if ($goldRunning) {
    Write-Host "  gold-execution-scheduler : STILL RUNNING (its submission route is disabled, so it cannot trade - but stop it)" -ForegroundColor Yellow
} else {
    Write-Host "  gold-execution-scheduler : not running"
}
if ($trendRunning) {
    Write-Host "  trend-breakout-execution-scheduler : STILL RUNNING (its module is unregistered, so it cannot trade - but stop it)" -ForegroundColor Yellow
} else {
    Write-Host "  trend-breakout-execution-scheduler : not running"
}
Write-Host ""
Write-Host "For live strategy state (RSI, pattern, schedule, exposure, Friday liquidation),"
Write-Host "open the dashboard at /xauusd-rsi or GET /research/xauusd-rsi-status."
