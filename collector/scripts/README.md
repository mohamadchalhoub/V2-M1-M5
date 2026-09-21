# Collector persistence (production-readiness review, item 2)

Runs the MT5 collector as a Windows Scheduled Task: starts automatically at
log on, and restarts itself (up to 999 times, 1 minute apart) if the Python
process ever exits with a failure — no third-party service manager
installed.

A Scheduled Task, not a Windows Service, deliberately: MT5's terminal is a
GUI application that needs an interactive desktop session, which a Service
running as SYSTEM cannot provide.

## Install

```
powershell -ExecutionPolicy Bypass -File install-scheduled-task.ps1
```

**If this fails with "Access is denied"**, run it from an **elevated**
PowerShell (right-click PowerShell → Run as administrator) instead — this
was the case on the machine this was built on; task registration for a
per-user logon trigger doesn't normally require elevation on Windows, but
this account's Task Scheduler access is evidently locked down.

## Check status

```
Get-ScheduledTaskInfo -TaskName TradingBehaviorMonitorCollector
```

## Start it immediately (without logging off/on)

```
Start-ScheduledTask -TaskName TradingBehaviorMonitorCollector
```

## Logs

`collector/logs/collector-YYYY-MM-DD.log` — one file per day, stdout+stderr
of every run (including crash tracebacks), so a restart leaves a trail to
read afterward.

## Uninstall

```
powershell -ExecutionPolicy Bypass -File uninstall-scheduled-task.ps1
```

## What this does and doesn't cover

- **Covers**: Python process crash (restarts within 1 minute), Windows
  reboot (starts again at next log on).
- **Does not cover**: the collector's own MT5 reconnect logic — that's
  already handled inside the process itself (`app/runner.py`'s exponential
  backoff), not by this task.
- **Read-only boundary unchanged**: this only controls *when the process
  runs*, never what it does — nothing here touches `app/mt5_client.py`.
