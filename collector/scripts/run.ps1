# Production-readiness review, item 2 - the actual process the scheduled
# task launches. Runs the collector using its own venv (never the system
# Python, which may not have MetaTrader5/requests/etc. installed), from the
# collector's own directory (so main.py's relative imports and .env
# discovery work exactly as they do when run by hand), with stdout/stderr
# captured to a dated log file so a crash leaves a trail to read afterward.
$ErrorActionPreference = 'Stop'

$collectorRoot = Split-Path -Parent $PSScriptRoot
Set-Location -Path $collectorRoot

$logDir = Join-Path $collectorRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("collector-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

$python = Join-Path $collectorRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
    throw "Collector venv not found at $python - run: python -m venv .venv; .venv\Scripts\pip install -r requirements.txt"
}

& $python 'main.py' *>> $logFile
exit $LASTEXITCODE
