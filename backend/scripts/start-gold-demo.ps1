# Manual start script for the gold DEMO stack - BACKEND + COLLECTOR +
# GOLD-EXECUTION SCHEDULER ONLY. It does NOT start the frontend - see the
# note at the very bottom of this file for that separate command.
# Deliberately NOT a Windows Scheduled Task / service / startup shortcut
# (explicitly out of scope for this work) - run it by hand from a
# PowerShell window whenever you want the stack up, same posture as
# collector/scripts/run.ps1 already uses for the collector alone.
#
# STABLE (non-watching) run mode: builds the backend once (tsc -> dist/),
# then runs the COMPILED output directly (node dist/src/main.js,
# node dist/scripts/gold-execution-scheduler.js) - the same commands
# package.json's own "start" script uses, never `npm run dev`/tsx's
# file-watching dev mode. A watcher that respawns on every file change is
# fine for active development but is NOT what you want for a stable manual
# demo session. Both backend and scheduler processes are started with their
# stdout/stderr redirected to a real log file (see $logDir below).
#
# PID/lock files live under .gold-demo-runtime/ at the repo root so
# status-gold-demo.ps1 / stop-gold-demo.ps1 can find exactly these
# processes and nothing else.
#
# Usage: powershell -ExecutionPolicy Bypass -File backend\scripts\start-gold-demo.ps1
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backendRoot = Join-Path $repoRoot 'backend'
$collectorRoot = Join-Path $repoRoot 'collector'
$runtimeDir = Join-Path $repoRoot '.gold-demo-runtime'
$logDir = Join-Path $runtimeDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# --- Identity-validated PID check (not just "does a process with this PID
# number exist" - Windows reuses PIDs, so a stale lock file could otherwise
# match a completely unrelated process that happened to reuse the number).
# Confirms the process name AND that its command line contains every
# expected substring (e.g. this repo's own path plus the entry script). ---
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
# only catch processes THIS script itself started), also check for ANY
# process of the given executable name whose command line contains every
# required substring - e.g. this repo's own backend/collector path PLUS the
# entry script - so a ts-node-dev process from a DIFFERENT project, or any
# other unrelated node.exe/python.exe, can never false-positive as "already
# running" and silently block startup. Best-effort (CIM command-line
# matching), not a guarantee, but closes the most likely real double-launch
# case while staying scoped to this repository. ---
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
# STEP 1 - ALL preflight/duplicate checks, BEFORE touching dist/ at all.
# Building underneath an already-running compiled instance (same dist/
# files the running process has open/mapped) is exactly the kind of
# footgun this step exists to prevent.
# ============================================================

$backendPidFile = Join-Path $runtimeDir 'backend.pid'
$collectorPidFile = Join-Path $runtimeDir 'collector.pid'
$schedulerPidFile = Join-Path $runtimeDir 'gold-scheduler.pid'

$backendPort = 8420
$envPortLine = Get-Content (Join-Path $backendRoot '.env') -ErrorAction SilentlyContinue | Where-Object { $_ -match '^PORT=' }
if ($envPortLine) {
    $parsed = ($envPortLine -split '=', 2)[1].Trim()
    if ($parsed) { $backendPort = [int]$parsed }
}
$portInUse = Get-NetTCPConnection -LocalPort $backendPort -State Listen -ErrorAction SilentlyContinue

# Scoped to THIS repo's backend specifically (path substring), not a bare
# "any node.exe" or "any ts-node-dev" match - an unrelated project's
# ts-node-dev process must never block this one's startup.
$backendDevRunning = Test-ScopedProcessRunning 'node.exe' @($backendRoot, 'ts-node-dev')
$backendStableRunning = Test-ScopedProcessRunning 'node.exe' @('dist\src\main.js') # no repo-path requirement here: a relative arg (e.g. "node dist\src\main.js" typed from within backendRoot) never carries an absolute path at all
$backendTracked = Test-PidAlive $backendPidFile 'node.exe' @('dist\src\main.js')

$conflicts = @()
if (($portInUse -or $backendDevRunning -or $backendStableRunning) -and -not $backendTracked) {
    $conflicts += "Backend: port $backendPort is bound and/or a backend process for THIS repo (scoped to '$backendRoot') is already running, but not tracked by this script's own lock file (started by hand, in another window). Resolve: check status-gold-demo.ps1 / netstat manually, then either let this script manage it via a proper stop-gold-demo.ps1 + restart, or leave it alone and don't run this script."
}

