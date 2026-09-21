# Reports on the gold DEMO stack started by start-gold-demo.ps1  -  PID
# liveness, listening ports, both kill switches (gold + legacy, legacy
# read-only for context), last log lines, and MT5 connection state if the
# collector's own heartbeat/log reveals it.
#
# Usage: powershell -ExecutionPolicy Bypass -File backend\scripts\status-gold-demo.ps1
$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backendRoot = Join-Path $repoRoot 'backend'
$runtimeDir = Join-Path $repoRoot '.gold-demo-runtime'
$logDir = Join-Path $runtimeDir 'logs'

function Show-Component($name, $pidFile, $logFile) {
    $pidPath = Join-Path $runtimeDir $pidFile
    Write-Host "== $name =="
    if (Test-Path $pidPath) {
        $storedPid = Get-Content $pidPath -ErrorAction SilentlyContinue
        $proc = Get-Process -Id $storedPid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "  pid $storedPid : RUNNING (started $($proc.StartTime))"
        } else {
            Write-Host "  pid $storedPid : NOT RUNNING (stale lock file  -  safe to remove: $pidPath)"
        }
    } else {
        Write-Host "  no lock file  -  never started by start-gold-demo.ps1, or already stopped"
    }
    $logPath = Join-Path $logDir $logFile
    if (Test-Path $logPath) {
        Write-Host "  last log lines ($logPath):"
        Get-Content $logPath -Tail 5 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" }
    }
    Write-Host ""
}

Show-Component 'backend' 'backend.pid' 'backend.log'
Show-Component 'collector' 'collector.pid' 'collector.log'
Show-Component 'gold-scheduler' 'gold-scheduler.pid' 'gold-scheduler.log'

Write-Host "== ports =="
$backendPort = 8420
$envPortLine = Get-Content (Join-Path $backendRoot '.env') -ErrorAction SilentlyContinue | Where-Object { $_ -match '^PORT=' }
if ($envPortLine) {
    $parsed = ($envPortLine -split '=', 2)[1].Trim()
    if ($parsed) { $backendPort = [int]$parsed }
}
$listening = Get-NetTCPConnection -LocalPort $backendPort -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Write-Host "  backend port $backendPort : LISTENING (pid $($listening[0].OwningProcess))"
} else {
    Write-Host "  backend port $backendPort : not listening"
}
Write-Host ""

Write-Host "== kill switches =="
$goldSwitchPath = Join-Path $backendRoot 'GOLD_KILL_SWITCH'
$envGoldPath = Get-Content (Join-Path $backendRoot '.env') -ErrorAction SilentlyContinue | Where-Object { $_ -match '^GOLD_KILL_SWITCH_PATH=' }
if ($envGoldPath) {
    $parsed = ($envGoldPath -split '=', 2)[1].Trim()
    if ($parsed) { $goldSwitchPath = $parsed }
}
if (Test-Path $goldSwitchPath) {
    Write-Host "  GOLD kill switch ($goldSwitchPath): ENGAGED  -  no new gold entries will submit"
} else {
    Write-Host "  GOLD kill switch ($goldSwitchPath): clear  -  gold entries permitted (subject to mode/window/risk gates)"
}

$legacySwitchPath = Join-Path $backendRoot 'KILL_SWITCH'
$envLegacyPath = Get-Content (Join-Path $backendRoot '.env') -ErrorAction SilentlyContinue | Where-Object { $_ -match '^AUTONOMOUS_KILL_SWITCH_PATH=' }
if ($envLegacyPath) {
    $parsed = ($envLegacyPath -split '=', 2)[1].Trim()
    if ($parsed) { $legacySwitchPath = $parsed }
}
if (Test-Path $legacySwitchPath) {
    Write-Host "  legacy KILL_SWITCH ($legacySwitchPath): ENGAGED (read-only context  -  this script never sets/clears this one)"
} else {
    Write-Host "  legacy KILL_SWITCH ($legacySwitchPath): clear (read-only context  -  this script never sets/clears this one)"
}
Write-Host ""

Write-Host "== MT5 / collector connection (from collector log, if discoverable) =="
$collectorLog = Join-Path $logDir 'collector.log'
if (Test-Path $collectorLog) {
    $lastConnLine = Get-Content $collectorLog -Tail 200 -ErrorAction SilentlyContinue | Select-String -Pattern 'connected|mt5_connected|terminal' | Select-Object -Last 1
    if ($lastConnLine) { Write-Host "  $lastConnLine" } else { Write-Host "  no connection status line found in the last 200 log lines" }
} else {
    Write-Host "  no collector log yet at $collectorLog"
}
