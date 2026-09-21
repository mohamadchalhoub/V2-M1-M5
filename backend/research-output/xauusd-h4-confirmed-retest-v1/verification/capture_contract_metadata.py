"""Verification pass — read-only capture of live XAUUSD contract metadata and
the fixed-volume stop-risk arithmetic. No order function imported or called.

Run from collector/:  .venv\\Scripts\\python.exe <this file> <out.json>
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

COLLECTOR = Path(__file__).resolve().parents[4] / "collector"
sys.path.insert(0, str(COLLECTOR))
from dotenv import load_dotenv  # noqa: E402

load_dotenv(COLLECTOR / ".env")
from app.config import Config  # noqa: E402
from app.mt5_client import Mt5Client, mt5  # noqa: E402

VOLUME_LOTS = 0.01          # frozen v1 volume (unchanged)
STOP_DISTANCE_PRICE = 10.0  # frozen v1 stop distance in XAUUSD price units (unchanged)
CAPS = {"maxStopRiskPctOfEquity": 0.5, "maxCombinedRiskPctOfEquity": 1.0}  # frozen v1 caps (unchanged)

client = Mt5Client(Config.from_env())
if not client.connect().ok:
    sys.exit("MT5 connect failed")
try:
    s = mt5.symbol_info("XAUUSD")
    a = mt5.account_info()
    ticks_in_stop = STOP_DISTANCE_PRICE / s.trade_tick_size
    by_contract = VOLUME_LOTS * s.trade_contract_size * STOP_DISTANCE_PRICE          # in profit currency
    by_tick_value = VOLUME_LOTS * ticks_in_stop * s.trade_tick_value_loss              # in account currency, CURRENT rates
    evidence = {
        "captured_utc": datetime.now(timezone.utc).isoformat(),
        "account": {"server": a.server, "currency": a.currency, "trade_mode": a.trade_mode},
        "symbol_info": {k: getattr(s, k) for k in (
            "digits", "point", "trade_tick_size", "trade_tick_value", "trade_tick_value_profit", "trade_tick_value_loss",
            "trade_contract_size", "volume_min", "volume_step", "currency_base", "currency_profit", "currency_margin")},
        "frozen_inputs": {"volume_lots": VOLUME_LOTS, "stop_distance_price": STOP_DISTANCE_PRICE, **CAPS},
        "stop_risk": {
            "by_contract_size_in_profit_currency": {"value": by_contract, "currency": s.currency_profit,
                                                    "formula": "volume_lots * trade_contract_size * stop_distance"},
            "by_tick_value_in_account_currency_at_current_rates": {"value": by_tick_value, "currency": a.currency,
                                                                   "formula": "volume_lots * (stop_distance / trade_tick_size) * trade_tick_value_loss",
                                                                   "caveat": "tick value is quoted in account currency at the CURRENT conversion rate; not a historical cost"},
        },
        "minimum_nominal_equity_for_caps": {
            "stop_risk_0_5pct_usd": by_contract / (CAPS["maxStopRiskPctOfEquity"] / 100),
            "combined_risk_1pct_usd": by_contract / (CAPS["maxCombinedRiskPctOfEquity"] / 100),
            "stop_risk_0_5pct_account_ccy_current_rate": by_tick_value / (CAPS["maxStopRiskPctOfEquity"] / 100),
        },
    }
    Path(sys.argv[1]).write_text(json.dumps(evidence, indent=2))
    print(json.dumps(evidence, indent=2))
finally:
    client.disconnect()
