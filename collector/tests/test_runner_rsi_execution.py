"""Collector-side behaviour for `xauusd-m1-rsi-retest-extremes-v1`:
the live tick stream and the entry poll.

The cases that matter most here are the negative ones — that nothing is
reached while the flag is off, and that an ambiguous broker response is
reported as UNCERTAIN rather than as a failure, because reporting a lost
response as a failure would free the position slot on an assumption.
"""
from dataclasses import dataclass, field
from unittest.mock import MagicMock

import pytest

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
    rsi_execution_enabled: bool = True
    mt5_broker_timezone: str = "UTC"
    candle_timeframes_by_symbol: dict = field(default_factory=dict)

def _app(**overrides):
    client, api, executor = MagicMock(), MagicMock(), MagicMock()
    config = _FakeConfig(**overrides)
    app = CollectorApp(config=config, client=client, api=api, executor=executor)
    return app, client, api, executor

def test_no_order_is_attempted_when_the_backend_has_nothing_queued():
    app, _client, api, executor = _app()
    api.get_pending_rsi_order.return_value = {"order": None}

    app._poll_and_execute_pending_rsi_order()

    executor.send_bracket_order.assert_not_called()
    api.post_rsi_execution_result.assert_not_called()

def test_a_failed_poll_never_raises_and_never_executes():
    from app.api_client import ApiClientError

    app, _client, api, executor = _app()
    api.get_pending_rsi_order.side_effect = ApiClientError("backend down")

    app._poll_and_execute_pending_rsi_order()

    executor.send_bracket_order.assert_not_called()

def _order(**overrides):
    order = {
        "decisionId": "dec-1",
        "side": "SELL",
        "volume": 0.5,
        "entryPrice": 4345.0,
        "stopLoss": 4350.0,
        "takeProfit": 4340.0,
        "stopLossPoints": 500.0,
        "takeProfitPoints": 500.0,
        "magic": 262610190,
        "symbol": "XAUUSD",
        "pointSize": 0.01,
        "comment": "rsi-dec-1",
    }
    order.update(overrides)
    return {"order": order}

def test_a_confirmed_fill_is_reported_with_its_ticket_and_price():
    app, _client, api, executor = _app()
    api.get_pending_rsi_order.return_value = _order()
    executor.send_bracket_order.return_value = OrderResult(
        ok=True, ticket=4242, price=4345.1, retcode=10009,
    )
    executor.find_any_position.return_value = None

    app._poll_and_execute_pending_rsi_order()

    sent = executor.send_bracket_order.call_args.kwargs
    assert sent["side"] == "SELL"
    assert sent["volume"] == 0.5
    assert sent["magic"] == 262610190
    assert sent["symbol"] == "XAUUSD"
    # The $5 bracket, expressed in gold points.
    assert sent["stop_loss_points"] == 500.0
    assert sent["take_profit_points"] == 500.0

    payload = api.post_rsi_execution_result.call_args.args[2]
    assert payload["ok"] is True
    assert payload["uncertain"] is False
    assert payload["ticket"] == 4242
    assert payload["filledPrice"] == 4345.1

def test_a_clear_broker_rejection_is_reported_as_failed_not_uncertain():
    app, _client, api, executor = _app()
    api.get_pending_rsi_order.return_value = _order()
    # A definite refusal: the broker answered with a retcode.
    executor.send_bracket_order.return_value = OrderResult(
        ok=False, ticket=None, price=None, retcode=10016, error_message="invalid stops",
    )

    app._poll_and_execute_pending_rsi_order()

    payload = api.post_rsi_execution_result.call_args.args[2]
    assert payload["ok"] is False
    assert payload["uncertain"] is False
    assert payload["errorMessage"] == "invalid stops"

def test_an_ambiguous_broker_response_is_reported_as_uncertain():
    app, _client, api, executor = _app()
    api.get_pending_rsi_order.return_value = _order()
    # No ticket AND no retcode: the executor could not establish what
    # happened. This must NOT be reported as a plain failure — the order may
    # well have reached the broker.
    executor.send_bracket_order.return_value = OrderResult(
        ok=False, ticket=None, price=None, retcode=None, error_message="no response from terminal",
    )

    app._poll_and_execute_pending_rsi_order()

    payload = api.post_rsi_execution_result.call_args.args[2]
    assert payload["ok"] is False
    assert payload["uncertain"] is True

