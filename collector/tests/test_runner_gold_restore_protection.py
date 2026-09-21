"""Task item 3 — "restore-then-close" protection remediation, RESTORE half.
CollectorApp._poll_and_execute_gold_restore_protection_request /
_report_gold_restore_protection_result. Mt5Client/ApiClient/Executor are
all mocked; no live terminal or backend involved, same posture as
test_runner_gold_close_request.py.
"""
from __future__ import annotations

from dataclasses import dataclass
from unittest.mock import MagicMock

from app.api_client import ApiClientError
from app.executor import OrderResult
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
    gold_execution_enabled: bool = True


def _app() -> tuple[CollectorApp, MagicMock, MagicMock]:
    api = MagicMock()
    executor = MagicMock()
    app = CollectorApp(_FakeConfig(), MagicMock(), api, executor)
    return app, api, executor


def _request(**overrides) -> dict:
    base = {"requestId": "req-1", "ticket": 999001, "side": "BUY", "stopLoss": 2640.0, "takeProfit": 2660.0, "symbol": "XAUUSD", "attemptNumber": 1, "maxAttempts": 3}
    base.update(overrides)
    return base


def test_does_nothing_when_there_is_no_restore_request():
    app, api, executor = _app()
    api.get_gold_restore_protection_request.return_value = {"request": None}

    app._poll_and_execute_gold_restore_protection_request()

    executor.modify_protection.assert_not_called()
    api.post_gold_restore_protection_result.assert_not_called()


def test_executes_a_claimed_restore_request_with_the_exact_prices_and_reports_success():
    app, api, executor = _app()
    api.get_gold_restore_protection_request.return_value = {"request": _request()}
    executor.modify_protection.return_value = OrderResult(ok=True, outcome="FILLED", retcode=10009)

    app._poll_and_execute_gold_restore_protection_request()

    executor.modify_protection.assert_called_once_with(ticket=999001, stop_loss=2640.0, take_profit=2660.0, symbol="XAUUSD")
    api.post_gold_restore_protection_result.assert_called_once_with("acct-1", "req-1", {"ok": True})


def test_reports_a_broker_failure_as_ok_false():
    app, api, executor = _app()
    api.get_gold_restore_protection_request.return_value = {"request": _request()}
    executor.modify_protection.return_value = OrderResult(ok=False, outcome="FAILED", error_message="invalid stops", retcode=10016)

    app._poll_and_execute_gold_restore_protection_request()

    posted = api.post_gold_restore_protection_result.call_args[0][2]
    assert posted["ok"] is False
    assert posted["errorMessage"] == "invalid stops"


def test_an_unexpected_exception_from_modify_protection_is_reported_not_raised():
    app, api, executor = _app()
    api.get_gold_restore_protection_request.return_value = {"request": _request()}
    executor.modify_protection.side_effect = RuntimeError("boom")

    app._poll_and_execute_gold_restore_protection_request()  # must not raise

    posted = api.post_gold_restore_protection_result.call_args[0][2]
    assert posted["ok"] is False
    assert "boom" in posted["errorMessage"]


def test_a_poll_failure_is_swallowed_and_retried_next_tick():
    app, api, executor = _app()
    api.get_gold_restore_protection_request.side_effect = ApiClientError("network down")

    app._poll_and_execute_gold_restore_protection_request()  # must not raise

    executor.modify_protection.assert_not_called()


def test_a_report_failure_is_swallowed_not_raised():
    app, api, executor = _app()
    api.get_gold_restore_protection_request.return_value = {"request": _request()}
    executor.modify_protection.return_value = OrderResult(ok=True, outcome="FILLED")
    api.post_gold_restore_protection_result.side_effect = ApiClientError("network down")

    app._poll_and_execute_gold_restore_protection_request()  # must not raise
