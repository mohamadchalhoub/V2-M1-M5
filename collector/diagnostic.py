"""Safe, read-only MT5 connectivity diagnostic.

    python diagnostic.py

Connects to the locally running MT5 terminal (via app.mt5_client — the ONLY
module in this project allowed to import the MetaTrader5 package, and it
exposes no order-placing capability at all: no order_send, no order_check,
no order_calc_*, nothing that can open, modify, or close a trade) and prints
a plain-text report of the account/terminal/position/deal state.

Never sends anything anywhere: no HTTP POST to the backend, no Telegram
message. The one optional network call it makes is a read-only GET to the
backend's collector heartbeat endpoint (only if COLLECTOR_API_BASE_URL/
COLLECTOR_API_KEY/COLLECTOR_ACCOUNT_ID are already configured in .env), to
report when the collector last successfully pushed data — skipped entirely,
with a clear note, if those aren't set yet.

Never prints: MT5_PASSWORD, COLLECTOR_API_KEY, or any other credential.
"""
from __future__ import annotations

import sys

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from app.config import Config, ConfigError

# Config.from_env() requires COLLECTOR_API_BASE_URL/COLLECTOR_API_KEY/
# COLLECTOR_ACCOUNT_ID (the collector's normal, backend-push mode) — this
# diagnostic is meant to also work BEFORE that setup step, so if those
# specifically are what's missing, retry with harmless placeholders. Mt5Client
# never reads any of the three; they only matter if we go on to call the
# heartbeat endpoint below, which checks for the real values itself first.
_PLACEHOLDER_BACKEND_ENV = {
    "COLLECTOR_API_BASE_URL": "http://localhost:3000",
    "COLLECTOR_API_KEY": "diagnostic-placeholder",
    "COLLECTOR_ACCOUNT_ID": "diagnostic-placeholder",
}


def _load_config() -> Config:
    import os

    try:
        return Config.from_env()
    except ConfigError as exc:
        if "backend-push configuration" not in str(exc):
            raise
        merged = dict(os.environ)
        for key, value in _PLACEHOLDER_BACKEND_ENV.items():
            merged.setdefault(key, value)
        return Config.from_env(merged)


def _fmt(value: object, unit: str = "") -> str:
    if value is None:
        return "n/a"
    return f"{value}{unit}"


def main() -> int:
    config = _load_config()

    # Imported here, not at module scope — same reasoning as main.py: a
    # config error above should surface without needing MetaTrader5
    # (Windows-only) importable first.
    from app.mt5_client import Mt5Client

    client = Mt5Client(config)
    print("=" * 72)
    print("MT5 DIAGNOSTIC REPORT")
    print("=" * 72)

    result = client.connect()
    if not result.ok:
        print("MT5 connected: NO")
        print(f"  error_code:    {result.error_code}")
        print(f"  error_message: {result.error_message}")
        print()
        print("Nothing else to report — the terminal connection itself failed.")
        print("See STEP-BY-STEP guidance in collector/README.md / the live-test procedure.")
        return 1

    try:
        connected = client.is_connected()
        print(f"MT5 connected: {'YES' if connected else 'NO (initialized, but terminal reports no broker link)'}")

        account = client.get_account_info()
        if account is None:
            print("Account info: unavailable (terminal returned no data)")
        else:
            print(f"Account:        {account.get('login')}")
            print(f"Broker/server:  {account.get('server')}")
            print(f"Currency:       {account.get('currency')}")
            print(f"Leverage:       1:{account.get('leverage')}")
            print(f"Balance:        {_fmt(account.get('balance'))}")
            print(f"Equity:         {_fmt(account.get('equity'))}")
            print(f"Margin:         {_fmt(account.get('margin'))}")
            print(f"Free margin:    {_fmt(account.get('margin_free'))}")
            print(f"Margin level:   {_fmt(account.get('margin_level'), '%')}")
            print(f"Floating P/L:   {_fmt(account.get('profit'))}")
            print(f"Trade allowed:  {account.get('trade_allowed')}  (terminal-level flag only - this collector never trades regardless)")

        positions = client.get_open_positions()
        deals = client.get_recent_deals(days=config.history_days)
        print(f"Open positions: {len(positions)}")
        print(f"Recent deals ({config.history_days}d): {len(deals)}")

        last_collection = _last_successful_collection(config)
        print(f"Last successful collection (backend heartbeat): {last_collection}")

        if positions:
            print()
            print("-" * 72)
            print("OPEN POSITIONS")
            print("-" * 72)
            for p in positions:
                sl = p.get("sl") or None
                tp = p.get("tp") or None
                print(
                    f"  #{p.get('ticket')}  {p.get('symbol')}  {p.get('side')}  vol={p.get('volume')}\n"
                    f"      entry={p.get('price_open')}  current={p.get('price_current')}  "
                    f"P/L={p.get('profit')}  swap={p.get('swap')}\n"
                    f"      SL={_fmt(sl)}  TP={_fmt(tp)}"
                    + ("  [WARNING: NO STOP LOSS]" if sl is None else "")
                    + f"\n      magic={p.get('raw', {}).get('magic')}  comment={p.get('comment') or ''}"
                )
        else:
            print()
            print("OPEN POSITIONS: none")

        print("=" * 72)
        return 0
    finally:
        client.disconnect()


def _last_successful_collection(config: Config) -> str:
    """Read-only GET against the backend's own heartbeat endpoint — the same
    one the live collector loop already writes to every push. Never a POST,
    never modifies anything. Skipped entirely if the backend-push env vars
    aren't configured yet (this diagnostic must also work before that step)."""
    import os

    if any(k not in os.environ for k in ("COLLECTOR_API_BASE_URL", "COLLECTOR_API_KEY", "COLLECTOR_ACCOUNT_ID")):
        return "not available — COLLECTOR_API_BASE_URL/API_KEY/ACCOUNT_ID not configured yet"

    from app.api_client import ApiClient, ApiClientError

    try:
        api = ApiClient(config)
        heartbeat = api.get_heartbeat(config.collector_account_id)
        if not heartbeat or not heartbeat.get("lastHeartbeatAt"):
            return "never (no heartbeat recorded yet)"
        return str(heartbeat["lastHeartbeatAt"])
    except ApiClientError as exc:
        return f"could not reach backend: {exc}"


if __name__ == "__main__":
    sys.exit(main())
