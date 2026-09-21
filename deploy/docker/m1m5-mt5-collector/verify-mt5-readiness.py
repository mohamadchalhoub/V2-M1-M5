"""Runtime MT5 readiness verification for xauusd-m1-m5-rsi-threshold-v2.

Runs INSIDE the v2 MT5 container, under the Wine-hosted Windows Python, and
talks to the running terminal. Everything it reports comes from the live
terminal rather than from configuration, a label, or an assumption.

That distinction is the entire reason this file exists. The account was opened
as "Forex Hedged USD", which is a label on a signup screen. The strategy needs
MT5 to actually report ``ACCOUNT_MARGIN_MODE_RETAIL_HEDGING`` at runtime,
because M1 and M5 may hold independent positions -- including opposite
directions at the same time. Under netting the broker would merge those into
one net position, which is not the strategy that was specified. A label cannot
establish that; only the terminal can.

Exit code 0 means every check passed. Non-zero means execution must stay
blocked, and the failing checks are printed.

Usage (inside the container):
    wine "$WINEPREFIX/drive_c/Program Files/Python312/python.exe" /verify-mt5-readiness.py
"""
from __future__ import annotations

import json
import os
import sys
import time

try:
    import MetaTrader5 as mt5
except ImportError:  # pragma: no cover - only importable under Wine
    print("FATAL: MetaTrader5 package is not importable. This script must run under the Wine-hosted Windows Python.")
    sys.exit(2)

SYMBOL = os.environ.get("MT5_VERIFY_SYMBOL", "XAUUSD")
# MT5 constants, restated so a failure message can name them even when the
# package's own attribute is missing on an older build.
ACCOUNT_TRADE_MODE_DEMO = 0
ACCOUNT_MARGIN_MODE_RETAIL_HEDGING = 2
QUOTE_MAX_AGE_SECONDS = 60


class Report:
    def __init__(self) -> None:
        self.checks: list[dict] = []

    def add(self, name: str, ok: bool, detail: str) -> None:
        self.checks.append({"check": name, "ok": ok, "detail": detail})
        marker = "PASS" if ok else "FAIL"
        print(f"[{marker}] {name}: {detail}")

    @property
    def failed(self) -> list[dict]:
        return [c for c in self.checks if not c["ok"]]