def test_a_failed_demo_account_check_is_reported_and_never_retried_silently():
    app, _client, api, executor = _app()
    api.get_pending_rsi_order.return_value = _order()
    executor.send_bracket_order.side_effect = DemoAccountRequiredError("account is REAL")

    app._poll_and_execute_pending_rsi_order()

    payload = api.post_rsi_execution_result.call_args.args[2]
    assert payload["ok"] is False
    assert "REAL" in payload["errorMessage"]

def test_broker_reported_protection_is_read_back_after_a_fill():
    app, _client, api, executor = _app()
    api.get_pending_rsi_order.return_value = _order()
    executor.send_bracket_order.return_value = OrderResult(ok=True, ticket=4242, price=4345.1, retcode=10009)
    position = MagicMock()
    position.ticket = 4242
    position.sl = 4350.0
    position.tp = 4340.0
    executor.find_any_position.return_value = position

    app._poll_and_execute_pending_rsi_order()

    payload = api.post_rsi_execution_result.call_args.args[2]
    assert payload["brokerStopLoss"] == 4350.0
    assert payload["brokerTakeProfit"] == 4340.0

def test_zero_protection_from_the_broker_is_reported_as_absent_not_as_a_price():
    app, _client, api, executor = _app()
    api.get_pending_rsi_order.return_value = _order()
    executor.send_bracket_order.return_value = OrderResult(ok=True, ticket=4242, price=4345.1, retcode=10009)
    position = MagicMock()
    position.ticket = 4242
    position.sl = 0.0   # MT5's "no level set"
    position.tp = 0.0
    executor.find_any_position.return_value = position

    app._poll_and_execute_pending_rsi_order()

    payload = api.post_rsi_execution_result.call_args.args[2]
    assert "brokerStopLoss" not in payload
    assert "brokerTakeProfit" not in payload

def test_protection_readback_never_attributes_another_positions_levels():
    app, _client, api, executor = _app()
    api.get_pending_rsi_order.return_value = _order()
    executor.send_bracket_order.return_value = OrderResult(ok=True, ticket=4242, price=4345.1, retcode=10009)
    other = MagicMock()
    other.ticket = 9999  # a different position entirely
    other.sl = 1.0
    other.tp = 2.0
    executor.find_any_position.return_value = other

    app._poll_and_execute_pending_rsi_order()

    payload = api.post_rsi_execution_result.call_args.args[2]
    assert "brokerStopLoss" not in payload

# --- One-second XAUUSD observation loop ---------------------------------
#
# The requirement is an observation every second that yields REAL new market
# information. These cases therefore concentrate on what must NOT happen: the
# same tick counted twice, a synthetic observation manufactured because a poll
# happened, or a cursor advanced past data that was never successfully pushed.


def _tick(msc, bid=4345.1, ask=4345.3, seq=0):
    from datetime import datetime, timezone

    return {
        "timestamp": datetime.fromtimestamp(msc / 1000, tz=timezone.utc).isoformat(),
        "time_msc": msc,
        "bid": bid,
        "ask": ask,
        "last": None,
        "volume": None,
        "volume_real": None,
        "flags": 6,
        "batch_seq": seq,
    }


def test_the_mt5_lock_is_free_during_the_http_push():
    """Real incident, 2026-09-24: this push can legitimately carry a large
    batch on a fast-moving symbol, and holding the shared MT5 lock for that
    whole HTTP round-trip (this stream runs every second, from the same
    thread that also drives xauusd-sar-v1's fast pass) starved SAR's order
    execution and the main loop's account snapshot -- the dashboard showed
    the collector itself as DOWN for as long as this held the lock. The
    push touches no MT5 state, so the lock must already be free by the time
    it happens."""
    app, client, api, _executor = _app()
    client.is_connected.return_value = True
    client.get_ticks_from.return_value = [_tick(1_789_000_000_000)]

    lock_was_held_during_push = {"value": None}

    def _post_ticks(payload):
        lock_was_held_during_push["value"] = not app._mt5_call_lock.acquire(blocking=False)
        if not lock_was_held_during_push["value"]:
            app._mt5_call_lock.release()
        return {"inserted": 1}

    api.post_ticks.side_effect = _post_ticks

    app._observe_rsi_once()

    assert lock_was_held_during_push["value"] is False


