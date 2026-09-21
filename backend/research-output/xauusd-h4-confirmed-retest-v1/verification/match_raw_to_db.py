"""Verification pass — joins raw MT5 bars captured by capture_mt5_time_evidence.py
to stored historical_candles rows, and applies the research conversion.

Read-only: SELECT via `docker exec ... psql`. Writes one JSON export.

For every raw bar it records: raw epoch -> Python naive-UTC decode (exactly
mt5_client.get_candles line 408) -> the ISO string the collector sends as
`openTime` -> the stored open_time and OHLC (if a row exists) -> true UTC via
IANA `EET` (research data-source.ts wallClockToUtc) -> Asia/Beirut wall clock.
"""
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

here = Path(__file__).resolve().parent
evidence = json.loads((here / "mt5-live-time-evidence.json").read_text())
pos = evidence["position_based_no_datetime_argument"]


def db_rows(symbol: str, timeframe: str, start: str, end: str) -> dict:
    sql = (
        "select to_char(open_time,'YYYY-MM-DD\"T\"HH24:MI:SS'), open, high, low, close "
        f"from historical_candles where symbol='{symbol}' and timeframe='{timeframe}' "
        f"and open_time between '{start}' and '{end}' order by open_time"
    )
    out = subprocess.run(
        ["docker", "exec", "autonomous-trading-postgres", "psql", "-U", "autonomous_trading", "-d", "autonomous_trading", "-At", "-F", "|", "-c", sql],
        capture_output=True, text=True, check=True,
    ).stdout
    rows = {}
    for line in out.strip().splitlines():
        t, o, h, l, c = line.split("|")
        rows[t] = {"open": float(o), "high": float(h), "low": float(l), "close": float(c)}
    return rows


def research_utc(naive_iso: str) -> datetime:
    wall = datetime.fromisoformat(naive_iso.replace("+00:00", ""))
    return wall.replace(tzinfo=ZoneInfo("EET")).astimezone(timezone.utc)


BROKER_DIGITS = {"XAUUSD": 2, "EURUSD": 5}  # symbol_info().digits


def trace(symbol: str, timeframe: str, raw_bars: list) -> dict:
    digits = BROKER_DIGITS[symbol]
    keys = [b["naive_decoded_as_utc"].replace("+00:00", "") for b in raw_bars]
    stored = db_rows(symbol, timeframe, min(keys), max(keys))
    records = []
    for b, key in zip(raw_bars, keys):
        row = stored.get(key)
        true_utc = research_utc(b["naive_decoded_as_utc"])
        records.append({
            "raw_mt5_time_epoch": b["raw_time"],
            "python_get_candles_decode": b["naive_decoded_as_utc"],
            "api_payload_openTime": b["naive_decoded_as_utc"],
            "db_open_time": key if row else None,
            "ohlc_raw": [b["open"], b["high"], b["low"], b["close"]],
            "ohlc_db": [row["open"], row["high"], row["low"], row["close"]] if row else None,
            "ohlc_exact_match": (row is not None and [row["open"], row["high"], row["low"], row["close"]] == [b["open"], b["high"], b["low"], b["close"]]),
            "ohlc_equal_at_broker_digits": (row is not None and [round(row[k], digits) for k in ("open", "high", "low", "close")] == [round(b[k], digits) for k in ("open", "high", "low", "close")]),
            "research_true_utc_via_EET": true_utc.isoformat(),
            "asia_beirut_wall_clock": true_utc.astimezone(ZoneInfo("Asia/Beirut")).isoformat(),
        })
    matched = [r for r in records if r["db_open_time"]]
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "raw_bars": len(records),
        "db_rows_matched_by_identical_open_time": len(matched),
        "ohlc_exact_float_matches": sum(r["ohlc_exact_match"] for r in matched),
        "ohlc_equal_at_broker_digits": sum(r["ohlc_equal_at_broker_digits"] for r in matched),
        "broker_digits": digits,
        "note": "exact-float mismatches are float64 representation noise (e.g. 1.1555900000000001 vs 1.15559); compare at broker digits",
        "raw_bars_without_db_row": [r["python_get_candles_decode"] for r in records if not r["db_open_time"]],
        "records": records,
    }


result = {
    "captured": evidence["clock_before"],
    "chain_code_references": {
        "raw_epoch": "MetaTrader5 copy_rates_range / copy_rates_from_pos -> rates['time']",
        "python_decode": "collector/app/mt5_client.py get_candles(): datetime.fromtimestamp(int(r['time']), tz=timezone.utc).isoformat()  (line 408)",
        "api_payload": "collector/app/api_mapper.py build_candles_payload(): 'openTime': c['open_time']  (line 121)",
        "dto": "backend/src/market-data/dto/candles-push.dto.ts IncomingCandleDto.openTime @IsISO8601",
        "db_write": "backend/src/market-data/historical-candle.service.ts: new Date(c.openTime) into INSERT ... open_time (line 54)",
        "db_column": "historical_candles.open_time TIMESTAMP(3) without time zone (migration 20260906203717_add_historical_candles)",
        "research_read": "backend/src/research/confirmed-retest/data-source.ts loadSeries(): EXTRACT(EPOCH FROM open_time) -> wallClockToUtc('EET', serverT)",
    },
    "traces": [
        trace("XAUUSD", "H4", pos["XAUUSD_H4_pos0_40"]),
        trace("EURUSD", "M5", pos["EURUSD_M5_pos0_80"]),
    ],
}
out = here / "raw-to-db-trace.json"
out.write_text(json.dumps(result, indent=2))
for t in result["traces"]:
    print(f"{t['symbol']} {t['timeframe']}: raw={t['raw_bars']} matched={t['db_rows_matched_by_identical_open_time']} exactFloat={t['ohlc_exact_float_matches']} brokerDigitsEqual={t['ohlc_equal_at_broker_digits']}")
    m = [r for r in t["records"] if r["db_open_time"]]
    if m:
        print("  example:", json.dumps(m[-1]))
print(f"wrote {out}")
sys.exit(0)
