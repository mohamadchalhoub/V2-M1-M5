"""The one-second V2 execution pass.

The pass exists to remove OUR scheduling delay -- the first real trade waited
22.5s between being queued and being sent, because queued orders were picked
up only once per ten-second main-loop cycle. Everything here is about doing
that without weakening anything:

  - repeated one-second passes can never produce a second order;
  - a pass never claims an order it cannot then place;
  - every safeguard still runs at send time, with the limits the backend sent;
  - an outcome that MAY be a live position is reported as uncertain, so the
    backend keeps its slot held;
  - the timeline is measured and reported, and our latency is kept apart from
    the broker's.
"""
import threading
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

from app.executor import DemoAccountRequiredError, OrderResult
from tests.test_runner_m1m5_execution import _app, _order


def _filled():
    return OrderResult(ok=True, ticket=58566028247, volume_filled=0.03, price=4360.0, retcode=10009)


def _reported(api):
    return api.post_m1m5_execution_result.call_args[0][2]


# --- at most one order, however often the pass runs ----------------------------


def test_repeated_one_second_passes_place_one_order_for_one_crossing():
    """The backend's claim is atomic: a claimed order is no longer offered.
    Modelled here by the poll returning the order once and nothing after --
    exactly what the guarded PENDING -> SENT update produces."""
    app, _client, api, executor = _app()
    api.get_pending_m1m5_order.side_effect = [{"order": _order()}] + [{"order": None}] * 9
    executor.send_bracket_order.return_value = _filled()
    app._read_position_protection = MagicMock(return_value=(4365.0, 4355.0))

    for _ in range(10):
        app._m1m5_fast_execution_pass()

    assert executor.send_bracket_order.call_count == 1
    assert api.post_m1m5_execution_result.call_count == 1


def test_a_pass_does_not_poll_while_the_mt5_lock_is_held():
    """The poll CLAIMS the order. Polling without the lock could claim an
    order this pass cannot then place; so without the lock it does not poll,
    and the order stays unclaimed for the next second."""
    app, _client, api, executor = _app()
    app._mt5_call_lock.acquire()
    try:
        app._m1m5_fast_execution_pass()
    finally:
        app._mt5_call_lock.release()

    api.get_pending_m1m5_order.assert_not_called()
    executor.send_bracket_order.assert_not_called()


def test_a_pass_releases_the_lock_even_when_execution_raises():
    app, _client, api, _executor = _app()
    api.get_pending_m1m5_order.side_effect = RuntimeError("boom")

    try:
        app._m1m5_fast_execution_pass()
    except RuntimeError:
        pass

    assert app._mt5_call_lock.acquire(blocking=False)
    app._mt5_call_lock.release()


def test_the_one_second_loop_runs_the_execution_pass():
    app, _client, _api, _executor = _app(m1m5_execution_enabled=True)
    app._observe_rsi_once = MagicMock()
    calls = []

    def one_pass():
        calls.append(1)
        app._stop_event.set()

    app._m1m5_fast_execution_pass = one_pass
    thread = threading.Thread(target=app._rsi_observation_loop)
    thread.start()
    thread.join(timeout=5)

    assert calls == [1]


def test_a_tick_stream_failure_does_not_stop_the_execution_pass():
    app, _client, _api, _executor = _app(m1m5_execution_enabled=True)
    app._observe_rsi_once = MagicMock(side_effect=RuntimeError("tick stream down"))
    calls = []

    def one_pass():
        calls.append(1)
        app._stop_event.set()

    app._m1m5_fast_execution_pass = one_pass
    thread = threading.Thread(target=app._rsi_observation_loop)
    thread.start()
    thread.join(timeout=5)

    assert calls == [1]


# --- every safeguard still runs at send time -----------------------------------


def test_a_signal_that_aged_past_the_limit_is_not_sent():
    app, _client, api, executor = _app()
    stale = (datetime.now(timezone.utc) - timedelta(seconds=61)).isoformat()
    api.get_pending_m1m5_order.return_value = {"order": _order(observedAt=stale)}

    app._m1m5_fast_execution_pass()

    executor.send_bracket_order.assert_not_called()
    reported = _reported(api)
    assert reported["notSent"] is True
    assert "old" in reported["errorMessage"]


