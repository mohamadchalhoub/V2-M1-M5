"""The m1m5 session check, run through the REAL Mt5Client.

The session check's original unit test mocked `get_symbol_info` to return
`{"trade_mode": 4}` -- a shape that was assumed rather than read. The real
method returned a hand-picked dict WITHOUT that field, so on the VPS the check
reported the broker session as unknown on every cycle, and every entry was
blocked. The mock agreed with the code; the code disagreed with production.

These tests fake only the MetaTrader5 module itself. Everything between it and
the session check -- the dict `get_symbol_info` builds, the broker-time
normalisation `get_live_tick` applies -- is the production code.
"""
from collections import namedtuple
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

from app.mt5_client import Mt5Client, _utc_to_mt5_epoch
from app.runner import CollectorApp

# Field names as MetaTrader5's own SymbolInfo / Tick named tuples spell them.
SymbolInfo = namedtuple(
    "SymbolInfo",
    "volume_min volume_max volume_step digits point trade_contract_size currency_profit trade_mode",
)
Tick = namedtuple("Tick", "bid ask time time_msc")

BROKER_TZ = "EET"  # MetaQuotes-Demo; UTC+3 in September


class _ClientConfig:
    mt5_timeout_ms = 60_000
    mt5_terminal_path = None
    has_explicit_credentials = False
    mt5_broker_timezone = BROKER_TZ


@dataclass
class _AppConfig:
    poll_interval_seconds: int = 10
    reconnect_initial_backoff_seconds: float = 2.0
    reconnect_max_backoff_seconds: float = 60.0
    has_explicit_credentials: bool = False
    collector_account_id: str = "acct-1"
    collector_api_base_url: str = "http://localhost:8420"
    initial_sync_days: int = 90
    history_sync_overlap_minutes: int = 5
    candle_symbols: tuple = ()
    candle_timeframes: tuple = ()
    candle_sync_interval_seconds: int = 300
    candle_initial_sync_days: int = 1000
    autonomous_execution_enabled: bool = False
    gold_execution_enabled: bool = False
    trend_breakout_execution_enabled: bool = False
    rsi_execution_enabled: bool = False
    m1m5_execution_enabled: bool = True
    mt5_broker_timezone: str = BROKER_TZ
    candle_timeframes_by_symbol: dict = field(default_factory=dict)


class _FakeMt5:
    """Stands in for the MetaTrader5 module, and nothing more."""

    def __init__(self, trade_mode: int, tick_at_utc: datetime) -> None:
        self._trade_mode = trade_mode
        self._tick_at_utc = tick_at_utc

    def symbol_info(self, symbol):
        return SymbolInfo(0.01, 100.0, 0.01, 2, 0.01, 100.0, "USD", self._trade_mode)

    def symbol_info_tick(self, symbol):
        # MT5 reports tick time as BROKER-local epoch; get_live_tick corrects it.
        epoch = _utc_to_mt5_epoch(self._tick_at_utc, BROKER_TZ)
        return Tick(4360.0, 4360.5, epoch, epoch * 1000)

    def last_error(self):
        return (1, "Success")


def _real_client(trade_mode: int = 4, tick_age: timedelta = timedelta(seconds=2)) -> Mt5Client:
    client = Mt5Client(_ClientConfig())
    client._mt5 = _FakeMt5(trade_mode, datetime.now(timezone.utc) - tick_age)
    return client


def _app(client: Mt5Client) -> CollectorApp:
    return CollectorApp(config=_AppConfig(), client=client, api=MagicMock(), executor=MagicMock())


def test_get_symbol_info_carries_trade_mode():
    # The field whose absence blocked every entry on the VPS.
    info = _real_client(trade_mode=4).get_symbol_info("XAUUSD")
    assert info is not None
    assert info["trade_mode"] == 4


def test_session_is_open_for_a_tradable_symbol_with_a_fresh_tick():
    assert _app(_real_client(trade_mode=4))._m1m5_session_open() is True


def test_session_is_closed_when_the_symbol_is_disabled():
    assert _app(_real_client(trade_mode=0))._m1m5_session_open() is False


def test_session_is_closed_when_the_tick_is_hours_old():
    # The weekend state: a tradable symbol that nobody is quoting.
    assert _app(_real_client(trade_mode=4, tick_age=timedelta(hours=3)))._m1m5_session_open() is False


def test_a_fresh_tick_is_not_misread_as_stale_by_the_broker_offset():
    # The raw MT5 tick time is broker-local (UTC+3 here). Comparing it to UTC
    # uncorrected would make a 2-second-old tick look 3 hours old -- or, the
    # other way round, 3 hours in the future. The real get_live_tick corrects
    # it, and this proves the session check sees the corrected value.
    assert _app(_real_client(trade_mode=4, tick_age=timedelta(seconds=2)))._m1m5_session_open() is True


def test_the_time_parser_refuses_rather_than_guesses():
    from app.runner import _as_utc_datetime

    # The real shape: an aware ISO string.
    assert _as_utc_datetime("2026-09-22T00:43:53+00:00") == datetime(2026, 9, 22, 0, 43, 53, tzinfo=timezone.utc)
    assert _as_utc_datetime("2026-09-22T00:43:53Z") == datetime(2026, 9, 22, 0, 43, 53, tzinfo=timezone.utc)
    # Naive: could be UTC or broker-local, hours apart. Not guessed.
    assert _as_utc_datetime("2026-09-22T00:43:53") is None
    # Garbage and the wrong type: unknown, never an exception.
    assert _as_utc_datetime("not a time") is None
    assert _as_utc_datetime(1790033046) is None
    assert _as_utc_datetime(None) is None
