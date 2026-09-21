# Status script for xauusd-m1-m5-rsi-threshold-v2.
#
# Read-only. Starts nothing, stops nothing, changes nothing.
#
# Reports what is ACTUALLY running for THIS repository, scoped by path, and
# distinguishes it from the other trading system on this machine. Every
# process line says which checkout it belongs to, because "a node.exe is
# running" is not an answer when two trading systems share a machine.
#
# It also reports the committed version against the running one: section 17 requires
# that distinction, and "the code is committed" is not evidence that it is
# what is executing.
#
# Usage: powershell -ExecutionPolicy Bypass -File backend\scripts\status-xauusd-m1m5.ps1
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backendRoot = Join-Path $repoRoot 'backend'
$collectorRoot = Join-Path $repoRoot 'collector'
$runtimeDir = Join-Path $repoRoot '.xauusd-m1m5-runtime'

function Get-EnvValue($name) {
    $envPath = Join-Path $backendRoot '.env'
    $line = Get-Content $envPath -ErrorAction SilentlyContinue | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
    if (-not $line) { return $null }
    return ($line -split '=', 2)[1].Trim()
}

function Get-ScopedProcesses($processName, [string[]]$requiredSubstrings) {
    $out = @()
    $rows = Get-CimInstance Win32_Process -Filter "Name = '$processName'" -ErrorAction SilentlyContinue
    foreach ($row in $rows) {
        if (-not $row.CommandLine) { continue }
        $allMatch = $true
        foreach ($s in $requiredSubstrings) {
            if ($row.CommandLine -notlike "*$s*") { $allMatch = $false; break }
        }
        if ($allMatch) { $out += $row }
    }
    return $out
}

function Report($label, $rows, $pidFileName) {
    $pidPath = Join-Path $runtimeDir $pidFileName
    $tracked = if (Test-Path $pidPath) { (Get-Content $pidPath -ErrorAction SilentlyContinue) } else { $null }

    if ($rows.Count -eq 0) {
        $note = if ($tracked) { " (lock file records pid $tracked, which is no longer running -- stale)" } else { '' }
        Write-Host ("  {0,-16}: NOT RUNNING{1}" -f $label, $note) -ForegroundColor Yellow
        return
    }
    foreach ($row in $rows) {
        $trackedNote = if ("$tracked" -eq "$($row.ProcessId)") { 'tracked by this script' } else { 'NOT tracked by this script' }
        Write-Host ("  {0,-16}: running, pid {1} ({2})" -f $label, $row.ProcessId, $trackedNote) -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "xauusd-m1-m5-rsi-threshold-v2 -- status" -ForegroundColor Cyan
Write-Host "  repo: $repoRoot"
Write-Host ""

# --- Committed version versus running build (section 17). ---
Push-Location $repoRoot
try {
    $head = (& git rev-parse --short HEAD 2>$null)
    $dirty = (& git status --porcelain 2>$null)
} finally {
    Pop-Location
}
$distMain = Join-Path $backendRoot 'dist\src\main.js'
$builtAt = if (Test-Path $distMain) { (Get-Item $distMain).LastWriteTime } else { $null }

Write-Host "VERSION" -ForegroundColor Cyan
Write-Host "  committed HEAD  : $head$(if ($dirty) { ' (working tree has uncommitted changes)' })"
if ($builtAt) {
    Write-Host "  built output    : dist\src\main.js, last built $builtAt"
    Write-Host "                    A build older than your latest edit means the running code is NOT the committed code."
} else {
    Write-Host "  built output    : none -- dist\src\main.js does not exist, so nothing compiled is available to run." -ForegroundColor Yellow
}
Write-Host ""

# --- Processes, scoped to THIS repo. ---
Write-Host "PROCESSES (scoped to this repository only)" -ForegroundColor Cyan
Report 'Backend' (Get-ScopedProcesses 'node.exe' @($backendRoot, 'dist\src\main.js')) 'backend.pid'
Report 'Strategy watch' (Get-ScopedProcesses 'node.exe' @($backendRoot, 'xauusd-m1m5-scheduler.js')) 'm1m5-scheduler.pid'
$collector = @(Get-ScopedProcesses 'python.exe' @($collectorRoot, 'main.py')) + @(Get-ScopedProcesses 'pythonw.exe' @($collectorRoot, 'main.py'))
Report 'Collector' $collector 'collector.pid'
Write-Host ""

# --- Retired strategies in THIS repo, which should not be running. ---
$retiredRunning = @()
foreach ($retired in @('gold-execution-scheduler', 'trend-breakout-execution-scheduler', 'xauusd-rsi-scheduler')) {
    $rows = Get-ScopedProcesses 'node.exe' @($backendRoot, $retired)
    if ($rows.Count -gt 0) { $retiredRunning += "$retired (pid $($rows[0].ProcessId))" }
}
if ($retiredRunning.Count -gt 0) {
    Write-Host "RETIRED STRATEGIES STILL RUNNING IN THIS REPO" -ForegroundColor Yellow
    foreach ($r in $retiredRunning) { Write-Host "  - $r -- entry wiring is disabled in code, so it cannot trade, but stop it." }
    Write-Host ""
}

# --- Configuration. ---
$mode = Get-EnvValue 'XAUUSD_M1M5_EXECUTION_MODE'
if (-not $mode) { $mode = 'OFF (unset)' }
$db = Get-EnvValue 'DATABASE_URL'
$port = Get-EnvValue 'PORT'
if (-not $port) { $port = '8430 (default)' }

Write-Host "CONFIGURATION" -ForegroundColor Cyan
Write-Host "  execution mode  : $mode"
Write-Host "  backend port    : $port"
Write-Host "  database        : $(if ($db) { $db } else { 'NOT SET' })"
if ($db -and $db -notlike '*m1m5_v2*') {
    Write-Host "  WARNING: DATABASE_URL does not name this project's database (expected 'm1m5_v2')." -ForegroundColor Red
}
Write-Host ""

# --- Controls. ---
$killSwitch = Join-Path $backendRoot 'XAUUSD_M1M5_KILL_SWITCH'
$stopEntries = Join-Path $backendRoot 'XAUUSD_M1M5_STOP_NEW_ENTRIES'
Write-Host "CONTROLS" -ForegroundColor Cyan
Write-Host "  kill switch     : $(if (Test-Path $killSwitch) { 'ENGAGED' } else { 'not engaged' })"
Write-Host "  stop new entries: $(if (Test-Path $stopEntries) { 'ENGAGED' } else { 'not engaged' })"
Write-Host "  Neither disables reconciliation, protective management or Friday liquidation."
Write-Host ""

# --- Containers, scoped to this project's compose identity. ---
Write-Host "CONTAINERS (this project's compose identity only)" -ForegroundColor Cyan
$containers = & docker ps --filter 'name=m1m5-v2-' --format '{{.Names}}\t{{.Status}}' 2>$null
if ($containers) {
    foreach ($line in $containers) { Write-Host "  $line" }
} else {
    Write-Host "  none running (or docker unavailable)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Other trading systems on this machine are deliberately not listed here; this script reports only"
Write-Host "processes and containers belonging to $repoRoot."
