# Watchdog for the gold DEMO collector - added after an incident
# (2026-09-16) where two untracked/duplicate `main.py` collector processes
# got stuck (near-zero CPU, zero log writes) for 11+ hours while the
# gold-execution scheduler kept cycling normally against stale/absent MT5
# data - nothing surfaced this until checked by hand at 10:48am. A bare
# "is the PID alive" check would NOT have caught this: the stuck process
# was still alive, just not doing anything. This script checks log
# freshness instead, which is the only reliable signal that the collector
# is actually cycling.
#
# Deliberately NOT a Windows Scheduled Task / service (same posture as
# start-gold-demo.ps1/stop-gold-demo.ps1 - see their headers for why) -
# run this by hand in its own PowerShell window and leave it running
# alongside the rest of the stack. Ctrl+C to stop watching (does not stop
# the collector itself).
#
# Each cycle (default every 60s):
#   1. Confirms collector.pid still points at a live, identity-checked
#      python.exe main.py process for THIS repo.
#   2. Confirms today's collector/logs/collector-<date>.log has been
#      written to within the staleness window (default 180s - the
#      collector normally cycles every ~10-60s).
#   3. On failure of either check: force-stops EVERY python.exe/
#      pythonw.exe process scoped to this repo's collector path + main.py
#      (not just the tracked one - duplicate untracked instances were the
#      actual root cause last time), plus any leftover run.ps1 wrapper,
#      then starts one fresh tracked collector instance.
#   4. Sends a Telegram alert (gold bot/chat - GOLD_TELEGRAM_BOT_TOKEN/
#      GOLD_TELEGRAM_CHAT_ID from backend/.env, same isolated gold
#      notification path gold-telegram.service.ts uses) on every restart,
#      and once when the watchdog itself starts, so a restart is never
#      silent.
#
# Usage: powershell -ExecutionPolicy Bypass -File backend\scripts\watch-gold-demo.ps1
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backendRoot = Join-Path $repoRoot 'backend'
$collectorRoot = Join-Path $repoRoot 'collector'
$runtimeDir = Join-Path $repoRoot '.gold-demo-runtime'
$logDir = Join-Path $runtimeDir 'logs'
$collectorPidFile = Join-Path $runtimeDir 'collector.pid'
$watchdogLog = Join-Path $logDir 'watchdog.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$staleAfterSeconds = 180
$checkIntervalSeconds = 60

function Write-Watchdog($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Write-Host $line
    Add-Content -Path $watchdogLog -Value $line
}

function Send-GoldTelegramAlert($text) {
    try {
        $envLines = Get-Content (Join-Path $backendRoot '.env') -ErrorAction Stop
        $token = (($envLines | Where-Object { $_ -match '^GOLD_TELEGRAM_BOT_TOKEN=' }) -replace '^GOLD_TELEGRAM_BOT_TOKEN=', '').Trim()
        $chatId = (($envLines | Where-Object { $_ -match '^GOLD_TELEGRAM_CHAT_ID=' }) -replace '^GOLD_TELEGRAM_CHAT_ID=', '').Trim()
        if (-not $token -or -not $chatId) {
            Write-Watchdog "telegram alert skipped: GOLD_TELEGRAM_BOT_TOKEN/GOLD_TELEGRAM_CHAT_ID not found in backend/.env"
            return
        }
        $uri = "https://api.telegram.org/bot$token/sendMessage"
        $body = @{ chat_id = $chatId; text = $text } | ConvertTo-Json
        Invoke-RestMethod -Uri $uri -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 15 | Out-Null
    } catch {
        Write-Watchdog "telegram alert failed: $($_.Exception.Message)"
    }
}

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

function Get-ScopedProcesses($processName, [string[]]$requiredSubstrings) {
    $rows = Get-CimInstance Win32_Process -Filter "Name = '$processName'" -ErrorAction SilentlyContinue
    $found = @()
    foreach ($row in $rows) {
        if (-not $row.CommandLine) { continue }
        $allMatch = $true
        foreach ($s in $requiredSubstrings) {
            if ($row.CommandLine -notlike "*$s*") { $allMatch = $false; break }
        }
        if ($allMatch) { $found += $row }
    }
    return $found
}

function Stop-AllCollectorProcesses {
    foreach ($procName in @('python.exe', 'pythonw.exe')) {
        $procs = Get-ScopedProcesses $procName @($collectorRoot, 'main.py')
        foreach ($p in $procs) {
            Write-Watchdog "stopping stuck/duplicate collector process pid=$($p.ProcessId) ($procName)"
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    $wrappers = Get-ScopedProcesses 'powershell.exe' @($collectorRoot, 'run.ps1')
    foreach ($p in $wrappers) {
        Write-Watchdog "stopping collector wrapper pid=$($p.ProcessId)"
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Start-Collector {
    Remove-Item $collectorPidFile -ErrorAction SilentlyContinue
    $proc = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File .\scripts\run.ps1' `
        -WorkingDirectory $collectorRoot `
        -RedirectStandardOutput (Join-Path $logDir 'collector.log') `
        -RedirectStandardError (Join-Path $logDir 'collector.log.err') `
        -WindowStyle Hidden -PassThru
    Set-Content -Path $collectorPidFile -Value $proc.Id
    Write-Watchdog "collector restarted, pid=$($proc.Id)"
}

function Get-TodaysCollectorLogPath {
    Join-Path (Join-Path $collectorRoot 'logs') ("collector-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
}

Write-Watchdog "watchdog started (check interval ${checkIntervalSeconds}s, stale threshold ${staleAfterSeconds}s)"
Send-GoldTelegramAlert "gold watchdog: started monitoring the collector."

while ($true) {
    # collector.pid tracks the run.ps1 wrapper's PID (powershell.exe), same
    # convention start-gold-demo.ps1/status-gold-demo.ps1 use - NOT the
    # python.exe child it spawns.
    $pidAlive = Test-PidAlive $collectorPidFile 'powershell.exe' @('scripts\run.ps1')

    $logPath = Get-TodaysCollectorLogPath
    $logFresh = $false
    if (Test-Path $logPath) {
        $age = (Get-Date) - (Get-Item $logPath).LastWriteTime
        $logFresh = $age.TotalSeconds -lt $staleAfterSeconds
    }

    if (-not $pidAlive -or -not $logFresh) {
        $reason = if (-not $pidAlive) { "tracked collector process not alive" } else { "collector log stale (no write in ${staleAfterSeconds}s+) - process is running but stuck" }
        Write-Watchdog "PROBLEM DETECTED: $reason - restarting collector"
        Stop-AllCollectorProcesses
        Start-Sleep -Seconds 2
        Start-Collector
        Send-GoldTelegramAlert "gold watchdog: collector was stuck/down ($reason). Killed and restarted it automatically."
    }

    Start-Sleep -Seconds $checkIntervalSeconds
}
