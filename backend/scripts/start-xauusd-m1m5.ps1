# Manual start script for xauusd-m1-m5-rsi-threshold-v2 --
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
# met. See V2_OPERATIONS.md.
#
# ============================================================================
# THIS MACHINE HOSTS ANOTHER TRADING SYSTEM THAT IS CURRENTLY RUNNING.
#
# `trading-monitor-autonomous` runs xauusd-m1-rsi-retest-extremes-v1 on its
# own DEMO account, from its own checkout, with its own containers. Every
# process check below is SCOPED TO THIS REPOSITORY'S PATH, and this script
# never kills a process by name alone. A bare `Stop-Process -Name node` would
# stop that system's trading process, and on a Friday evening that would
# leave its positions open over the weekend.
#
# If you add a check here, scope it the same way.
# ============================================================================
#
# STABLE (non-watching) run mode: builds the backend once (tsc -> dist/), then
# runs the COMPILED output directly, never a file-watching dev mode. A watcher
# that respawns on every file change is fine for development and is not what a
# stable trading session wants.
#
# Usage: powershell -ExecutionPolicy Bypass -File backend\scripts\start-xauusd-m1m5.ps1
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backendRoot = Join-Path $repoRoot 'backend'
$collectorRoot = Join-Path $repoRoot 'collector'
$runtimeDir = Join-Path $repoRoot '.xauusd-m1m5-runtime'
$logDir = Join-Path $runtimeDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# --- Identity-validated PID check. Not merely "does a process with this PID
# number exist": Windows reuses PIDs, so a stale lock file could otherwise
# match a completely unrelated process that happened to reuse the number.
# Confirms the process name AND that its command line contains every expected
# substring. ---
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
# only catch processes THIS script started), also check for ANY process of the
# given executable name whose command line contains every required substring --
# this repo's own path plus the entry script -- so a node.exe belonging to the
# OTHER trading system can never false-positive as "already running" here, and
# can never be mistaken for ours. ---
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

function Get-EnvValue($name) {
    $envPath = Join-Path $backendRoot '.env'
    $line = Get-Content $envPath -ErrorAction SilentlyContinue | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
    if (-not $line) { return $null }
    return ($line -split '=', 2)[1].Trim()
}

# ============================================================
# STEP 1 -- ALL preflight checks, BEFORE touching dist/ at all. Building
# underneath an already-running compiled instance (the same dist/ files the
# running process has open) is exactly what this ordering prevents.
# ============================================================

$backendPidFile = Join-Path $runtimeDir 'backend.pid'
$collectorPidFile = Join-Path $runtimeDir 'collector.pid'
$schedulerPidFile = Join-Path $runtimeDir 'm1m5-scheduler.pid'

$backendPort = 8430
$parsedPort = Get-EnvValue 'PORT'
if ($parsedPort) { $backendPort = [int]$parsedPort }
$portInUse = Get-NetTCPConnection -LocalPort $backendPort -State Listen -ErrorAction SilentlyContinue

$conflicts = @()

# --- Backend, scoped to THIS repo. ---
$backendDevRunning = Test-ScopedProcessRunning 'node.exe' @($backendRoot, 'ts-node-dev')
$backendStableRunning = Test-ScopedProcessRunning 'node.exe' @($backendRoot, 'dist\src\main.js')
$backendTracked = Test-PidAlive $backendPidFile 'node.exe' @($backendRoot, 'dist\src\main.js')
if (($portInUse -or $backendDevRunning -or $backendStableRunning) -and -not $backendTracked) {
    $conflicts += "Backend: port $backendPort is bound and/or a backend process for THIS repo (scoped to '$backendRoot') is already running but is not tracked by this script's lock file. Resolve: run status-xauusd-m1m5.ps1, then either stop it with stop-xauusd-m1m5.ps1 and re-run this, or leave it alone and do not run this script."
}

# --- Strategy watch process, scoped to this repo plus either entry point.
# Two watch processes would both claim decisions and could both submit, which
# is precisely what the atomic per-timeframe reservation is there to make
# impossible at the database level -- but a second process would still double
# the observation load and confuse the audit trail, so it is refused here. ---
$schedulerDevRunning = Test-ScopedProcessRunning 'node.exe' @($backendRoot, 'xauusd-m1m5-scheduler.ts')
$schedulerStableRunning = Test-ScopedProcessRunning 'node.exe' @($backendRoot, 'dist\scripts\xauusd-m1m5-scheduler.js')
$schedulerTracked = Test-PidAlive $schedulerPidFile 'node.exe' @($backendRoot, 'xauusd-m1m5-scheduler.js')
if (($schedulerDevRunning -or $schedulerStableRunning) -and -not $schedulerTracked) {
    $conflicts += "Strategy watch: an xauusd-m1m5-scheduler process for THIS repo is already running but is not tracked by this script's lock file. This script refuses to start a second one."
}

