# Manual start script for xauusd-m1-rsi-retest-extremes-v1 -
# BACKEND + COLLECTOR + STRATEGY WATCH PROCESS. It does NOT start the
# frontend; see the note at the bottom for that separate command.
#
# Deliberately NOT a Windows Scheduled Task, service or startup shortcut.
# Manual-only operation is an explicit requirement, and it has a consequence
# worth stating plainly at the top of the file that starts everything:
#
#   WHILE THIS STACK IS STOPPED, NOTHING OBSERVES RSI, NOTHING ENTERS, AND
#   THE FRIDAY PRE-WEEKEND LIQUIDATION DOES NOT RUN.
#
# If a position is open going into a Friday, this stack must be running and
# connected to the broker before 23:00 Beirut for the 23:30 deadline to be
# met. See RECOVERY.md.
#
# STABLE (non-watching) run mode: builds the backend once (tsc -> dist/),
# then runs the COMPILED output directly, never `npm run dev`/tsx's
# file-watching mode. A watcher that respawns on every file change is fine
# for development and is not what a stable trading session wants. Both
# processes write to real log files under $logDir.
#
# PID/lock files live under .xauusd-rsi-runtime/ at the repo root so
# status-xauusd-rsi.ps1 / stop-xauusd-rsi.ps1 can find exactly these
# processes and nothing else.
#
# Usage: powershell -ExecutionPolicy Bypass -File backend\scripts\start-xauusd-rsi.ps1
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backendRoot = Join-Path $repoRoot 'backend'
$collectorRoot = Join-Path $repoRoot 'collector'
$runtimeDir = Join-Path $repoRoot '.xauusd-rsi-runtime'
$logDir = Join-Path $runtimeDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# --- Identity-validated PID check. Not merely "does a process with this PID
# number exist": Windows reuses PIDs, so a stale lock file could otherwise
# match a completely unrelated process that happened to reuse the number.
# Confirms the process name AND that its command line contains every
# expected substring. ---
function Test-PidAlive($pidPath, $expectedProcessName, [string[]]$requiredSubstrings) {
    if (-not (Test-Path $pidPath)) { return $false }
    $storedPid = Get-Content $pidPath -ErrorAction SilentlyContinue
    if (-not $storedPid) { return $false }
    $row = Get-CimInstance Win32_Process -Filter "ProcessId = $storedPid" -ErrorAction SilentlyContinue
    if (-not $row) { return $false }
    if ($row.Name -ne $expectedProcessName) { return $false }
    if (-not $row.CommandLine) { return $false }
    foreach ($s in $requiredSubstrings) {
        if ($row.CommandLine -notlike "*$s*") { return $false }
    }
    return $true
}

# --- Scoped duplicate-process detection. Beyond our own lock files (which
# only catch processes THIS script started), also check for ANY process of
# the given executable name whose command line contains every required
# substring - this repo's own path plus the entry script - so an unrelated
# node.exe/python.exe from another project can never false-positive as
# "already running" and silently block startup. ---
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

