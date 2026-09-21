"""Pure, MT5-independent formatting of already-fetched data into console text.

Kept separate from mt5_client.py specifically so it's testable without a
Windows machine, a running terminal, or the MetaTrader5 package installed —
these functions only ever take plain dicts/lists in and return strings.
"""
from __future__ import annotations

from typing import Any


def format_connection_status(connected: bool, mt5_connected: bool | None, server: str | None) -> str:
    if not connected:
        return "CONNECTION STATUS: DOWN — not attached to a terminal"
    mt5_state = "unknown" if mt5_connected is None else ("UP" if mt5_connected else "DOWN")
    server_part = f" | broker link: {mt5_state} | server: {server or 'n/a'}"
    return f"CONNECTION STATUS: UP{server_part}"


def format_account_summary(account: dict[str, Any] | None) -> str:
    if account is None:
        return "ACCOUNT INFO: unavailable (no data returned by the terminal)"
    lines = [
        "ACCOUNT INFO",
        f"  login:    {account.get('login')}",
        f"  server:   {account.get('server')}",
        f"  currency: {account.get('currency')}",
        f"  balance:  {account.get('balance')}",
        f"  equity:   {account.get('equity')}",
        f"  margin:   {account.get('margin')}  free: {account.get('margin_free')}  "
        f"level: {account.get('margin_level')}",
        f"  profit (floating): {account.get('profit')}",
        f"  leverage: 1:{account.get('leverage')}",
        f"  trade_allowed: {account.get('trade_allowed')}",
    ]
    return "\n".join(lines)


def format_positions_table(positions: list[dict[str, Any]]) -> str:
    if not positions:
        return "OPEN POSITIONS: none"
    header = f"OPEN POSITIONS ({len(positions)})"
    rows = [header, f"  {'ticket':>12}  {'symbol':<10}{'side':<6}{'volume':>8}  "
                     f"{'open':>10}  {'current':>10}  {'profit':>10}"]
    for p in positions:
        rows.append(
            f"  {p.get('ticket', ''):>12}  {p.get('symbol', ''):<10}"
            f"{p.get('side', ''):<6}{p.get('volume', ''):>8}  "
            f"{p.get('price_open', ''):>10}  {p.get('price_current', ''):>10}  "
            f"{p.get('profit', ''):>10}"
        )
    return "\n".join(rows)


def format_deals_table(deals: list[dict[str, Any]], days: int) -> str:
    if not deals:
        return f"RECENT DEALS (last {days}d): none"
    header = f"RECENT DEALS (last {days}d, {len(deals)} entries)"
    rows = [header, f"  {'ticket':>12}  {'closed_at':<20}{'symbol':<10}{'type':<10}"
                     f"{'volume':>8}  {'price':>10}  {'profit':>10}"]
    for d in deals:
        rows.append(
            f"  {d.get('ticket', ''):>12}  {str(d.get('closed_at', '')):<20}"
            f"{d.get('symbol', ''):<10}{d.get('deal_type', ''):<10}"
            f"{d.get('volume', ''):>8}  {d.get('price', ''):>10}  {d.get('profit', ''):>10}"
        )
    return "\n".join(rows)
