# Manual stop script for xauusd-m1-m5-rsi-threshold-v2.
#
# ============================================================================
# THIS SCRIPT NEVER KILLS A PROCESS BY NAME.
#
# Another trading system is running on this machine, from
# `trading-monitor-autonomous`, on its own DEMO account. Its trading process
# is also `node.exe`, and its collector is also `python.exe`. A
# `Stop-Process -Name node` here would stop it, and on a Friday evening that
# would leave its positions open over the weekend with nothing to liquidate
# them.
#
# So every process this script stops must satisfy BOTH:
#   1. its PID came from one of THIS script's own lock files, and
#   2. its command line still contains THIS repository's path.
#
# A lock file whose PID now belongs to something else is reported and skipped,
# never killed. Windows reuses PIDs.
# ============================================================================
#
# WHAT STOPPING MEANS, stated plainly because it is easy to forget:
#
#   Once stopped, nothing observes RSI, no position is monitored, protection
#   is not remediated, and the Friday pre-weekend liquidation does not run.
#   Open positions keep their broker-side SL and TP -- those live at the broker
#   and survive this -- but nothing else is watching them.
#
# Usage: powershell -ExecutionPolicy Bypass -File backend\scripts\stop-xauusd-m1m5.ps1
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backendRoot = Join-Path $repoRoot 'backend'
$collectorRoot = Join-Path $repoRoot 'collector'
$runtimeDir = Join-Path $repoRoot '.xauusd-m1m5-runtime'

if (-not (Test-Path $runtimeDir)) {
    Write-Host "No runtime directory at $runtimeDir -- nothing was started by this script."
    exit 0
}

# Each entry: the lock file, the process name it must be, and substrings its
# command line must contain. The repo path is in every one of them.
$components = @(
    @{ Name = 'Strategy watch'; PidFile = 'm1m5-scheduler.pid'; Process = 'node.exe';       Required = @($backendRoot, 'xauusd-m1m5-scheduler.js') },
    @{ Name = 'Collector';      PidFile = 'collector.pid';      Process = 'powershell.exe'; Required = @($collectorRoot, 'scripts\run.ps1') },
    @{ Name = 'Backend';        PidFile = 'backend.pid';        Process = 'node.exe';       Required = @($backendRoot, 'dist\src\main.js') }
)

function Get-VerifiedProcess($pidPath, $expectedProcessName, [string[]]$requiredSubstrings) {
    if (-not (Test-Path $pidPath)) { return $null }
    $storedPid = Get-Content $pidPath -ErrorAction SilentlyContinue
    if (-not $storedPid) { return $null }
    $row = Get-CimInstance Win32_Process -Filter "ProcessId = $storedPid" -ErrorAction SilentlyContinue
    if (-not $row) { return @{ Stale = $true; Pid = $storedPid; Reason = 'no process with that pid' } }
    if ($row.Name -ne $expectedProcessName) {
        return @{ Stale = $true; Pid = $storedPid; Reason = "pid is now '$($row.Name)', not '$expectedProcessName'" }
    }
    if (-not $row.CommandLine) {
        return @{ Stale = $true; Pid = $storedPid; Reason = 'command line unreadable, cannot verify identity' }
    }
    foreach ($s in $requiredSubstrings) {
        if ($row.CommandLine -notlike "*$s*") {
            return @{ Stale = $true; Pid = $storedPid; Reason = "command line does not contain '$s' -- this pid belongs to something else" }
        }
    }
    return @{ Stale = $false; Pid = [int]$storedPid; Row = $row }
}

$stopped = 0
$skipped = 0

# Stopped in this order deliberately: the strategy watch first, so no new
# decision can be produced while the backend is still up to serve it.
foreach ($c in $components) {
    $pidPath = Join-Path $runtimeDir $c.PidFile
    $verified = Get-VerifiedProcess $pidPath $c.Process $c.Required

    if ($null -eq $verified) {
        Write-Host "$($c.Name): no lock file, nothing to stop."
        continue
    }
    if ($verified.Stale) {
        Write-Host "$($c.Name): lock file pid $($verified.Pid) is stale ($($verified.Reason)). NOT killing it." -ForegroundColor Yellow
        Remove-Item $pidPath -ErrorAction SilentlyContinue
        $skipped += 1
        continue
    }

    Write-Host "$($c.Name): stopping verified pid $($verified.Pid) ..."
    Stop-Process -Id $verified.Pid -Force -ErrorAction SilentlyContinue

    # Confirm it is actually gone rather than assuming the request worked.
    Start-Sleep -Milliseconds 500
    $still = Get-CimInstance Win32_Process -Filter "ProcessId = $($verified.Pid)" -ErrorAction SilentlyContinue
    if ($still) {
        Write-Host "  WARNING: pid $($verified.Pid) is still present after the stop request." -ForegroundColor Red
    } else {
        Remove-Item $pidPath -ErrorAction SilentlyContinue
        $stopped += 1
    }
}

Write-Host ""
Write-Host "Stopped $stopped process(es); skipped $skipped stale lock file(s)."
Write-Host ""
Write-Host "Nothing now observes RSI for this strategy, and its Friday liquidation will not run." -ForegroundColor Yellow
Write-Host "Any open position keeps its broker-side SL and TP, which live at the broker and are unaffected."
Write-Host ""
Write-Host "The other trading system on this machine was not touched."
