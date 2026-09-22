"""Collector-side behaviour for `xauusd-m1-m5-rsi-threshold-v2`: the MT5
permission report and the entry poll.

The negative cases carry most of the weight here. Whether an order gets placed
when everything is fine is the easy half; what actually protects the account is
that an ambiguous broker response is reported as UNCERTAIN rather than as a
failure, and that "we could not tell whether the market is open" never reads as
"the market is open".
"""
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.api_client import ApiClientError
from app.executor import DemoAccountRequiredError, OrderResult
from app.runner import CollectorApp


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
    candle_symbols: tuple = ()
    candle_timeframes: tuple = ()
    candle_sync_interval_seconds: int = 300
    candle_initial_sync_days: int = 1000
    autonomous_execution_enabled: bool = False
    gold_execution_enabled: bool = False
    trend_breakout_execution_enabled: bool = False
    rsi_execution_enabled: bool = False
    m1m5_execution_enabled: bool = True
    mt5_broker_timezone: str = "UTC"
    candle_timeframes_by_symbol: dict = field(default_factory=dict)


def _app(**overrides):
    client, api, executor = MagicMock(), MagicMock(), MagicMock()
    config = _FakeConfig(**overrides)
    app = CollectorApp(config=config, client=client, api=api, executor=executor)
    return app, client, api, executor


def _order(**overrides):
    order = {
        "decisionId": "dec-1",
        "timeframe": "M1",
        "side": "SELL",
        "volume": 0.5,
        "entryPrice": 4360.0,
        "stopLoss": 4365.0,
        "takeProfit": 4355.0,
        "stopLossPoints": 500.0,
        "takeProfitPoints": 500.0,
        "magic": 262610200,
        "symbol": "XAUUSD",
        "pointSize": 0.01,
        "comment": "m1m5-m1-dec1",
    }
    order.update(overrides)
    return order


# --- the entry poll -------------------------------------------------------


def test_nothing_is_attempted_when_the_backend_has_nothing_queued():
    app, _client, api, executor = _app()
    api.get_pending_m1m5_order.return_value = {"order": None}

    app._poll_and_execute_pending_m1m5_order()

    executor.send_bracket_order.assert_not_called()
    api.post_m1m5_execution_result.assert_not_called()


def test_a_failed_poll_never_raises_and_never_executes():
    app, _client, api, executor = _app()
    api.get_pending_m1m5_order.side_effect = ApiClientError("backend down")

    app._poll_and_execute_pending_m1m5_order()

    executor.send_bracket_order.assert_not_called()


def test_a_queued_order_is_placed_with_its_own_magic_number_and_volume():
    app, _client, api, executor = _app()
    api.get_pending_m1m5_order.return_value = {"order": _order()}
    executor.send_bracket_order.return_value = OrderResult(
        ok=True, ticket=555, volume_filled=0.5, price=4360.0, retcode=10009
    )
    app._read_position_protection = MagicMock(return_value=(4365.0, 4355.0))

    app._poll_and_execute_pending_m1m5_order()

    sent = executor.send_bracket_order.call_args.kwargs
    assert sent["magic"] == 262610200
    assert sent["volume"] == 0.5
    assert sent["symbol"] == "XAUUSD"

    reported = api.post_m1m5_execution_result.call_args[0][2]
    assert reported["ok"] is True
    assert reported["uncertain"] is False
    assert reported["ticket"] == 555


def test_an_ambiguous_broker_response_is_reported_as_uncertain_not_as_failure():
    """The single most consequential case in this file.

    No ticket and no retcode means the executor could not establish what
    happened. Reporting that as ok=False would have the backend free the
    timeframe slot -- and if the order did reach the broker, the next signal
    would open a second position on a timeframe that already holds one.
    """
    app, _client, api, executor = _app()
    api.get_pending_m1m5_order.return_value = {"order": _order()}
    executor.send_bracket_order.return_value = OrderResult(
        ok=False, ticket=None, volume_filled=0.5, price=None, retcode=None,
        error_message="no response from broker",
    )
    app._read_position_protection = MagicMock(return_value=(None, None))

    app._poll_and_execute_pending_m1m5_order()

    reported = api.post_m1m5_execution_result.call_args[0][2]
    assert reported["ok"] is False
    assert reported["uncertain"] is True


