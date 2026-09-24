"""Collector-side behaviour for `xauusd-sar-v1` (Engine A replacement).

Two shapes matter most:

  INITIAL   a plain open — send_bracket_order only.
  REVERSAL  close the existing ticket FIRST (close_position), then open the
            new direction. A failure at either step must never be reported
            as a clean ok=False: a partial multi-step result is always
            UNCERTAIN, because guessing the account back into a known state
            from an ambiguous multi-step outcome is exactly what this
            codebase never does.
"""
from dataclasses import dataclass, field
from unittest.mock import MagicMock

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
    m1m5_execution_enabled: bool = False
    telegram_engine_execution_enabled: bool = False
    sar_execution_enabled: bool = True
    mt5_broker_timezone: str = "UTC"
    candle_timeframes_by_symbol: dict = field(default_factory=dict)


def _app(**overrides):
    client, api, executor = MagicMock(), MagicMock(), MagicMock()
    config = _FakeConfig(**overrides)
    app = CollectorApp(config=config, client=client, api=api, executor=executor)
    return app, api, executor


def _order(**overrides):
    order = {
        "idempotencyTag": "SARabc123",
        "kind": "INITIAL",
        "side": "BUY",
        "volume": 0.5,
        "magic": 262610220,
        "symbol": "XAUUSD",
        "pointSize": 0.01,
        "catastrophicStopPoints": 1000,
        "closingTicket": None,
        "comment": "sar-SARabc123",
    }
    order.update(overrides)
    return order


def test_nothing_is_attempted_when_the_backend_has_nothing_queued():
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {"order": None}

    app._poll_and_execute_pending_sar_order()

    executor.send_bracket_order.assert_not_called()
    executor.close_position.assert_not_called()
    api.post_sar_execution_result.assert_not_called()


def test_an_initial_order_never_calls_close_position():
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {"order": _order()}
    executor.send_bracket_order.return_value = OrderResult(ok=True, ticket=900001, price=4500.5)

    app._poll_and_execute_pending_sar_order()

    executor.close_position.assert_not_called()
    executor.send_bracket_order.assert_called_once()
    kwargs = executor.send_bracket_order.call_args.kwargs
    assert kwargs["side"] == "BUY"
    assert kwargs["stop_loss_points"] == 1000
    assert kwargs["take_profit_points"] == 1000  # the catastrophic backstop, not a real TP

    result = api.post_sar_execution_result.call_args.args
    assert result[0] == "acct-1"
    assert result[1] == "SARabc123"
    payload = api.post_sar_execution_result.call_args.args[2]
    assert payload["ok"] is True
    assert payload["ticket"] == 900001
    assert payload["uncertain"] is False


def test_a_reversal_closes_the_existing_ticket_before_opening_the_new_side():
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {"order": _order(kind="REVERSAL", side="SELL", closingTicket="900001")}
    executor.close_position.return_value = OrderResult(ok=True, ticket=900001, price=4502.5)
    executor.send_bracket_order.return_value = OrderResult(ok=True, ticket=900002, price=4502.5)

    app._poll_and_execute_pending_sar_order()

    executor.close_position.assert_called_once()
    close_kwargs = executor.close_position.call_args.kwargs
    assert close_kwargs["ticket"] == 900001
    assert close_kwargs["side"] == "BUY"  # closing a BUY-side existing position for a SELL reversal

    executor.send_bracket_order.assert_called_once()
    open_kwargs = executor.send_bracket_order.call_args.kwargs
    assert open_kwargs["side"] == "SELL"

    payload = api.post_sar_execution_result.call_args.args[2]
    assert payload["ok"] is True
    assert payload["ticket"] == 900002
    assert payload["uncertain"] is False