# Scheduler: scoped to the backend repo path plus either the dev-mode (tsx)
# or stable (dist) entry point.
$schedulerDevRunning = Test-ScopedProcessRunning 'node.exe' @($backendRoot, 'gold-execution-scheduler.ts')
$schedulerStableRunning = Test-ScopedProcessRunning 'node.exe' @('dist\scripts\gold-execution-scheduler.js') # same relative-arg reasoning as backendStableRunning above
$schedulerTracked = Test-PidAlive $schedulerPidFile 'node.exe' @('gold-execution-scheduler.js')
if (($schedulerDevRunning -or $schedulerStableRunning) -and -not $schedulerTracked) {
    $conflicts += "Scheduler: a gold-execution-scheduler process for THIS repo is already running but not tracked by this script's lock file. Resolve the same way as the backend conflict above before re-running this script."
}

# Collector: THIS was the actual bug report - the old check only ever
# looked at node.exe, so a running Python collector was invisible to it.
# Scoped to python.exe (or pythonw.exe, in case the venv resolves that way)
# whose command line contains BOTH this repo's collector path and main.py.
$collectorRunningPy = Test-ScopedProcessRunning 'python.exe' @($collectorRoot, 'main.py')
$collectorRunningPyw = Test-ScopedProcessRunning 'pythonw.exe' @($collectorRoot, 'main.py')
$collectorTracked = Test-PidAlive $collectorPidFile 'powershell.exe' @('scripts\run.ps1')
if (($collectorRunningPy -or $collectorRunningPyw) -and -not $collectorTracked) {
    $conflicts += "Collector: a Python collector process for THIS repo ('$collectorRoot', main.py) is already running but not tracked by this script's lock file. Resolve the same way before re-running this script - do NOT start a second collector against the same MT5 account."
}

if ($conflicts.Count -gt 0) {
    Write-Host ""
    Write-Host "PREFLIGHT FAILED - not building, not starting anything:" -ForegroundColor Red
    foreach ($c in $conflicts) { Write-Host "  - $c" -ForegroundColor Red }
    exit 1
}

if ($backendTracked) { Write-Host "backend already running and tracked (pid $(Get-Content $backendPidFile)) - skipping." }
if ($schedulerTracked) { Write-Host "gold-scheduler already running and tracked (pid $(Get-Content $schedulerPidFile)) - skipping." }
if ($collectorTracked) { Write-Host "collector already running and tracked (pid $(Get-Content $collectorPidFile)) - skipping." }

# ============================================================
# STEP 2 - Build, only after preflight passed clean.
# ============================================================
if (-not $backendTracked) {
    Write-Host "Building backend (tsc)..."
    Push-Location $backendRoot
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "backend build failed (exit $LASTEXITCODE) - not starting anything. Check the build output above." }
    } finally {
        Pop-Location
    }
    $backendEntry = Join-Path $backendRoot 'dist\src\main.js'
    $schedulerEntry = Join-Path $backendRoot 'dist\scripts\gold-execution-scheduler.js'
    if (-not (Test-Path $backendEntry)) { throw "Expected compiled entry point not found: $backendEntry - build output layout may have changed, check dist/ manually." }
    if (-not (Test-Path $schedulerEntry)) { throw "Expected compiled entry point not found: $schedulerEntry - build output layout may have changed, check dist/ manually." }
    Write-Host "Build OK. Compiled entry points confirmed present."
}

# ============================================================
# STEP 3 - Start the backend, then WAIT for it to actually be healthy
# before launching anything that depends on it (collector, scheduler).
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
        Write-Host "  Check $(Join-Path $logDir 'backend.log') and $(Join-Path $logDir 'backend.log.err') for what happened." -ForegroundColor Red
        Write-Host "  Collector and scheduler were NOT started." -ForegroundColor Red
        exit 1
    }
    Write-Host "Backend healthy."
}

# ============================================================
# STEP 4 - Only now, collector and scheduler.
# ============================================================
if (-not $collectorTracked) {
    Start-Component -name 'collector' -pidFile 'collector.pid' -workDir $collectorRoot `
        -exe 'powershell.exe' -argString '-NoProfile -ExecutionPolicy Bypass -File .\scripts\run.ps1' `
        -logFile (Join-Path $logDir 'collector.log') | Out-Null
}

if (-not $schedulerTracked) {
    Start-Component -name 'gold-scheduler' -pidFile 'gold-scheduler.pid' -workDir $backendRoot `
        -exe 'node.exe' -argString 'dist\scripts\gold-execution-scheduler.js' -logFile (Join-Path $logDir 'gold-scheduler.log') | Out-Null
}

Write-Host ""
Write-Host "This script starts BACKEND + COLLECTOR + GOLD-SCHEDULER ONLY."
Write-Host "Frontend is a SEPARATE, manual step - run 'npm run dev' in frontend/ yourself (its own dev server, 'next dev' - unchanged, not a build step)."
Write-Host "Run status-gold-demo.ps1 to check on everything."