def main() -> int:
    report = Report()

    terminal_path = os.environ.get("MT5_TERMINAL_PATH", "").strip()
    expected_login_raw = os.environ.get("MT5_EXPECTED_LOGIN", "").strip()
    expected_server = os.environ.get("MT5_SERVER", "").strip()

    if not terminal_path:
        report.add(
            "explicit terminal path",
            False,
            "MT5_TERMINAL_PATH is unset; initialize() would auto-discover a terminal, possibly another bot's",
        )
        print(json.dumps({"ready": False, "checks": report.checks}, indent=2))
        return 1
    report.add("explicit terminal path", True, terminal_path)

    if not expected_login_raw:
        report.add("expected account configured", False, "MT5_EXPECTED_LOGIN is unset")
        print(json.dumps({"ready": False, "checks": report.checks}, indent=2))
        return 1
    expected_login = int(expected_login_raw)
    report.add("expected account configured", True, str(expected_login))

    # --- Connect to THIS container's terminal, by explicit path only. ---
    if not mt5.initialize(path=terminal_path, timeout=60_000):
        code, message = mt5.last_error()
        report.add("terminal connection", False, f"initialize() failed: {code} {message}")
        print(json.dumps({"ready": False, "checks": report.checks}, indent=2))
        return 1

    try:
        terminal = mt5.terminal_info()
        account = mt5.account_info()

        if terminal is None:
            report.add("terminal info", False, "terminal_info() returned None")
        else:
            report.add("terminal info", True, f"{terminal.name} build {terminal.build}")
            report.add(
                "terminal connected",
                bool(terminal.connected),
                f"terminal.connected={terminal.connected}",
            )
            report.add(
                "terminal trade_allowed",
                bool(terminal.trade_allowed),
                f"terminal.trade_allowed={terminal.trade_allowed}"
                + ("" if terminal.trade_allowed else " -- enable Algo Trading in THIS terminal only"),
            )
            # Inverted sense: True is the bad state.
            api_disabled = bool(getattr(terminal, "tradeapi_disabled", False))
            report.add(
                "terminal tradeapi_disabled",
                not api_disabled,
                f"terminal.tradeapi_disabled={api_disabled}",
            )

        if account is None:
            report.add("account info", False, "account_info() returned None")
            print(json.dumps({"ready": False, "checks": report.checks}, indent=2))
            return 1

        # --- Identity. Checked before anything else about the account, since
        # every later check is meaningless if this is the wrong account. ---
        report.add(
            "account identity",
            int(account.login) == expected_login,
            f"terminal reports {account.login}, configured {expected_login}",
        )
        if expected_server:
            report.add(
                "broker/server identity",
                account.server == expected_server,
                f"terminal reports {account.server!r}, configured {expected_server!r}",
            )
        else:
            report.add("broker/server identity", True, f"{account.server!r} (no expected value configured)")

        # --- DEMO only. There is no real-account path in this application. ---
        report.add(
            "account is DEMO",
            int(account.trade_mode) == ACCOUNT_TRADE_MODE_DEMO,
            f"trade_mode={account.trade_mode} (0=DEMO, 1=CONTEST, 2=REAL)",
        )

        report.add(
            "account trade_allowed",
            bool(account.trade_allowed),
            f"account.trade_allowed={account.trade_allowed}"
            + ("" if account.trade_allowed else " -- set by the broker; cannot be fixed from the terminal"),
        )
        report.add(
            "account trade_expert",
            bool(account.trade_expert),
            f"account.trade_expert={account.trade_expert}"
            + ("" if account.trade_expert else " -- set by the broker; cannot be fixed from the terminal"),
        )

        # --- HEDGING. The check this script exists for. ---
        margin_mode = int(account.margin_mode)
        is_hedging = margin_mode == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING
        report.add(
            "RETAIL_HEDGING margin mode",
            is_hedging,
            f"margin_mode={margin_mode} "
            f"(0=RETAIL_NETTING, 1=EXCHANGE, 2=RETAIL_HEDGING)"
            + (
                ""
                if is_hedging
                else " -- NETTING cannot represent independent simultaneous M1 and M5 positions; "
                "this application will not emulate hedging on a netting account, so execution stays blocked"
            ),
        )

        # --- Symbol. ---
        info = mt5.symbol_info(SYMBOL)
        if info is None:
            report.add(f"{SYMBOL} exists", False, "symbol_info() returned None")
        else:
            report.add(f"{SYMBOL} exists", True, f"digits={info.digits} point={info.point}")
            if not info.visible:
                mt5.symbol_select(SYMBOL, True)
                info = mt5.symbol_info(SYMBOL)
            # trade_mode 0 = disabled, 4 = full access.
            tradable = info is not None and int(info.trade_mode) != 0
            report.add(
                f"{SYMBOL} tradable",
                tradable,
                f"trade_mode={getattr(info, 'trade_mode', 'n/a')} (0=disabled)",
            )
            if info is not None:
                report.add(
                    f"{SYMBOL} volume bounds",
                    info.volume_min > 0 and info.volume_max >= info.volume_min,
                    f"min={info.volume_min} max={info.volume_max} step={info.volume_step}",
                )
                report.add(
                    f"{SYMBOL} stop level",
                    True,
                    f"stops_level={info.trade_stops_level} points, freeze_level={info.trade_freeze_level} points "
                    f"($5.00 bracket = {round(5.0 / info.point) if info.point else 'n/a'} points)",
                )

            tick = mt5.symbol_info_tick(SYMBOL)
            if tick is None:
                report.add(f"{SYMBOL} quote", False, "symbol_info_tick() returned None")
            else:
                age = time.time() - tick.time
                report.add(
                    f"{SYMBOL} quote freshness",
                    0 <= age <= QUOTE_MAX_AGE_SECONDS,
                    f"bid={tick.bid} ask={tick.ask} age={age:.1f}s "
                    "(a stale quote outside market hours is expected; re-run during a session)",
                )

    finally:
        mt5.shutdown()

    ready = not report.failed
    print()
    print(json.dumps({"ready": ready, "failed": [c["check"] for c in report.failed]}, indent=2))
    if not ready:
        print()
        print("Execution must remain BLOCKED until every check above passes.")
    return 0 if ready else 1


if __name__ == "__main__":
    sys.exit(main())