def test_a_reversal_never_opens_the_new_side_if_the_close_fails():
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {"order": _order(kind="REVERSAL", closingTicket="900001")}
    executor.close_position.return_value = OrderResult(ok=False, error_message="broker refused the close")

    app._poll_and_execute_pending_sar_order()

    executor.send_bracket_order.assert_not_called()
    payload = api.post_sar_execution_result.call_args.args[2]
    assert payload["ok"] is False
    assert payload["uncertain"] is True  # never a clean failure — the account state is now unclear


def test_a_reversal_whose_close_raises_is_reported_uncertain_not_failed():
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {"order": _order(kind="REVERSAL", closingTicket="900001")}
    executor.close_position.side_effect = RuntimeError("connection dropped")

    app._poll_and_execute_pending_sar_order()

    executor.send_bracket_order.assert_not_called()
    payload = api.post_sar_execution_result.call_args.args[2]
    assert payload["ok"] is False
    assert payload["uncertain"] is True


def test_a_reversal_whose_close_succeeds_but_whose_open_fails_is_reported_uncertain():
    """The account is now FLAT (the close worked) but the strategy's new
    cycle never opened. This is exactly the ambiguous case the backend must
    not guess its way out of, so it is always UNCERTAIN here, even though
    the broker gave a clean (non-exceptional) refusal for the open."""
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {"order": _order(kind="REVERSAL", closingTicket="900001")}
    executor.close_position.return_value = OrderResult(ok=True, ticket=900001, price=4502.5)
    executor.send_bracket_order.return_value = OrderResult(ok=False, error_message="insufficient margin")

    app._poll_and_execute_pending_sar_order()

    payload = api.post_sar_execution_result.call_args.args[2]
    assert payload["ok"] is False
    assert payload["uncertain"] is True


def test_an_initial_orders_clean_broker_refusal_is_not_uncertain():
    """Contrast with the reversal case above: a plain INITIAL open that the
    broker cleanly refuses has NOT touched anything at the broker, so it is
    reported as a straightforward failure, not an ambiguous one."""
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {"order": _order(kind="INITIAL")}
    executor.send_bracket_order.return_value = OrderResult(ok=False, retcode=10004, error_message="requote")

    app._poll_and_execute_pending_sar_order()

    payload = api.post_sar_execution_result.call_args.args[2]
    assert payload["ok"] is False
    assert payload["uncertain"] is False


def test_an_ambiguous_broker_answer_on_open_is_uncertain():
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {"order": _order(kind="INITIAL")}
    executor.send_bracket_order.return_value = OrderResult(ok=False, ticket=None, retcode=None, error_message="lost response")

    app._poll_and_execute_pending_sar_order()

    payload = api.post_sar_execution_result.call_args.args[2]
    assert payload["uncertain"] is True


def test_an_exception_during_open_is_reported_uncertain_never_a_failure():
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {"order": _order()}
    executor.send_bracket_order.side_effect = RuntimeError("socket closed mid-call")

    app._poll_and_execute_pending_sar_order()

    payload = api.post_sar_execution_result.call_args.args[2]
    assert payload["ok"] is False
    assert payload["uncertain"] is True


def test_demo_account_check_failure_refuses_before_order_send():
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {"order": _order()}
    executor.send_bracket_order.side_effect = DemoAccountRequiredError("not a DEMO account")

    app._poll_and_execute_pending_sar_order()

    payload = api.post_sar_execution_result.call_args.args[2]
    assert payload["ok"] is False


def test_a_failed_result_report_is_logged_and_never_crashes_the_loop():
    from app.api_client import ApiClientError

    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {"order": _order()}
    executor.send_bracket_order.return_value = OrderResult(ok=True, ticket=900001, price=4500.5)
    api.post_sar_execution_result.side_effect = ApiClientError("network down")

    app._poll_and_execute_pending_sar_order()  # must not raise


def test_a_poll_failure_is_logged_and_never_crashes_the_loop():
    from app.api_client import ApiClientError

    app, api, executor = _app()
    api.get_pending_sar_order.side_effect = ApiClientError("network down")

    app._poll_and_execute_pending_sar_order()  # must not raise

    executor.send_bracket_order.assert_not_called()