def test_one_observation_pushes_incremental_ticks():
    app, client, api, _executor = _app()
    client.is_connected.return_value = True
    client.get_ticks_from.return_value = [_tick(1_789_000_000_000), _tick(1_789_000_000_500, seq=1)]
    api.post_ticks.return_value = {"inserted": 2}

    app._observe_rsi_once()

    assert client.get_ticks_from.call_args.args[0] == "XAUUSD"
    payload = api.post_ticks.call_args.args[0]
    assert payload["symbol"] == "XAUUSD"
    assert len(payload["ticks"]) == 2
    # The internal cursor field must not leak into the wire payload.
    assert "time_msc" not in payload["ticks"][0]
    assert app._rsi_cursor_msc == 1_789_000_000_500


def test_the_cursor_boundary_tick_is_never_pushed_twice():
    app, client, api, _executor = _app()
    client.is_connected.return_value = True

    client.get_ticks_from.return_value = [_tick(1_789_000_000_000)]
    api.post_ticks.return_value = {"inserted": 1}
    app._observe_rsi_once()
    assert api.post_ticks.call_count == 1

    # copy_ticks_from is inclusive of its start, so the next call returns the
    # boundary tick again plus one genuinely new one. Only the new one may go.
    client.get_ticks_from.return_value = [_tick(1_789_000_000_000), _tick(1_789_000_000_250, seq=1)]
    app._observe_rsi_once()

    assert api.post_ticks.call_count == 2
    second = api.post_ticks.call_args.args[0]
    assert len(second["ticks"]) == 1
    assert app._rsi_duplicate_skips == 1


def test_no_new_ticks_pushes_nothing_at_all():
    # A poll having happened is not itself market information.
    app, client, api, _executor = _app()
    client.is_connected.return_value = True
    client.get_ticks_from.return_value = []

    app._observe_rsi_once()

    api.post_ticks.assert_not_called()
    assert app._rsi_cursor_msc is None


def test_an_unchanged_quote_produces_no_synthetic_observation():
    app, client, api, _executor = _app()
    client.is_connected.return_value = True
    client.get_ticks_from.return_value = [_tick(1_789_000_000_000)]
    api.post_ticks.return_value = {"inserted": 1}
    app._observe_rsi_once()

    # Same tick, nothing newer: the loop must stay silent rather than
    # re-reporting the last known price as if it were fresh.
    client.get_ticks_from.return_value = [_tick(1_789_000_000_000)]
    app._observe_rsi_once()

    assert api.post_ticks.call_count == 1


def test_the_cursor_does_not_advance_when_the_push_fails():
    from app.api_client import ApiClientError

    app, client, api, _executor = _app()
    client.is_connected.return_value = True
    client.get_ticks_from.return_value = [_tick(1_789_000_000_000)]
    api.post_ticks.side_effect = ApiClientError("backend down")

    app._observe_rsi_once()  # must not raise

    # Retried next second rather than silently lost.
    assert app._rsi_cursor_msc is None


def test_observation_never_raises_when_mt5_fails():
    app, client, api, _executor = _app()
    client.is_connected.return_value = True
    client.get_ticks_from.side_effect = RuntimeError("copy_ticks_from failed")

    app._observe_rsi_once()  # must not raise

    api.post_ticks.assert_not_called()


def test_observation_is_skipped_rather_than_queued_when_mt5_is_busy():
    app, client, api, _executor = _app()
    client.is_connected.return_value = True
    app._mt5_call_lock.acquire()
    try:
        app._observe_rsi_once()
    finally:
        app._mt5_call_lock.release()

    # Nothing read, nothing pushed: the next observation is one second away
    # and picks up everything since the cursor regardless.
    client.get_ticks_from.assert_not_called()
    api.post_ticks.assert_not_called()


def test_observation_does_nothing_while_disconnected():
    app, client, api, _executor = _app()
    client.is_connected.return_value = False

    app._observe_rsi_once()

    client.get_ticks_from.assert_not_called()
    api.post_ticks.assert_not_called()


def test_cadence_is_measured_across_observations():
    app, client, api, _executor = _app()
    client.is_connected.return_value = True
    client.get_ticks_from.return_value = []

    for _ in range(3):
        app._observe_rsi_once()

    assert app._rsi_observations == 3
    # Two intervals between three observations.
    assert len(app._rsi_cadence_samples) == 2


def test_the_observation_loop_is_only_started_when_the_strategy_is_enabled():
    app, _client, _api, _executor = _app(rsi_execution_enabled=False)
    assert app._rsi_observation_thread is None
