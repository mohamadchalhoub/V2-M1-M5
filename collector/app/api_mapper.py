"""Pure translation from mt5_client's internal dict shape to the wire
format the backend's collector-ingress DTOs expect. No MT5 dependency —
testable with plain dicts, same as formatting.py.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


# MetaTrader5's own ACCOUNT_TRADE_MODE_* enum, hardcoded rather than
# imported — this module is deliberately MT5-independent (see the module
# docstring), and this mapping is a documented fact about MT5's own stable
# wire format, not something that needs a live import to know. Autonomous
# demo trading (v2) — the single most safety-critical field this collector
# pushes (AUTONOMOUS_DEMO_TRADING_PLAN.md §1).
#
# CORRECTED — found and fixed while wiring gold execution live-verification:
# this was previously {0: "REAL", 1: "DEMO", 2: "CONTEST"}, a complete
# permutation error against MT5's actual, real enum values. Verified
# directly against the literal installed `MetaTrader5` package in this
# project's own venv (`collector/.venv/Lib/site-packages/MetaTrader5/__init__.py`):
# `ACCOUNT_TRADE_MODE_DEMO = 0`, `ACCOUNT_TRADE_MODE_CONTEST = 1`,
# `ACCOUNT_TRADE_MODE_REAL = 2` — not assumed from memory. The old mapping
# meant a genuine DEMO account (raw int 0) was being labeled "REAL" in
# every `AccountSnapshot.tradeMode` this collector ever pushed, and a
# genuine REAL account (raw int 2) was being labeled "CONTEST". Because
# every downstream consumer (risk-manager.ts, gold-risk-manager.ts) fails
# closed on anything other than the literal string "DEMO", the PRACTICAL
# effect of this bug was safety-conservative (it could only ever cause a
# genuine demo account to be wrongly REFUSED, never a real account to be
# wrongly ALLOWED) — but it was still wrong, and it was actively affecting
# this task's own DEMO-verification evidence, so it is fixed here rather
# than left for later. `executor.py`'s own live order-placement gate
# (`verify_demo_account`) was NEVER affected by this bug — it compares
# against the real `MetaTrader5` module's own live constant directly, not
# against this hardcoded label map, so no order-placement safety check was
# ever using the wrong mapping.
_TRADE_MODE_LABELS = {0: "DEMO", 1: "CONTEST", 2: "REAL"}


# Mirrors MT5's ACCOUNT_MARGIN_MODE_*. An unmapped value yields None rather
# than a guess: "unknown" must stay distinguishable from "netting", because
# the risk gate treats them differently in its reporting even though both
# block the second slot.
_MARGIN_MODE_LABELS = {0: "RETAIL_NETTING", 1: "EXCHANGE", 2: "RETAIL_HEDGING"}


def _margin_mode_label(margin_mode: int | None) -> str | None:
    if margin_mode is None:
        return None
    return _MARGIN_MODE_LABELS.get(margin_mode)


def _trade_mode_label(trade_mode: int | None) -> str | None:
    if trade_mode is None:
        return None
    return _TRADE_MODE_LABELS.get(trade_mode)


def build_permissions_payload(
    account: dict[str, Any] | None,
    terminal: dict[str, Any] | None,
    mt5_connected: bool | None,
) -> dict[str, Any]:
    """MT5 trading permissions, as the terminal and broker actually report them.

    Every field is deliberately three-state: the value, or ``None`` when it
    could not be read. ``None`` is not the same as ``False`` and must not be
    collapsed into it -- the backend treats an unreadable permission as a
    blocker, and encoding "unknown" as "granted" would be wrong in the
    dangerous direction while encoding it as "denied" would hide a real fault.

    This block exists because fresh quotes are not permission to trade. A
    terminal with algorithmic trading switched off streams perfectly good
    prices right up until an order is rejected.
    """
    account = account or {}
    terminal = terminal or {}

    def tri(value: Any) -> bool | None:
        return None if value is None else bool(value)

    return {
        # Identity first: every other check is meaningless if this is the
        # wrong account.
        "login": account.get("login"),
        "server": account.get("server"),
        "tradeMode": _trade_mode_label(account.get("trade_mode")),
        "marginMode": _margin_mode_label(account.get("margin_mode")),
        "terminalConnected": tri(mt5_connected),
        "terminalTradeAllowed": tri(terminal.get("trade_allowed")),
        # Inverted sense: True is the BAD state. Reported as the terminal
        # names it rather than flipped here, so the backend's own check reads
        # the same way the MT5 documentation does.
        "terminalTradeApiDisabled": tri(terminal.get("tradeapi_disabled")),
        "accountTradeAllowed": tri(account.get("trade_allowed")),
        "accountTradeExpert": tri(account.get("trade_expert")),
    }


def build_snapshot_payload(
    account_id: str,
    account: dict[str, Any] | None,
    positions: list[dict[str, Any]],
    mt5_connected: bool | None,
    last_error: str | None,
    collector_version: str,
    live_tick: dict[str, Any] | None = None,
    live_ticks: list[dict[str, Any]] | None = None,
    terminal_info: dict[str, Any] | None = None,
) -> dict[str, Any]:
    account = account or {}
    payload = {
        "accountId": account_id,
        "capturedAt": datetime.now(tz=timezone.utc).isoformat(),
        "balance": account.get("balance", 0),
        "equity": account.get("equity", 0),
        "margin": account.get("margin", 0),
        "freeMargin": account.get("margin_free", 0),
        "marginLevel": account.get("margin_level"),
        "profit": account.get("profit", 0),
        "tradeMode": _trade_mode_label(account.get("trade_mode")),
        "marginMode": _margin_mode_label(account.get("margin_mode")),
        "terminal": {
            "connected": bool(mt5_connected),
            **({"lastError": last_error} if last_error else {}),
        },
        "collectorVersion": collector_version,
        # MT5 trading permissions, so the backend can block execution on a
        # missing or unreadable one rather than discovering it at order time.
        "permissions": build_permissions_payload(account, terminal_info, mt5_connected),
        "positions": [_position_payload(p) for p in positions],
    }
    # Global market data (not account-scoped) piggybacked onto this same,
    # already-frequent (10s) push rather than a new endpoint/poll loop —
    # the backend stores it keyed by symbol alone, same pattern
    # historical_candles already uses for shared market data.
    if live_tick is not None and live_tick.get("bid") is not None and live_tick.get("ask") is not None:
        payload["liveTick"] = _live_tick_payload(live_tick)
    complete = [t for t in (live_ticks or []) if t.get("bid") is not None and t.get("ask") is not None and t.get("time")]
    if complete:
        payload["liveTicks"] = [_live_tick_payload(t) for t in complete]
    return payload


def _live_tick_payload(tick: dict[str, Any]) -> dict[str, Any]:
    return {"symbol": tick["symbol"], "bid": tick["bid"], "ask": tick["ask"], "tickAt": tick["time"]}


def _position_payload(p: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "externalPositionId": str(p["ticket"]),
        "symbol": p["symbol"],
        "side": p["side"],
        "volume": p["volume"],
        "openPrice": p["price_open"],
        "currentPrice": p.get("price_current"),
        "profit": p.get("profit", 0),
        "swap": p.get("swap", 0),
        "openedAt": p["opened_at"],
        "raw": p.get("raw"),
    }
    if p.get("sl"):
        payload["stopLoss"] = p["sl"]
    if p.get("tp"):
        payload["takeProfit"] = p["tp"]
    return payload


def build_trades_payload(account_id: str, deals: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "accountId": account_id,
        "deals": [_deal_payload(d) for d in deals],
    }


def _deal_payload(d: dict[str, Any]) -> dict[str, Any]:
    return {
        "externalTradeId": str(d["ticket"]),
        "positionId": str(d["position_id"]) if d.get("position_id") else None,
        "orderId": str(d["order"]) if d.get("order") else None,
        "symbol": d["symbol"],
        "side": d["deal_type"],
        "dealEntry": d["entry"],
        "volume": d["volume"],
        "price": d["price"],
        "commission": d.get("commission", 0),
        "swap": d.get("swap", 0),
        "profit": d.get("profit", 0),
        "executedAt": d["closed_at"],
        "comment": d.get("comment"),
        "raw": d.get("raw"),
    }


# Historical chart reconstruction phase — no account_id (candles are
# symbol/timeframe data, see api_client.py's post_candles).
def build_candles_payload(symbol: str, timeframe: str, candles: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "candles": [
            {
                "openTime": c["open_time"],
                "open": c["open"],
                "high": c["high"],
                "low": c["low"],
                "close": c["close"],
                **({"volume": c["volume"]} if c.get("volume") is not None else {}),
            }
            for c in candles
        ],
    }


# Gold historical-data-collection project — same "no account_id" posture as
# candles above (ticks are symbol/timeframe-less market data, shared across
# every account/collector). brokerSymbol/server/feedId are all optional on
# the wire — omitted entirely rather than sent as null, same conditional-
# spread idiom build_candles_payload already uses for `volume`.
def build_ticks_payload(
    symbol: str,
    broker_symbol: str | None,
    server: str | None,
    feed_id: str | None,
    ticks: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "symbol": symbol,
        **({"brokerSymbol": broker_symbol} if broker_symbol is not None else {}),
        **({"server": server} if server is not None else {}),
        **({"feedId": feed_id} if feed_id is not None else {}),
        "ticks": [
            {
                "timestamp": t["timestamp"],
                "bid": t["bid"],
                "ask": t["ask"],
                **({"last": t["last"]} if t.get("last") is not None else {}),
                **({"volume": t["volume"]} if t.get("volume") is not None else {}),
                **({"volumeReal": t["volume_real"]} if t.get("volume_real") is not None else {}),
                "flags": t["flags"],
                "batchSeq": t["batch_seq"],
            }
            for t in ticks
        ],
    }


# Gold historical-data-collection project — the ORIGINAL required fields
# (symbol/volumeMin/volumeMax/volumeStep/digits/point/contractSize/
# profitCurrency, matching the already-deployed SymbolMetadataPushDto and
# get_symbol_info()'s own established shape) stay always-present and
# unconditional; every other field below is a NEW, strictly-optional
# extension sent only when Mt5Client.get_instrument_verification() actually
# has a value for it — same conditional-spread idiom as build_candles_payload's
# `volume` handling. `info` is that method's flat return dict; `broker_symbol`
# is a separate param (not read off `info`, which has no such concept) since
# it's the caller's own broker-specific symbol string, mirroring
# build_ticks_payload's own broker_symbol/server parameters.
def build_symbol_metadata_payload(info: dict[str, Any], broker_symbol: str | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "symbol": info["symbol"],
        "volumeMin": info.get("volume_min"),
        "volumeMax": info.get("volume_max"),
        "volumeStep": info.get("volume_step"),
        "digits": info.get("digits"),
        "point": info.get("point"),
        "contractSize": info.get("contract_size"),
        "profitCurrency": info.get("currency_profit"),
    }
    optional_fields = {
        "brokerSymbol": broker_symbol,
        "server": info.get("server"),
        "path": info.get("path"),
        "currencyBase": info.get("currency_base"),
        "currencyProfit": info.get("currency_profit"),
        "currencyMargin": info.get("currency_margin"),
        "tradeTickSize": info.get("trade_tick_size"),
        "tradeTickValue": info.get("trade_tick_value"),
        "tradeStopsLevel": info.get("trade_stops_level"),
        "tradeFreezeLevel": info.get("trade_freeze_level"),
        "tradeMode": info.get("trade_mode"),
        "swapMode": info.get("swap_mode"),
        "swapLong": info.get("swap_long"),
        "swapShort": info.get("swap_short"),
        "swapRollover3Days": info.get("swap_rollover3days"),
        "expirationMode": info.get("expiration_mode"),
        "expirationTime": info.get("expiration_time"),
    }
    payload.update({k: v for k, v in optional_fields.items() if v is not None})
    return payload