# --- Retired strategies' schedulers. Their submission routes are disabled in
# code in this copy, so they could not trade even if running, but a running
# process would still consume the MT5 connection and confuse the operator
# about what is live. Scoped to THIS repo: the identically-named process
# belonging to the other checkout is none of our business. ---
foreach ($retired in @('gold-execution-scheduler', 'trend-breakout-execution-scheduler', 'xauusd-rsi-scheduler')) {
    if (Test-ScopedProcessRunning 'node.exe' @($backendRoot, $retired)) {
        $conflicts += "A RETIRED $retired process from THIS repo is still running. Its entry wiring is disabled in code so it cannot trade, but stop it before starting this strategy."
    }
}

# --- Collector, scoped to THIS repo's collector path plus main.py. ---
$collectorRunningPy = Test-ScopedProcessRunning 'python.exe' @($collectorRoot, 'main.py')
$collectorRunningPyw = Test-ScopedProcessRunning 'pythonw.exe' @($collectorRoot, 'main.py')
$collectorTracked = Test-PidAlive $collectorPidFile 'powershell.exe' @($collectorRoot, 'scripts\run.ps1')
if (($collectorRunningPy -or $collectorRunningPyw) -and -not $collectorTracked) {
    $conflicts += "Collector: a Python collector process for THIS repo ('$collectorRoot', main.py) is already running but is not tracked by this script's lock file. Do NOT start a second collector against the same MT5 account."
}

# --- Infrastructure identity. A wrong DATABASE_URL here would write this
# strategy's decisions into another deployment's database. ---
$databaseUrl = Get-EnvValue 'DATABASE_URL'
if (-not $databaseUrl) {
    $conflicts += "No DATABASE_URL in backend\.env. Copy backend\.env.example and point it at THIS project's database (m1m5_v2 on port 5453)."
} elseif ($databaseUrl -notlike '*m1m5_v2*') {
    $conflicts += "DATABASE_URL does not name this project's database (expected a name containing 'm1m5_v2'). Refusing to start: this would write into another deployment's database. Current value points at: $databaseUrl"
}

if ($conflicts.Count -gt 0) {
    Write-Host ""
    Write-Host "PREFLIGHT FAILED - not building, not starting anything:" -ForegroundColor Red
    foreach ($c in $conflicts) { Write-Host "  - $c" -ForegroundColor Red }
    exit 1
}

# ============================================================
# STEP 2 -- Configuration readback, so the operator sees what is about to
# happen rather than discovering it in a log later.
# ============================================================

$executionMode = Get-EnvValue 'XAUUSD_M1M5_EXECUTION_MODE'
if (-not $executionMode) { $executionMode = 'OFF (unset)' }
$volume = Get-EnvValue 'XAUUSD_M1M5_VOLUME_LOTS'
if (-not $volume) { $volume = '0.5 (default)' }

Write-Host ""
Write-Host "xauusd-m1-m5-rsi-threshold-v2" -ForegroundColor Cyan
Write-Host "  repo            : $repoRoot"
Write-Host "  backend port    : $backendPort"
Write-Host "  database        : $databaseUrl"
Write-Host "  execution mode  : $executionMode"
Write-Host "  volume          : $volume lots"
Write-Host "  TP / SL         : `$5.00 / `$5.00 of gold price"
Write-Host "  entry rules     : SELL on RSI crossing up through 91, BUY on RSI crossing down through 8.9"
Write-Host "  entry pauses    : 23:30-01:00 and 14:00-19:00 Beirut, daily, both timeframes"
Write-Host ""
if ($executionMode -notlike 'DEMO*') {
    Write-Host "  Execution is not DEMO -- the strategy will observe and record but never submit an order." -ForegroundColor Yellow
    Write-Host ""
}

# ============================================================
# STEP 3 -- Build, then start. Compiled output only.
# ============================================================

Write-Host "Building backend (tsc -> dist/) ..."
Push-Location $backendRoot
try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "Backend build failed with exit code $LASTEXITCODE. Nothing was started." }
} finally {
    Pop-Location
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

Start-Component 'Backend' 'backend.pid' $backendRoot 'node.exe' 'dist\src\main.js' `
    (Join-Path $logDir "backend-$stamp.log") | Out-Null

Start-Component 'Collector' 'collector.pid' $collectorRoot 'powershell.exe' `
    '-ExecutionPolicy Bypass -File scripts\run.ps1' (Join-Path $logDir "collector-$stamp.log") | Out-Null

Start-Component 'Strategy watch' 'm1m5-scheduler.pid' $backendRoot 'node.exe' `
    'dist\scripts\xauusd-m1m5-scheduler.js' (Join-Path $logDir "m1m5-scheduler-$stamp.log") | Out-Null

Write-Host ""
Write-Host "Started. Verify with: powershell -ExecutionPolicy Bypass -File backend\scripts\status-xauusd-m1m5.ps1"
Write-Host "Stop with:            powershell -ExecutionPolicy Bypass -File backend\scripts\stop-xauusd-m1m5.ps1"
Write-Host ""
Write-Host "The dashboard is a separate process:  cd frontend; npm run build; npm start"
Write-Host ""
Write-Host "Reminder: while this stack is stopped, nothing observes RSI and the Friday liquidation does not run." -ForegroundColor Yellow