def test_a_broker_confirmed_rejection_is_not_uncertain():
    app, _client, api, executor = _app()
    api.get_pending_m1m5_order.return_value = {"order": _order()}
    executor.send_bracket_order.return_value = OrderResult(
        ok=False, ticket=None, volume_filled=0.5, price=None, retcode=10015,
        error_message="invalid price",
    )
    app._read_position_protection = MagicMock(return_value=(None, None))

    app._poll_and_execute_pending_m1m5_order()

    reported = api.post_m1m5_execution_result.call_args[0][2]
    assert reported["ok"] is False
    assert reported["uncertain"] is False


def test_a_demo_account_check_failure_refuses_to_trade_and_reports_it():
    app, _client, api, executor = _app()
    api.get_pending_m1m5_order.return_value = {"order": _order()}
    executor.send_bracket_order.side_effect = DemoAccountRequiredError("account is REAL")

    app._poll_and_execute_pending_m1m5_order()

    reported = api.post_m1m5_execution_result.call_args[0][2]
    assert reported["ok"] is False
    assert "REAL" in reported["errorMessage"]


def test_an_order_without_a_volume_is_refused_rather_than_given_a_default():
    app, _client, api, executor = _app()
    api.get_pending_m1m5_order.return_value = {"order": _order(volume=None)}

    app._poll_and_execute_pending_m1m5_order()

    executor.send_bracket_order.assert_not_called()
    reported = api.post_m1m5_execution_result.call_args[0][2]
    assert reported["ok"] is False


# --- the permission report ------------------------------------------------


def test_the_snapshot_carries_leverage_and_session_state():
    app, client, api, _executor = _app()
    client.get_account_info.return_value = {
        "login": 5056294252, "server": "MetaQuotes-Demo", "trade_mode": 0,
        "margin_mode": 2, "trade_allowed": True, "trade_expert": True, "leverage": 100,
    }
    client.get_terminal_info.return_value = {"trade_allowed": True, "tradeapi_disabled": False}
    client.is_connected.return_value = True
    client.get_symbol_info.return_value = {"trade_mode": 4}
    client.get_live_tick.return_value = {
        "bid": 4360.0, "ask": 4360.5, "time": datetime.now(timezone.utc),
    }

    app._push_m1m5_mt5_snapshot()

    payload = api.post_m1m5_mt5_snapshot.call_args[0][1]
    assert payload["leverage"] == 100
    assert payload["sessionOpen"] is True
    assert payload["marginMode"] == "RETAIL_HEDGING"
    assert payload["tradeMode"] == "DEMO"
    assert "capturedAt" in payload


def test_an_unreadable_permission_stays_null_rather_than_becoming_false():
    """Null is a third state and must survive the wire.

    Encoding "could not read" as False would disguise a genuine fault as an
    ordinary refusal; as True it would let a missing answer look like a granted
    permission. The backend blocks on null, which is the honest answer.
    """
    app, client, api, _executor = _app()
    client.get_account_info.return_value = {"login": 5056294252}
    client.get_terminal_info.return_value = {}
    client.is_connected.return_value = True
    client.get_symbol_info.return_value = None
    client.get_live_tick.return_value = None

    app._push_m1m5_mt5_snapshot()

    payload = api.post_m1m5_mt5_snapshot.call_args[0][1]
    assert payload["terminalTradeAllowed"] is None
    assert payload["accountTradeAllowed"] is None
    assert payload["leverage"] is None
    assert payload["sessionOpen"] is None


def test_a_stale_tick_means_the_session_is_not_open():
    app, client, _api, _executor = _app()
    client.get_symbol_info.return_value = {"trade_mode": 4}
    client.get_live_tick.return_value = {
        "bid": 4360.0, "ask": 4360.5,
        "time": datetime.now(timezone.utc) - timedelta(hours=3),
    }

    assert app._m1m5_session_open() is False


def test_a_disabled_symbol_means_the_session_is_not_open():
    app, client, _api, _executor = _app()
    client.get_symbol_info.return_value = {"trade_mode": 0}

    assert app._m1m5_session_open() is False
    client.get_live_tick.assert_not_called()


def test_a_failed_snapshot_push_never_raises():
    app, client, api, _executor = _app()
    client.get_account_info.return_value = {"leverage": 100}
    client.get_terminal_info.return_value = {}
    client.is_connected.return_value = True
    client.get_symbol_info.return_value = None
    client.get_live_tick.return_value = None
    api.post_m1m5_mt5_snapshot.side_effect = ApiClientError("backend down")

    app._push_m1m5_mt5_snapshot()  # must not raise


