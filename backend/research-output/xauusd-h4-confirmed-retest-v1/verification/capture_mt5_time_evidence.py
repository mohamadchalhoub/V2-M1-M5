"""Verification pass (2026-09-15) — read-only capture of MT5 time-basis evidence.

Run from collector/:  .venv\\Scripts\\python.exe ..\\backend\\research-output\\xauusd-h4-confirmed-retest-v1\\verification\\capture_mt5_time_evidence.py <out.json>

Read-only: uses only Mt5Client.connect/disconnect and the MetaTrader5 read
functions copy_rates_from_pos, copy_rates_range, symbol_info_tick,
account_info, terminal_info. No order function is imported or called.

Timing reference: the HTTP `Date` header of an external server is fetched
immediately before and after the MT5 calls, alongside the local system clock,
so "true UTC" is not taken on trust from this machine.
"""
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

COLLECTOR = Path(__file__).resolve().parents[4] / "collector"
sys.path.insert(0, str(COLLECTOR))
from dotenv import load_dotenv  # noqa: E402

load_dotenv(COLLECTOR / ".env")
from app.config import Config  # noqa: E402
from app.mt5_client import Mt5Client, mt5  # noqa: E402


def external_utc() -> dict:
    url = "https://www.google.com"
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0 (time-evidence-check)"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            header = resp.headers["Date"]
    except urllib.error.HTTPError as err:  # the Date header is still a valid clock reading
        header = err.headers["Date"]
    return {"source": f"{url} HTTP Date header", "external_utc": parsedate_to_datetime(header).isoformat(), "system_utc": datetime.now(timezone.utc).isoformat()}


def naive(epoch_seconds: float) -> str:
    return datetime.fromtimestamp(epoch_seconds, tz=timezone.utc).isoformat()


def bars(rows) -> list:
    return [
        {"raw_time": int(r["time"]), "naive_decoded_as_utc": naive(int(r["time"])), "open": float(r["open"]), "high": float(r["high"]), "low": float(r["low"]), "close": float(r["close"])}
        for r in (rows if rows is not None else [])
    ]


out_path = Path(sys.argv[1])
client = Mt5Client(Config.from_env())
res = client.connect()
if not res.ok:
    out_path.write_text(json.dumps({"connected": False, "error": res.error_message}, indent=2))
    sys.exit(1)

try:
    evidence: dict = {"clock_before": external_utc()}
    acct = mt5.account_info()
    term = mt5.terminal_info()
    evidence["account"] = {"login": acct.login, "server": acct.server, "trade_mode": acct.trade_mode, "currency": acct.currency}
    evidence["terminal"] = {"build": term.build, "connected": term.connected}

    ticks = []
    for _ in range(2):
        t = mt5.symbol_info_tick("XAUUSD")
        now = datetime.now(timezone.utc)
        ticks.append({
            "system_utc": now.isoformat(),
            "tick_time_raw": int(t.time),
            "tick_time_naive_as_utc": naive(t.time),
            "tick_time_msc_raw": int(t.time_msc),
            "tick_time_msc_naive_as_utc": naive(t.time_msc / 1000),
            "time_msc_minus_system_hours": round((t.time_msc / 1000 - now.timestamp()) / 3600, 4),
            "bid": t.bid,
            "ask": t.ask,
        })
        time.sleep(4)
    evidence["xauusd_ticks_4s_apart"] = ticks

    now = datetime.now(timezone.utc)
    evidence["position_based_no_datetime_argument"] = {
        "system_utc_at_call": now.isoformat(),
        "XAUUSD_M1_pos0_3": bars(mt5.copy_rates_from_pos("XAUUSD", mt5.TIMEFRAME_M1, 0, 3)),
        "EURUSD_M1_pos0_3": bars(mt5.copy_rates_from_pos("EURUSD", mt5.TIMEFRAME_M1, 0, 3)),
        "XAUUSD_H4_pos0_40": bars(mt5.copy_rates_from_pos("XAUUSD", mt5.TIMEFRAME_H4, 0, 40)),
        "EURUSD_M5_pos0_80": bars(mt5.copy_rates_from_pos("EURUSD", mt5.TIMEFRAME_M5, 0, 80)),
    }

    now = datetime.now(timezone.utc)
    date_to = now - timedelta(hours=3)
    rng = mt5.copy_rates_range("XAUUSD", mt5.TIMEFRAME_M1, now - timedelta(hours=4), date_to)
    rng_bars = bars(rng)
    evidence["datetime_bound_test"] = {
        "system_utc": now.isoformat(),
        "date_to_passed_true_utc": date_to.isoformat(),
        "rows": len(rng_bars),
        "last_row": rng_bars[-1] if rng_bars else None,
    }
    evidence["clock_after"] = external_utc()
    out_path.write_text(json.dumps(evidence, indent=2))
    print(json.dumps({k: evidence[k] for k in ("clock_before", "account", "xauusd_ticks_4s_apart", "datetime_bound_test", "clock_after")}, indent=2))
    pos = evidence["position_based_no_datetime_argument"]
    print("XAUUSD M1 pos0..2:", [b["naive_decoded_as_utc"] for b in pos["XAUUSD_M1_pos0_3"]], "system:", pos["system_utc_at_call"])
    print("EURUSD M1 pos0..2:", [b["naive_decoded_as_utc"] for b in pos["EURUSD_M1_pos0_3"]])
finally:
    client.disconnect()
