# Gracefully stops ONLY the PIDs recorded by start-gold-demo.ps1  -  never a
# blanket node/python kill, never touches legacy processes. Engages the gold
# kill switch FIRST (the only live, no-restart-needed lever this codebase
# actually has  -  GOLD_STOP_NEW_ENTRIES is a raw env var read at process
# start, so it cannot be flipped live without restarting the very process
# this script is about to stop anyway) so no new gold entry can slip in
# during shutdown. Never closes open broker positions  -  reports them
# instead, since monitoring (protection checks, closure reconciliation)
# stops the moment these processes stop.
#
# Usage: powershell -ExecutionPolicy Bypass -File backend\scripts\stop-gold-demo.ps1
$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backendRoot = Join-Path $repoRoot 'backend'
$runtimeDir = Join-Path $repoRoot '.gold-demo-runtime'

# --- 1. Engage the gold kill switch first ---
$goldSwitchPath = Join-Path $backendRoot 'GOLD_KILL_SWITCH'
$envGoldPath = Get-Content (Join-Path $backendRoot '.env') -ErrorAction SilentlyContinue | Where-Object { $_ -match '^GOLD_KILL_SWITCH_PATH=' }
if ($envGoldPath) {
    $parsed = ($envGoldPath -split '=', 2)[1].Trim()
    if ($parsed) { $goldSwitchPath = $parsed }
}
if (-not (Test-Path $goldSwitchPath)) {
    "stopped via stop-gold-demo.ps1 at $(Get-Date -Format o)" | Set-Content -Path $goldSwitchPath
    Write-Host "Engaged gold kill switch at $goldSwitchPath before stopping anything."
} else {
    Write-Host "Gold kill switch already engaged at $goldSwitchPath."
}

# --- 2. Stop only our own tracked PIDs, gracefully (CloseMainWindow, then a bounded wait; no /F kill of anything we didn't start) ---
function Stop-Component($name, $pidFile) {
    $pidPath = Join-Path $runtimeDir $pidFile
    if (-not (Test-Path $pidPath)) {
        Write-Host "$name : no lock file, nothing to stop."
        return
    }
    $storedPid = Get-Content $pidPath -ErrorAction SilentlyContinue
    $proc = Get-Process -Id $storedPid -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Host "$name : lock file present but pid $storedPid is not running  -  removing stale lock."
        Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
        return
    }
    Write-Host "Stopping $name (pid $storedPid) ..."
    try {
        Stop-Process -Id $storedPid -ErrorAction Stop
        Start-Sleep -Seconds 2
        if (Get-Process -Id $storedPid -ErrorAction SilentlyContinue) {
            Write-Warning "$name (pid $storedPid) did not exit within 2s of Stop-Process  -  check it manually, it was NOT force-killed by this script."
        } else {
            Write-Host "$name stopped."
            Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Warning "Failed to stop $name (pid $storedPid): $_"
    }
}

Stop-Component 'gold-scheduler' 'gold-scheduler.pid'
Stop-Component 'collector' 'collector.pid'
Stop-Component 'backend' 'backend.pid'

# --- 3. Report any still-open gold position + SL/TP, from the last snapshot in Postgres, since monitoring stops here ---
Write-Host ""
Write-Host "== open gold positions at time of shutdown (monitoring stops now  -  check these manually / re-verify on next start) =="
Push-Location $backendRoot
try {
    $query = @'
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
(async () => {
  const positions = await prisma.position.findMany({
    where: { symbol: "XAUUSD", status: "OPEN" },
    select: { externalPositionId: true, side: true, volume: true, openPrice: true, stopLoss: true, takeProfit: true, profit: true },
  });
  if (positions.length === 0) {
    console.log("  none open");
  } else {
    for (const p of positions) {
      console.log(`  position=${p.externalPositionId} side=${p.side} volume=${p.volume} openPrice=${p.openPrice} stopLoss=${p.stopLoss ?? "NONE"} takeProfit=${p.takeProfit ?? "NONE"} floatingProfit=${p.profit}`);
    }
  }
  await prisma.$disconnect();
})().catch((err) => { console.error("  could not query open positions:", err.message); process.exit(1); });
'@
    $query | node --input-type=commonjs
} catch {
    Write-Warning "Could not query open gold positions (Postgres/Prisma unavailable): $_"
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "Open broker positions are NOT closed by this script  -  close them manually via your broker terminal or the dashboard's scoped close action if needed."
