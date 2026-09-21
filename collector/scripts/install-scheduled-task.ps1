# Production-readiness review, item 2 - installs the collector as a Windows
# Scheduled Task instead of a Windows Service, deliberately: MT5's terminal
# is a GUI application that needs an interactive desktop session to run
# (a Service running as SYSTEM/non-interactive cannot drive it), so this
# task triggers "at log on" for the current user and runs only while that
# user is logged on - the same session context as running it by hand.
#
# Crash recovery: RestartCount/RestartInterval below make Task Scheduler
# itself relaunch the process if it exits with a failure code, without any
# third-party tool (NSSM, etc.) installed. Reboot recovery: the "at log on"
# trigger means it starts again the moment you log back in after a restart.
#
# Run this once, from an elevated or normal PowerShell (no admin required):
#   powershell -ExecutionPolicy Bypass -File install-scheduled-task.ps1

$ErrorActionPreference = 'Stop'
$taskName = 'TradingBehaviorMonitorCollector'
$runScript = Join-Path $PSScriptRoot 'run.ps1'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runScript`""

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null

Write-Host "Registered scheduled task '$taskName' - starts at your next log on, and restarts up to 999 times (1 min apart) if the collector process ever exits with a failure."
Write-Host "To start it right now without logging off/on again: Start-ScheduledTask -TaskName '$taskName'"
Write-Host "To check its status: Get-ScheduledTaskInfo -TaskName '$taskName'"
Write-Host "To remove it: .\uninstall-scheduled-task.ps1"