def test_an_entry_that_drifted_past_the_limit_is_not_sent():
    # Signal at 4360.00; a SELL executes at the bid, now 4361.50 = 150 points.
    app, client, api, executor = _app()
    client.get_live_tick.return_value = {"bid": 4361.5, "ask": 4362.0, "time": datetime.now(timezone.utc).isoformat()}
    api.get_pending_m1m5_order.return_value = {"order": _order(side="SELL")}

    app._m1m5_fast_execution_pass()

    executor.send_bracket_order.assert_not_called()
    assert _reported(api)["notSent"] is True
    assert "moved" in _reported(api)["errorMessage"]


def test_drift_inside_the_limit_is_sent():
    # 4360.50 against a 4360.00 signal = 50 points, inside the 100-point limit.
    app, client, api, executor = _app()
    client.get_live_tick.return_value = {"bid": 4360.5, "ask": 4361.0, "time": datetime.now(timezone.utc).isoformat()}
    api.get_pending_m1m5_order.return_value = {"order": _order(side="SELL")}
    executor.send_bracket_order.return_value = _filled()
    app._read_position_protection = MagicMock(return_value=(4365.0, 4355.0))

    app._m1m5_fast_execution_pass()

    executor.send_bracket_order.assert_called_once()


def test_an_order_without_its_limits_is_refused_rather_than_unchecked():
    # Fail closed: a missing limit must never mean a skipped check.
    app, _client, api, executor = _app()
    order = _order()
    del order["maxEntryDeviationPoints"]
    api.get_pending_m1m5_order.return_value = {"order": order}

    app._m1m5_fast_execution_pass()

    executor.send_bracket_order.assert_not_called()
    assert _reported(api)["notSent"] is True


def test_no_live_quote_at_send_is_not_sent():
    app, client, api, executor = _app()
    client.get_live_tick.return_value = None
    api.get_pending_m1m5_order.return_value = {"order": _order()}

    app._m1m5_fast_execution_pass()

    executor.send_bracket_order.assert_not_called()
    assert _reported(api)["notSent"] is True


# --- an outcome that may be a live position keeps its slot ---------------------


def test_an_exception_during_the_broker_call_is_UNCERTAIN_not_a_failure():
    """Mid-call, we cannot know whether the order reached the broker. Reported
    as a plain failure, the backend would free the slot and permit a second
    position on a timeframe that may already hold one."""
    app, _client, api, executor = _app()
    api.get_pending_m1m5_order.return_value = {"order": _order()}
    executor.send_bracket_order.side_effect = ConnectionError("IPC dropped mid-send")

    app._m1m5_fast_execution_pass()

    reported = _reported(api)
    assert reported["uncertain"] is True
    assert "notSent" not in reported


def test_the_demo_check_failing_is_not_sent_because_it_runs_before_order_send():
    app, _client, api, executor = _app()
    api.get_pending_m1m5_order.return_value = {"order": _order()}
    executor.send_bracket_order.side_effect = DemoAccountRequiredError("account is REAL")

    app._m1m5_fast_execution_pass()

    reported = _reported(api)
    assert reported["notSent"] is True
    assert reported["uncertain"] is False


# --- the timeline ------------------------------------------------------------------


def test_a_fill_reports_its_timeline_in_order():
    app, _client, api, executor = _app()
    api.get_pending_m1m5_order.return_value = {"order": _order()}
    executor.send_bracket_order.return_value = _filled()
    app._read_position_protection = MagicMock(return_value=(4365.0, 4355.0))

    app._m1m5_fast_execution_pass()

    reported = _reported(api)
    evaluated = datetime.fromisoformat(reported["executionEvaluatedAt"])
    submitted = datetime.fromisoformat(reported["submittedAt"])
    acknowledged = datetime.fromisoformat(reported["acknowledgedAt"])
    assert evaluated <= submitted <= acknowledged
    # True UTC, so they compare cleanly with the backend's detection time.
    assert evaluated.utcoffset() == timedelta(0)


def test_a_not_sent_order_reports_when_it_was_evaluated_but_never_a_submission():
    app, _client, api, _executor = _app()
    stale = (datetime.now(timezone.utc) - timedelta(seconds=61)).isoformat()
    api.get_pending_m1m5_order.return_value = {"order": _order(observedAt=stale)}

    app._m1m5_fast_execution_pass()

    reported = _reported(api)
    assert "executionEvaluatedAt" in reported
    assert "submittedAt" not in reported
    assert "acknowledgedAt" not in reported
