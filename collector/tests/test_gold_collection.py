"""Gold (XAUUSD) collection alongside EURUSD: per-symbol candle timeframes,
the M1 first-sync cap, one live quote per symbol, and the unchanged
execution gate. Mt5Client/ApiClient are mocks — no terminal or backend.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from app.api_mapper import build_snapshot_payload
from app.config import Config, ConfigError
from app.runner import CollectorApp

BASE_ENV = {
    "COLLECTOR_API_BASE_URL": "http://localhost:8420",
    "COLLECTOR_API_KEY": "k",
    "COLLECTOR_ACCOUNT_ID": "a",
    "CANDLE_SYMBOLS": "EURUSD,XAUUSD",
    "CANDLE_TIMEFRAMES": "M5,M15,H1,M30,H4,D1,W1,MN1",
}


def test_symbol_without_override_keeps_the_global_timeframes():
    config = Config.from_env({**BASE_ENV, "CANDLE_TIMEFRAMES_XAUUSD": "M1,M5,M15,M30,H1,H4,D1"})
    assert config.timeframes_for("EURUSD") == ("M5", "M15", "H1", "M30", "H4", "D1", "W1", "MN1")
    assert config.timeframes_for("XAUUSD") == ("M1", "M5", "M15", "M30", "H1", "H4", "D1")


def test_invalid_per_symbol_timeframe_is_rejected():
    with pytest.raises(ConfigError, match="CANDLE_TIMEFRAMES_XAUUSD"):
        Config.from_env({**BASE_ENV, "CANDLE_TIMEFRAMES_XAUUSD": "M1,M2"})


def test_override_for_a_symbol_that_is_not_collected_is_ignored():
    config = Config.from_env({**BASE_ENV, "CANDLE_SYMBOLS": "EURUSD", "CANDLE_TIMEFRAMES_XAUUSD": "M1"})
    assert config.candle_timeframes_by_symbol == {}


def test_execution_stays_disabled_unless_explicitly_true():
    assert Config.from_env(BASE_ENV).autonomous_execution_enabled is False
    assert Config.from_env({**BASE_ENV, "AUTONOMOUS_EXECUTION_ENABLED": "yes"}).autonomous_execution_enabled is False


@dataclass
class _FakeConfig:
    poll_interval_seconds: int = 10
    reconnect_initial_backoff_seconds: float = 2.0
    reconnect_max_backoff_seconds: float = 60.0
    has_explicit_credentials: bool = False
    collector_account_id: str = "acct-1"
    collector_api_base_url: str = "http://localhost:8420"
    initial_sync_days: int = 90
    history_sync_overlap_minutes: int = 5
    candle_symbols: tuple[str, ...] = ("EURUSD", "XAUUSD")
    candle_timeframes: tuple[str, ...] = ("M5", "H1")
    candle_sync_interval_seconds: int = 300
    candle_initial_sync_days: int = 1000
    autonomous_execution_enabled: bool = False
    gold_execution_enabled: bool = False
    # Added when each strategy was wired in. Keeping this fake in step with
    # the real Config matters: the runner logs every flag at startup, so a
    # missing attribute fails the very first loop cycle rather than the
    # feature under test.
    trend_breakout_execution_enabled: bool = False
    rsi_execution_enabled: bool = False
    m1m5_execution_enabled: bool = False
    mt5_broker_timezone: str = "UTC"  # UTC makes the candle-sync timezone conversion a no-op for tests unrelated to it
    candle_timeframes_by_symbol: dict = field(default_factory=lambda: {"XAUUSD": ("M1", "H4")})


def _app(config=None):
    client, api, executor = MagicMock(), MagicMock(), MagicMock()
    return CollectorApp(config or _FakeConfig(), client, api, executor), client, api, executor


def test_sync_candles_uses_per_symbol_timeframes_and_preserves_eurusd():
    app, client, api, _ = _app()
    api.get_latest_candle_time.return_value = {"latestOpenTime": "2026-09-11T20:00:00+00:00"}
    client.get_candles.return_value = []
    app._sync_candles()
    pairs = {(c.args[0], c.args[1]) for c in client.get_candles.call_args_list}
    assert pairs == {("EURUSD", "M5"), ("EURUSD", "H1"), ("XAUUSD", "M1"), ("XAUUSD", "H4")}


def test_incremental_sync_resumes_from_the_backend_cursor_not_local_state():
    app, client, api, _ = _app()
    api.get_latest_candle_time.return_value = {"latestOpenTime": "2026-09-11T22:59:00+00:00"}
    client.get_candles.return_value = []
    app._sync_one_candle_series("XAUUSD", "M1")
    date_from = client.get_candles.call_args_list[0].args[2]
    assert date_from == datetime(2026, 9, 11, 22, 56, tzinfo=timezone.utc)  # cursor minus 3 overlap bars


def test_first_ever_m1_sync_is_capped_at_30_days():
    app, client, api, _ = _app()
    api.get_latest_candle_time.return_value = {"latestOpenTime": None}
    client.get_candles.return_value = []
    app._sync_one_candle_series("XAUUSD", "M1")
    date_from = client.get_candles.call_args_list[0].args[2]
    assert abs((date_from - (datetime.now(tz=timezone.utc) - timedelta(days=30))).total_seconds()) < 5


def test_one_failing_symbol_does_not_stop_the_other():
    from app.api_client import ApiClientError

    app, client, api, _ = _app()
    api.get_latest_candle_time.side_effect = lambda symbol, tf: (_ for _ in ()).throw(ApiClientError("down")) if symbol == "EURUSD" else {"latestOpenTime": None}
    client.get_candles.return_value = []
    app._sync_candles()
    assert {c.args[0] for c in client.get_candles.call_args_list} == {"XAUUSD"}


def test_snapshot_sends_one_quote_per_symbol_and_keeps_liveTick_for_the_first():
    app, client, api, executor = _app()
    client.get_terminal_info.return_value = {"connected": True}
    client.get_account_info.return_value = {"balance": 1, "equity": 1, "trade_mode": 0}
    client.get_open_positions.return_value = []
    client.get_live_tick.side_effect = lambda s: {"symbol": s, "bid": 1.0, "ask": 1.1, "time": "2026-09-15T00:00:00+00:00"}
    app._push_and_print_snapshot()
    payload = api.post_snapshot.call_args.args[0]
    assert payload["liveTick"]["symbol"] == "EURUSD"
    assert [t["symbol"] for t in payload["liveTicks"]] == ["EURUSD", "XAUUSD"]
    executor.send_bracket_order.assert_not_called()


def test_missing_quote_for_one_symbol_is_omitted_not_fabricated():
    app, client, api, _ = _app()
    client.get_terminal_info.return_value = {"connected": True}
    client.get_account_info.return_value = {}
    client.get_open_positions.return_value = []
    client.get_live_tick.side_effect = lambda s: None if s == "XAUUSD" else {"symbol": s, "bid": 1.0, "ask": 1.1, "time": "2026-09-15T00:00:00+00:00"}
    app._push_and_print_snapshot()
    payload = api.post_snapshot.call_args.args[0]
    assert [t["symbol"] for t in payload["liveTicks"]] == ["EURUSD"]


def test_first_symbol_quote_missing_means_no_liveTick_rather_than_a_different_symbol():
    payload = build_snapshot_payload("a", {}, [], True, None, "v", live_tick=None,
                                     live_ticks=[{"symbol": "XAUUSD", "bid": 2.0, "ask": 2.1, "time": "2026-09-15T00:00:00+00:00"}])
    assert "liveTick" not in payload
    assert payload["liveTicks"][0]["symbol"] == "XAUUSD"


def test_one_full_loop_cycle_with_gold_configured_never_reaches_order_polling():
    app, client, api, executor = _app()
    client.is_connected.return_value = True
    cycle_calls = []
    for name in ("_push_and_print_snapshot", "_sync_trades", "_sync_candles", "_sync_symbol_metadata", "_maybe_start_tick_sync"):
        setattr(app, name, MagicMock(side_effect=lambda n=name: cycle_calls.append(n)))
    app._poll_and_execute_pending_order = MagicMock(side_effect=AssertionError("order polling must be unreachable"))
    app._stop_event.wait = lambda timeout=None: app._stop_event.set()  # stop after exactly one cycle

    app.run()

    assert "_sync_candles" in cycle_calls and "_push_and_print_snapshot" in cycle_calls
    app._poll_and_execute_pending_order.assert_not_called()
    api.get_pending_order.assert_not_called()
    executor.send_bracket_order.assert_not_called()


def test_gold_execution_disabled_by_default_and_independent_of_eurusd_flag():
    # Separate flag from EURUSD's own: enabling one must never enable the other.
    assert Config.from_env(BASE_ENV).gold_execution_enabled is False
    assert Config.from_env({**BASE_ENV, "AUTONOMOUS_EXECUTION_ENABLED": "true"}).gold_execution_enabled is False
    assert Config.from_env({**BASE_ENV, "GOLD_EXECUTION_ENABLED": "yes"}).gold_execution_enabled is False
    assert Config.from_env({**BASE_ENV, "GOLD_EXECUTION_ENABLED": "true"}).gold_execution_enabled is True
    assert Config.from_env({**BASE_ENV, "GOLD_EXECUTION_ENABLED": "true"}).autonomous_execution_enabled is False


def test_gold_order_polling_unreachable_when_gold_execution_disabled():
    app, client, api, executor = _app()
    client.is_connected.return_value = True
    for name in ("_push_and_print_snapshot", "_sync_trades", "_sync_candles", "_sync_symbol_metadata", "_maybe_start_tick_sync"):
        setattr(app, name, MagicMock())
    app._poll_and_execute_pending_gold_order = MagicMock(side_effect=AssertionError("gold order polling must be unreachable"))
    app._stop_event.wait = lambda timeout=None: app._stop_event.set()

    app.run()

    app._poll_and_execute_pending_gold_order.assert_not_called()
    api.get_pending_gold_order.assert_not_called()


def test_gold_order_polling_reached_when_gold_execution_enabled():
    config = _FakeConfig(gold_execution_enabled=True)
    app, client, api, executor = _app(config)
    client.is_connected.return_value = True
    for name in ("_push_and_print_snapshot", "_sync_trades", "_sync_candles", "_sync_symbol_metadata", "_maybe_start_tick_sync"):
        setattr(app, name, MagicMock())
    api.get_pending_gold_order.return_value = {"order": None}
    app._stop_event.wait = lambda timeout=None: app._stop_event.set()

    app.run()

    api.get_pending_gold_order.assert_called_once_with(config.collector_account_id)
    executor.send_bracket_order.assert_not_called()


def test_gold_order_execution_passes_symbol_and_point_size_through():
    app, client, api, executor = _app(_FakeConfig(gold_execution_enabled=True))
    api.get_pending_gold_order.return_value = {
        "order": {
            "decisionId": "d-1", "side": "BUY", "volume": 0.01,
            "stopLossPoints": 1000, "takeProfitPoints": 1000,
            "magic": 262610181, "comment": "gold-abcd1234",
            "symbol": "XAUUSD", "pointSize": 0.01,
        }
    }
    executor.send_bracket_order.return_value = MagicMock(ok=True, ticket=555, price=2650.5, retcode=10009, error_message=None)

    app._poll_and_execute_pending_gold_order()

    executor.send_bracket_order.assert_called_once_with(
        side="BUY", volume=0.01, stop_loss_points=1000, take_profit_points=1000,
        magic=262610181, comment="gold-abcd1234", symbol="XAUUSD", point_size=0.01,
    )
    api.post_gold_execution_result.assert_called_once()
    call_args = api.post_gold_execution_result.call_args
    assert call_args[0][1] == "d-1"
    assert call_args[0][2]["ok"] is True
    assert call_args[0][2]["ticket"] == 555


def test_gold_order_execution_reports_demo_account_failure_never_crashes():
    from app.executor import DemoAccountRequiredError

    app, client, api, executor = _app(_FakeConfig(gold_execution_enabled=True))
    api.get_pending_gold_order.return_value = {
        "order": {
            "decisionId": "d-2", "side": "SELL", "volume": 0.01,
            "stopLossPoints": 1000, "takeProfitPoints": 1000,
            "magic": 262610181, "comment": "gold-xyz", "symbol": "XAUUSD", "pointSize": 0.01,
        }
    }
    executor.send_bracket_order.side_effect = DemoAccountRequiredError("account is REAL, refusing")

    app._poll_and_execute_pending_gold_order()  # must not raise

    api.post_gold_execution_result.assert_called_once()
    call_args = api.post_gold_execution_result.call_args
    assert call_args[0][2]["ok"] is False
    assert "refusing" in call_args[0][2]["errorMessage"]