def test_nothing_is_polled_while_the_flag_is_off():
    """The flag is the boundary. With it off this deployment must not reach
    the strategy's routes at all, however else it is configured."""
    app, client, api, executor = _app(m1m5_execution_enabled=False)
    client.is_connected.return_value = True

    assert app._config.m1m5_execution_enabled is False
    api.get_pending_m1m5_order.assert_not_called()
    api.post_m1m5_mt5_snapshot.assert_not_called()
    executor.send_bracket_order.assert_not_called()


# --- the close path -------------------------------------------------------


def _close_request(**overrides):
    request = {
        "requestId": "req-1",
        "ticket": "58537207521",
        "kind": "POSITION",
        "timeframe": "M1",
        "magic": 262610200,
        "volume": 0.5,
        "reason": "FRIDAY_LIQUIDATION",
        "symbol": "XAUUSD",
    }
    request.update(overrides)
    return request


def _live_position(ticket=58537207521, pos_type=1, volume=0.5):
    # MT5 POSITION_TYPE_BUY == 0, POSITION_TYPE_SELL == 1.
    return SimpleNamespace(ticket=ticket, type=pos_type, volume=volume)


def test_nothing_is_closed_when_the_backend_has_no_request():
    app, _client, api, executor = _app()
    api.get_m1m5_close_request.return_value = {"request": None}

    app._poll_and_execute_m1m5_close_request()

    executor.close_position.assert_not_called()
    api.post_m1m5_close_result.assert_not_called()


def test_a_failed_close_poll_never_raises_and_never_closes():
    app, _client, api, executor = _app()
    api.get_m1m5_close_request.side_effect = ApiClientError("backend down")

    app._poll_and_execute_m1m5_close_request()

    executor.close_position.assert_not_called()


def test_a_close_uses_the_LIVE_side_and_volume_not_the_request_s():
    """A partial close since the request was written makes the stored volume
    wrong, and on a hedging account closing the wrong volume OPENS an opposing
    position rather than doing nothing."""
    app, _client, api, executor = _app()
    api.get_m1m5_close_request.return_value = {"request": _close_request(volume=0.5)}
    executor.find_open_position.return_value = _live_position(pos_type=1, volume=0.2)
    executor.close_position.return_value = OrderResult(ok=True, ticket=58537207521, retcode=10009)

    app._poll_and_execute_m1m5_close_request()

    sent = executor.close_position.call_args.kwargs
    assert sent["side"] == "SELL"
    assert sent["volume"] == 0.2
    assert sent["ticket"] == 58537207521
    assert api.post_m1m5_close_result.call_args[0][2]["accepted"] is True


def test_a_ticket_mismatch_refuses_to_close_anything():
    """The request was built from stored broker state that is by definition a
    little old. The terminal is the authority on what is open, and closing a
    ticket that has moved on is the mistake worth engineering against."""
    app, _client, api, executor = _app()
    api.get_m1m5_close_request.return_value = {"request": _close_request(ticket="111")}
    executor.find_open_position.return_value = _live_position(ticket=999)

    app._poll_and_execute_m1m5_close_request()

    executor.close_position.assert_not_called()
    reported = api.post_m1m5_close_result.call_args[0][2]
    assert reported["accepted"] is False
    assert "mismatch" in reported["errorMessage"]


def test_a_missing_position_is_reported_rather_than_guessed_at():
    app, _client, api, executor = _app()
    api.get_m1m5_close_request.return_value = {"request": _close_request()}
    executor.find_open_position.return_value = None

    app._poll_and_execute_m1m5_close_request()

    executor.close_position.assert_not_called()
    assert api.post_m1m5_close_result.call_args[0][2]["accepted"] is False


def test_the_position_is_looked_up_by_THIS_strategys_magic_number():
    """The scoping rule. Another bot trades the same symbol on this broker, so
    the lookup is never 'any position on XAUUSD'."""
    app, _client, api, executor = _app()
    api.get_m1m5_close_request.return_value = {"request": _close_request(magic=262610201)}
    executor.find_open_position.return_value = None

    app._poll_and_execute_m1m5_close_request()

    executor.find_open_position.assert_called_once_with(262610201, "XAUUSD")


def test_a_broker_refusal_is_reported_as_not_accepted():
    app, _client, api, executor = _app()
    api.get_m1m5_close_request.return_value = {"request": _close_request()}
    executor.find_open_position.return_value = _live_position()
    executor.close_position.return_value = OrderResult(
        ok=False, retcode=10018, error_message="market closed",
    )

    app._poll_and_execute_m1m5_close_request()

    reported = api.post_m1m5_close_result.call_args[0][2]
    assert reported["accepted"] is False
    assert reported["errorMessage"] == "market closed"


