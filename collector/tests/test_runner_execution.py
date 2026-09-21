"""Autonomous demo trading (v2), Phase 6 — CollectorApp's
_poll_and_execute_pending_order / _report_execution_result. Mt5Client/
ApiClient/Executor are all mocked; no live terminal or backend involved,
same posture as test_runner_candle_sync.py.
"""
from __future__ import annotations

from dataclasses import dataclass
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
    collector_api_base_url: str = "http://localhost:3000"
    initial_sync_days: int = 90
    history_sync_overlap_minutes: int = 5
    candle_symbols: tuple[str, ...] = ()
    candle_timeframes: tuple[str, ...] = ("M5",)
    candle_sync_interval_seconds: int = 300
    candle_initial_sync_days: int = 730
    autonomous_execution_enabled: bool = True


def _app() -> tuple[CollectorApp, MagicMock, MagicMock]:
    api = MagicMock()
    executor = MagicMock()
    app = CollectorApp(_FakeConfig(), MagicMock(), api, executor)
    return app, api, executor


def _order(**overrides) -> dict:
    base = {
        "decisionId": "decision-1", "side": "BUY", "volume": 0.01,
        "stopLossPoints": 180, "takeProfitPoints": 180, "magic": 262610180, "comment": "autonomous-decision1",
    }
    base.update(overrides)
    return base


def test_does_nothing_when_there_is_no_pending_order():
    app, api, executor = _app()
    api.get_pending_order.return_value = {"order": None}

    app._poll_and_execute_pending_order()

    executor.send_bracket_order.assert_not_called()
    api.post_execution_result.assert_not_called()


def test_executes_a_claimed_order_and_reports_a_successful_fill():
    app, api, executor = _app()
    api.get_pending_order.return_value = {"order": _order()}
    executor.send_bracket_order.return_value = OrderResult(ok=True, ticket=555, volume_filled=0.01, price=1.1, retcode=10009)

    app._poll_and_execute_pending_order()

    executor.send_bracket_order.assert_called_once_with(
        side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180,
        magic=262610180, comment="autonomous-decision1",
    )
    api.post_execution_result.assert_called_once_with(
        "acct-1", "decision-1", {"ok": True, "ticket": 555, "filledPrice": 1.1},
    )


def test_reports_a_failed_execution_without_a_ticket():
    app, api, executor = _app()
    api.get_pending_order.return_value = {"order": _order()}
    executor.send_bracket_order.return_value = OrderResult(ok=False, error_message="Requote, retry also failed")

    app._poll_and_execute_pending_order()

    api.post_execution_result.assert_called_once_with(
        "acct-1", "decision-1", {"ok": False, "errorMessage": "Requote, retry also failed"},
    )


def test_a_sell_order_is_passed_through_correctly():
    app, api, executor = _app()
    api.get_pending_order.return_value = {"order": _order(side="SELL")}
    executor.send_bracket_order.return_value = OrderResult(ok=True, ticket=1, price=1.0)

    app._poll_and_execute_pending_order()

    assert executor.send_bracket_order.call_args.kwargs["side"] == "SELL"


def test_a_demo_account_failure_is_reported_back_and_never_crashes_the_loop():
    app, api, executor = _app()
    api.get_pending_order.return_value = {"order": _order()}
    executor.send_bracket_order.side_effect = DemoAccountRequiredError("trade_mode is not DEMO")

    app._poll_and_execute_pending_order()  # must not raise

    api.post_execution_result.assert_called_once_with(
        "acct-1", "decision-1", {"ok": False, "errorMessage": "trade_mode is not DEMO"},
    )


def test_an_unexpected_exception_during_execution_never_crashes_the_loop():
    app, api, executor = _app()
    api.get_pending_order.return_value = {"order": _order()}
    executor.send_bracket_order.side_effect = RuntimeError("something in MetaTrader5 blew up")

    app._poll_and_execute_pending_order()  # must not raise

    api.post_execution_result.assert_called_once()
    assert api.post_execution_result.call_args[0][2]["ok"] is False


def test_a_failed_poll_never_crashes_the_loop_and_never_attempts_execution():
    app, api, executor = _app()
    api.get_pending_order.side_effect = ApiClientError("connection refused")

    app._poll_and_execute_pending_order()  # must not raise

    executor.send_bracket_order.assert_not_called()


def test_a_failed_result_report_never_crashes_the_loop():
    app, api, executor = _app()
    api.get_pending_order.return_value = {"order": _order()}
    executor.send_bracket_order.return_value = OrderResult(ok=True, ticket=1, price=1.1)
    api.post_execution_result.side_effect = ApiClientError("connection refused")

    app._poll_and_execute_pending_order()  # must not raise
