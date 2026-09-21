"""2026-09-15 follow-up — bounded live proof of the candle-sync lag fix.

Run from collector/:
  .venv\\Scripts\\python.exe ..\\backend\\research-output\\xauusd-h4-confirmed-retest-v1\\verification\\candle-sync-fix\\prove_candle_sync_fix.py <out.json>

Read-only. The fix is narrow and deliberately does NOT change what gets
stored: only the QUERY BOUND passed to copy_rates_range was broken (true-UTC
date_from/date_to compared against each bar's raw broker-mislabeled epoch,
silently excluding roughly the broker's own UTC-offset worth of the most
recent bars). r["time"] itself is left exactly as before — the collector has
always stored the raw, broker-mislabeled epoch for candles (unlike
positions/deals), and the confirmed-retest research layer's `data-source.ts`
(`wallClockToUtc`) already re-corrects it at read time to match millions of
already-stored rows; correcting it again here would double-convert every new
bar. See mt5_client.get_candles()'s own docstring for the full reasoning.

This compares, all captured within the same short window:
  1. An independently observed true UTC "now" (external HTTP Date header).
  2. The OLD bug, reproduced directly: true-UTC date_from/date_to passed
     straight to copy_rates_range — shows the newest bar it would return,
     and how recent that bar's TRUE UTC open time actually is once
     correctly re-interpreted (i.e. how stale the old code really was,
     despite its naive/mislabeled display looking nearly current).
  3. The FIXED code path (Mt5Client.get_candles): the newest closed M1 bar
     it returns, still in raw/mislabeled form (by design — see above), plus
     that same raw value correctly re-interpreted as true UTC for
     comparison against #1.
  4. The newest M1 candle currently stored in the database for XAUUSD (the
     only symbol collecting M1 so far) — i.e. what the running collector
     process (still on the old code until restarted) had synced.

This does not restart the live collector process — it proves the fix
function-by-function against the real terminal and real stored data.
"""
import json
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from zoneinfo import ZoneInfo

COLLECTOR = Path(__file__).resolve().parents[5] / "collector"
sys.path.insert(0, str(COLLECTOR))
from dotenv import load_dotenv  # noqa: E402

load_dotenv(COLLECTOR / ".env")
from app.config import Config  # noqa: E402
from app.mt5_client import Mt5Client, _mt5_time_to_utc, mt5  # noqa: E402


def external_utc() -> dict:
    url = "https://www.google.com"
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0 (candle-sync-fix-check)"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            header = resp.headers["Date"]
    except urllib.error.HTTPError as err:
        header = err.headers["Date"]
    return {"source": f"{url} HTTP Date header", "external_utc": parsedate_to_datetime(header).isoformat()}


def old_buggy_newest_bar(symbol: str, now: datetime) -> dict | None:
    """Reproduces the exact pre-fix call: true-UTC datetimes straight into
    copy_rates_range, no _utc_to_mt5_epoch conversion on the bound."""
    rows = mt5.copy_rates_range(symbol, mt5.TIMEFRAME_M1, now - timedelta(hours=6), now)
    if rows is None or len(rows) == 0:
        return {"row_count": 0}
    newest_raw = max(int(r["time"]) for r in rows)
    naive = datetime.fromtimestamp(newest_raw, tz=timezone.utc)
    true_utc = datetime.fromisoformat(_mt5_time_to_utc(newest_raw, "EET"))
    return {
        "row_count": len(rows),
        "raw_epoch": newest_raw,
        "old_code_stored_this_as_open_time": naive.isoformat(),
        "true_utc_this_bar_actually_opened_at": true_utc.isoformat(),
        "how_stale_the_old_code_really_was_seconds": (now - true_utc).total_seconds(),
        "how_fresh_the_old_code_looked_seconds": (now - naive).total_seconds(),
    }


def fixed_newest_bar(client: Mt5Client, symbol: str, now: datetime) -> dict | None:
    bars = client.get_candles(symbol, "M1", now - timedelta(hours=6), now)
    if not bars:
        return None
    newest = max(bars, key=lambda b: b["open_time"])
    raw_epoch = int(datetime.fromisoformat(newest["open_time"]).timestamp())
    true_utc = datetime.fromisoformat(_mt5_time_to_utc(raw_epoch, "EET"))
    return {
        "stored_open_time_raw_mislabeled_by_design": newest["open_time"],
        "true_utc_this_bar_actually_opened_at": true_utc.isoformat(),
        "how_fresh_seconds": (now - true_utc).total_seconds(),
    }


def db_newest_m1(symbol: str) -> dict | None:
    sql = (
        f"select to_char(max(open_time),'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') "
        f"from historical_candles where symbol='{symbol}' and timeframe='M1'"
    )
    out = subprocess.run(
        ["docker", "exec", "autonomous-trading-postgres", "psql", "-U", "autonomous_trading", "-d", "autonomous_trading", "-At", "-c", sql],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    if not out:
        return None
    stored_raw = out
    true_utc = datetime.fromisoformat(stored_raw.replace("Z", "")).replace(tzinfo=ZoneInfo("EET")).astimezone(timezone.utc)
    return {
        "latest_stored_open_time_raw_mislabeled": stored_raw,
        "true_utc_this_bar_actually_opened_at": true_utc.isoformat(),
    }


out_path = Path(sys.argv[1])
client = Mt5Client(Config.from_env())
res = client.connect()
if not res.ok:
    out_path.write_text(json.dumps({"connected": False, "error": res.error_message}, indent=2))
    sys.exit(1)

try:
    ext = external_utc()
    now = datetime.now(tz=timezone.utc)

    result = {
        "captured_at_system_utc": now.isoformat(),
        "external_utc_reference": ext,
        "note": "XAUUSD is the only symbol currently syncing M1 (CANDLE_TIMEFRAMES_XAUUSD); "
                "EURUSD's configured timeframes start at M5, so no EURUSD M1 comparison exists.",
        "symbols": {},
    }

    for symbol in ("EURUSD", "XAUUSD"):
        result["symbols"][symbol] = {
            "old_buggy_query_bound_reproduction": old_buggy_newest_bar(symbol, now),
            "fixed_code_path": fixed_newest_bar(client, symbol, now),
            "db_newest_stored_m1_under_still_running_old_code": db_newest_m1(symbol),
        }

    out_path.write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
finally:
    client.disconnect()