function Start-Component($name, $pidFile, $workDir, $exe, $argString, $logFile) {
    $proc = Start-Process -FilePath $exe -ArgumentList $argString -WorkingDirectory $workDir `
        -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" -WindowStyle Hidden -PassThru
    Set-Content -Path (Join-Path $runtimeDir $pidFile) -Value $proc.Id
    Write-Host "$name started, pid=$($proc.Id), log=$logFile"
    return $proc
}

# ============================================================
# STEP 1 - ALL preflight checks, BEFORE touching dist/ at all. Building
# underneath an already-running compiled instance (the same dist/ files the
# running process has open) is exactly what this ordering prevents.
# ============================================================

$backendPidFile = Join-Path $runtimeDir 'backend.pid'
$collectorPidFile = Join-Path $runtimeDir 'collector.pid'
$schedulerPidFile = Join-Path $runtimeDir 'rsi-scheduler.pid'

$backendPort = 8420
$envPortLine = Get-Content (Join-Path $backendRoot '.env') -ErrorAction SilentlyContinue | Where-Object { $_ -match '^PORT=' }
if ($envPortLine) {
    $parsed = ($envPortLine -split '=', 2)[1].Trim()
    if ($parsed) { $backendPort = [int]$parsed }
}
$portInUse = Get-NetTCPConnection -LocalPort $backendPort -State Listen -ErrorAction SilentlyContinue

$backendDevRunning = Test-ScopedProcessRunning 'node.exe' @($backendRoot, 'ts-node-dev')
$backendStableRunning = Test-ScopedProcessRunning 'node.exe' @('dist\src\main.js')
$backendTracked = Test-PidAlive $backendPidFile 'node.exe' @('dist\src\main.js')

$conflicts = @()
if (($portInUse -or $backendDevRunning -or $backendStableRunning) -and -not $backendTracked) {
    $conflicts += "Backend: port $backendPort is bound and/or a backend process for THIS repo (scoped to '$backendRoot') is already running but is not tracked by this script's lock file. Resolve: run status-xauusd-rsi.ps1, then either stop it with stop-xauusd-rsi.ps1 and re-run this, or leave it alone and do not run this script."
}

# The strategy watch process, scoped to this repo plus either entry point.
$schedulerDevRunning = Test-ScopedProcessRunning 'node.exe' @($backendRoot, 'xauusd-rsi-scheduler.ts')
$schedulerStableRunning = Test-ScopedProcessRunning 'node.exe' @('dist\scripts\xauusd-rsi-scheduler.js')
$schedulerTracked = Test-PidAlive $schedulerPidFile 'node.exe' @('xauusd-rsi-scheduler.js')
if (($schedulerDevRunning -or $schedulerStableRunning) -and -not $schedulerTracked) {
    $conflicts += "Strategy watch: an xauusd-rsi-scheduler process for THIS repo is already running but is not tracked by this script's lock file. Two watch processes would both claim decisions and could both submit, so this script refuses to start a second one. Resolve it the same way as the backend conflict above."
}

# A retired strategy's scheduler must not be running alongside this one.
# Its backend routes are disabled, so it could not actually submit, but a
# running process would still consume the MT5 connection and confuse the
# operator about what is live.
$goldSchedulerRunning = Test-ScopedProcessRunning 'node.exe' @('gold-execution-scheduler')
$trendSchedulerRunning = Test-ScopedProcessRunning 'node.exe' @('trend-breakout-execution-scheduler')
if ($goldSchedulerRunning) {
    $conflicts += "A RETIRED gold-execution-scheduler process is still running. Its submission route is disabled so it cannot trade, but stop it before starting this strategy: run stop-gold-demo.ps1."
}
if ($trendSchedulerRunning) {
    $conflicts += "A RETIRED trend-breakout-execution-scheduler process is still running. Its module is no longer registered so it cannot trade, but stop it before starting this strategy."
}

# Collector: scoped to python.exe (or pythonw.exe) whose command line
# contains BOTH this repo's collector path and main.py.
$collectorRunningPy = Test-ScopedProcessRunning 'python.exe' @($collectorRoot, 'main.py')
$collectorRunningPyw = Test-ScopedProcessRunning 'pythonw.exe' @($collectorRoot, 'main.py')
$collectorTracked = Test-PidAlive $collectorPidFile 'powershell.exe' @('scripts\run.ps1')
if (($collectorRunningPy -or $collectorRunningPyw) -and -not $collectorTracked) {
    $conflicts += "Collector: a Python collector process for THIS repo ('$collectorRoot', main.py) is already running but is not tracked by this script's lock file. Do NOT start a second collector against the same MT5 account."
}

if ($conflicts.Count -gt 0) {
    Write-Host ""
    Write-Host "PREFLIGHT FAILED - not building, not starting anything:" -ForegroundColor Red
    foreach ($c in $conflicts) { Write-Host "  - $c" -ForegroundColor Red }
    exit 1
}

# --- Configuration readback, so the operator sees what is about to happen
# rather than discovering it in a log later. ---
$envPath = Join-Path $backendRoot '.env'
function Get-EnvValue($name) {
    $line = Get-Content $envPath -ErrorAction SilentlyContinue | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
    if (-not $line) { return $null }
    return ($line -split '=', 2)[1].Trim()
}
$mode = Get-EnvValue 'XAUUSD_RSI_EXECUTION_MODE'
if (-not $mode) { $mode = 'OFF (unset)' }
$collectorFlag = $null
$collectorEnv = Join-Path $collectorRoot '.env'
$collectorFlagLine = Get-Content $collectorEnv -ErrorAction SilentlyContinue | Where-Object { $_ -match '^XAUUSD_RSI_EXECUTION_ENABLED=' } | Select-Object -First 1
if ($collectorFlagLine) { $collectorFlag = ($collectorFlagLine -split '=', 2)[1].Trim() }
if (-not $collectorFlag) { $collectorFlag = 'false (unset)' }

$killSwitch = Join-Path $backendRoot 'GOLD_KILL_SWITCH'
$ownKillSwitch = Join-Path $backendRoot 'XAUUSD_RSI_KILL_SWITCH'

Write-Host ""
Write-Host "About to start xauusd-m1-rsi-retest-extremes-v1 with:"
Write-Host "  backend XAUUSD_RSI_EXECUTION_MODE   = $mode"
Write-Host "  collector XAUUSD_RSI_EXECUTION_ENABLED = $collectorFlag"
if ((Test-Path $killSwitch) -or (Test-Path $ownKillSwitch)) {
    Write-Host "  KILL SWITCH IS ENGAGED - no entry will be submitted until it is removed." -ForegroundColor Yellow
    if (Test-Path $killSwitch) { Write-Host "    $killSwitch" -ForegroundColor Yellow }
    if (Test-Path $ownKillSwitch) { Write-Host "    $ownKillSwitch" -ForegroundColor Yellow }
}
if ($mode -notlike 'DEMO*') {
    Write-Host "  NOTE: mode is not DEMO, so signals will be observed and recorded but no order will be queued." -ForegroundColor Yellow
}
Write-Host ""

if ($backendTracked) { Write-Host "backend already running and tracked (pid $(Get-Content $backendPidFile)) - skipping." }
if ($schedulerTracked) { Write-Host "strategy watch already running and tracked (pid $(Get-Content $schedulerPidFile)) - skipping." }
if ($collectorTracked) { Write-Host "collector already running and tracked (pid $(Get-Content $collectorPidFile)) - skipping." }

# ============================================================
# STEP 2 - Build, only after preflight passed clean.
# ============================================================
if ((-not $backendTracked) -or (-not $schedulerTracked)) {
    Write-Host "Building backend (tsc)..."
    Push-Location $backendRoot
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "backend build failed (exit $LASTEXITCODE) - not starting anything. Check the build output above." }
    } finally {
        Pop-Location
    }
    $backendEntry = Join-Path $backendRoot 'dist\src\main.js'
    $schedulerEntry = Join-Path $backendRoot 'dist\scripts\xauusd-rsi-scheduler.js'
    if (-not (Test-Path $backendEntry)) { throw "Expected compiled entry point not found: $backendEntry" }
    if (-not (Test-Path $schedulerEntry)) { throw "Expected compiled entry point not found: $schedulerEntry" }
    Write-Host "Build OK. Compiled entry points confirmed present."
}

# ============================================================
# STEP 3 - Backend first, and WAIT until it is genuinely healthy before
# starting anything that depends on it.
# ============================================================
if (-not $backendTracked) {
    Start-Component -name 'backend' -pidFile 'backend.pid' -workDir $backendRoot `
        -exe 'node.exe' -argString 'dist\src\main.js' -logFile (Join-Path $logDir 'backend.log') | Out-Null

    Write-Host "Waiting for backend health (http://localhost:$backendPort/health/live)..."
    $healthy = $false
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest -Uri "http://localhost:$backendPort/health/live" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) { $healthy = $true; break }
        } catch {
            # Not up yet - keep polling until the deadline.
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $healthy) {
        Write-Host ""
        Write-Host "ABORTING - backend did not become healthy within 30s." -ForegroundColor Red
        Write-Host "  Check $(Join-Path $logDir 'backend.log') and .log.err for what happened." -ForegroundColor Red
        Write-Host "  Collector and strategy watch were NOT started." -ForegroundColor Red
        exit 1
    }
    Write-Host "Backend healthy."
}