# --- protection remediation ------------------------------------------------


def _protection_request(**overrides):
    request = {
        "requestId": "req-p1",
        "ticket": "58537207521",
        "timeframe": "M1",
        "magic": 262610200,
        "stopLoss": 4365.0,
        "takeProfit": 4355.0,
        "missing": "STOP_LOSS",
        "symbol": "XAUUSD",
    }
    request.update(overrides)
    return request


def test_nothing_is_repaired_when_there_is_no_request():
    app, _client, api, executor = _app()
    api.get_m1m5_protection_request.return_value = {"request": None}

    app._poll_and_execute_m1m5_protection_request()

    executor.modify_protection.assert_not_called()


def test_protection_is_restored_to_the_levels_the_backend_supplied():
    """Never recomputed here from the current price. A stop moved to where the
    market is now silently changes the risk the trade was sized for."""
    app, _client, api, executor = _app()
    api.get_m1m5_protection_request.return_value = {"request": _protection_request()}
    executor.find_open_position.return_value = _live_position()
    executor.modify_protection.return_value = OrderResult(ok=True, ticket=58537207521, retcode=10009)

    app._poll_and_execute_m1m5_protection_request()

    sent = executor.modify_protection.call_args.kwargs
    assert sent["stop_loss"] == 4365.0
    assert sent["take_profit"] == 4355.0
    assert sent["ticket"] == 58537207521
    assert api.post_m1m5_protection_result.call_args[0][2]["accepted"] is True


def test_a_repair_never_closes_anything():
    """The whole reason protection requests are a separate route and table: a
    repair that took the close path would turn a protective action into an
    unintended exit."""
    app, _client, api, executor = _app()
    api.get_m1m5_protection_request.return_value = {"request": _protection_request()}
    executor.find_open_position.return_value = _live_position()
    executor.modify_protection.return_value = OrderResult(ok=True, ticket=58537207521, retcode=10009)

    app._poll_and_execute_m1m5_protection_request()

    executor.close_position.assert_not_called()


def test_a_repair_ticket_mismatch_changes_nothing():
    app, _client, api, executor = _app()
    api.get_m1m5_protection_request.return_value = {"request": _protection_request(ticket="111")}
    executor.find_open_position.return_value = _live_position(ticket=999)

    app._poll_and_execute_m1m5_protection_request()

    executor.modify_protection.assert_not_called()
    assert api.post_m1m5_protection_result.call_args[0][2]["accepted"] is False


def test_a_failed_repair_poll_never_raises():
    app, _client, api, executor = _app()
    api.get_m1m5_protection_request.side_effect = ApiClientError("backend down")

    app._poll_and_execute_m1m5_protection_request()

    executor.modify_protection.assert_not_called()


# --- algo-trading switch observability --------------------------------------


def test_the_first_observation_of_algo_trading_is_logged(caplog):
    app, _client, _api, _executor = _app()
    with caplog.at_level("INFO", logger="collector.runner"):
        app._note_terminal_trade_allowed({"trade_allowed": True})
    assert any("algo trading is ON" in r.message for r in caplog.records)


def test_algo_trading_turning_off_is_a_warning_with_its_transition(caplog):
    app, _client, _api, _executor = _app()
    app._note_terminal_trade_allowed({"trade_allowed": True})
    caplog.clear()
    with caplog.at_level("INFO", logger="collector.runner"):
        app._note_terminal_trade_allowed({"trade_allowed": False})
    off = [r for r in caplog.records if "is OFF" in r.message]
    assert off and off[0].levelname == "WARNING"


def test_an_unchanged_state_is_not_logged_every_cycle(caplog):
    app, _client, _api, _executor = _app()
    app._note_terminal_trade_allowed({"trade_allowed": True})
    caplog.clear()
    with caplog.at_level("INFO", logger="collector.runner"):
        for _ in range(5):
            app._note_terminal_trade_allowed({"trade_allowed": True})
    assert not caplog.records


def test_an_unreadable_state_is_reported_not_treated_as_on(caplog):
    app, _client, _api, _executor = _app()
    with caplog.at_level("INFO", logger="collector.runner"):
        app._note_terminal_trade_allowed(None)
    assert any("could not be read" in r.message for r in caplog.records)