# ============================================================
# STEP 4 - Collector, then the strategy watch process.
# ============================================================
if (-not $collectorTracked) {
    Start-Component -name 'collector' -pidFile 'collector.pid' -workDir $collectorRoot `
        -exe 'powershell.exe' -argString '-NoProfile -ExecutionPolicy Bypass -File .\scripts\run.ps1' `
        -logFile (Join-Path $logDir 'collector.log') | Out-Null
}

if (-not $schedulerTracked) {
    Start-Component -name 'rsi-scheduler' -pidFile 'rsi-scheduler.pid' -workDir $backendRoot `
        -exe 'node.exe' -argString 'dist\scripts\xauusd-rsi-scheduler.js' -logFile (Join-Path $logDir 'rsi-scheduler.log') | Out-Null
}

Write-Host ""
Write-Host "This script starts BACKEND + COLLECTOR + STRATEGY WATCH ONLY."
Write-Host "Frontend is a SEPARATE manual step - run 'npm run dev' in frontend/ yourself."
Write-Host "Run status-xauusd-rsi.ps1 to check on everything, and read the first 20 lines of"
Write-Host "the strategy watch log to confirm the mode, volume and warm-up state it reported."
Write-Host ""
Write-Host "REMINDER: nothing restarts this automatically. If the machine sleeps or this" -ForegroundColor Yellow
Write-Host "stack stops, the Friday 23:30 Beirut liquidation will not run." -ForegroundColor Yellow
