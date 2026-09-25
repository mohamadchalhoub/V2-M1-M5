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
from types import SimpleNamespace
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


def _app_with_client(**overrides):
    client, api, executor = MagicMock(), MagicMock(), MagicMock()
    config = _FakeConfig(**overrides)
    app = CollectorApp(config=config, client=client, api=api, executor=executor)
    return app, client, api, executor


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


def _live_position(ticket=900001, volume=0.5):
    return SimpleNamespace(ticket=ticket, volume=volume)


def test_a_reversal_closes_the_existing_ticket_before_opening_the_new_side():
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {"order": _order(kind="REVERSAL", side="SELL", closingTicket="900001")}
    executor.find_open_position.return_value = _live_position(900001, 0.5)
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


def test_a_reversal_closes_the_LIVE_volume_not_the_queued_orders_volume():
    """Real incident, 2026-09-24: the operator changed the configured SAR
    volume (0.5 -> 0.02, in this test's numbers) between a cycle's entry and
    its reversal. Closing with the NEW order's queued volume against the
    OLD position's actual (larger) volume is a partial close that strands
    the remainder open under the same ticket and magic -- which then made
    send_bracket_order's own duplicate-position guard correctly refuse to
    open a second position on top of it, immediately afterward. The closing
    volume must always come from the live position, never the queued order."""
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {
        "order": _order(kind="REVERSAL", side="SELL", volume=0.02, closingTicket="900001"),
    }
    executor.find_open_position.return_value = _live_position(ticket=900001, volume=0.5)
    executor.close_position.return_value = OrderResult(ok=True, ticket=900001, price=4502.5)
    executor.send_bracket_order.return_value = OrderResult(ok=True, ticket=900002, price=4502.5)

    app._poll_and_execute_pending_sar_order()

    close_kwargs = executor.close_position.call_args.kwargs
    assert close_kwargs["volume"] == 0.5  # the LIVE position's volume, not the queued order's 0.02

    open_kwargs = executor.send_bracket_order.call_args.kwargs
    assert open_kwargs["volume"] == 0.02  # the new leg still uses the queued (current) volume


def test_a_reversal_refuses_and_reports_uncertain_when_the_live_ticket_does_not_match():
    """The backend's `closingTicket` was built from stored state that may
    already be stale by the time this runs -- exactly the reasoning
    `_poll_and_execute_m1m5_close_request` already documents for its own
    identical check. Never closes a position whose ticket does not match
    what the terminal actually shows."""
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {"order": _order(kind="REVERSAL", closingTicket="900001")}
    executor.find_open_position.return_value = _live_position(ticket=999999, volume=0.5)

    app._poll_and_execute_pending_sar_order()

    executor.close_position.assert_not_called()
    executor.send_bracket_order.assert_not_called()
    payload = api.post_sar_execution_result.call_args.args[2]
    assert payload["ok"] is False
    assert payload["uncertain"] is True


def test_a_reversal_refuses_when_the_position_is_already_gone():
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {"order": _order(kind="REVERSAL", closingTicket="900001")}
    executor.find_open_position.return_value = None

    app._poll_and_execute_pending_sar_order()

    executor.close_position.assert_not_called()
    payload = api.post_sar_execution_result.call_args.args[2]
    assert payload["ok"] is False
    assert payload["uncertain"] is True


def test_a_reversal_whose_live_position_lookup_raises_is_reported_uncertain():
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {"order": _order(kind="REVERSAL", closingTicket="900001")}
    executor.find_open_position.side_effect = RuntimeError("positions_get failed")

    app._poll_and_execute_pending_sar_order()

    executor.close_position.assert_not_called()
    payload = api.post_sar_execution_result.call_args.args[2]
    assert payload["ok"] is False
    assert payload["uncertain"] is True


def test_a_reversal_never_opens_the_new_side_if_the_close_fails():
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {"order": _order(kind="REVERSAL", closingTicket="900001")}
    executor.find_open_position.return_value = _live_position(900001, 0.5)
    executor.close_position.return_value = OrderResult(ok=False, error_message="broker refused the close")

    app._poll_and_execute_pending_sar_order()

    executor.send_bracket_order.assert_not_called()
    payload = api.post_sar_execution_result.call_args.args[2]
    assert payload["ok"] is False
    assert payload["uncertain"] is True  # never a clean failure — the account state is now unclear


def test_a_reversal_whose_close_raises_is_reported_uncertain_not_failed():
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {"order": _order(kind="REVERSAL", closingTicket="900001")}
    executor.find_open_position.return_value = _live_position(900001, 0.5)
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
    executor.find_open_position.return_value = _live_position(900001, 0.5)
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


# --- reconciliation push --------------------------------------------------
#
# Real incident, 2026-09-24: a reversal's close was rejected for "absence of
# network connection"; the backend correctly went REVERSAL_UNKNOWN and
# blocked, but reconciliation was never wired to a live broker feed, so the
# position sat unmanaged for ~23 minutes until its own $10 catastrophic
# backstop take-profit closed it (+$20, by luck). These tests cover the push
# this method sends, which the backend now uses to resolve that UNKNOWN
# automatically instead of requiring an operator to run SQL by hand.


def _sar_position(ticket, magic=262610220, comment=None):
    return {"ticket": ticket, "symbol": "XAUUSD", "comment": comment, "raw": {"magic": magic}}


def _sar_deal(ticket, position_id, entry, price, magic=262610220, comment=None):
    return {
        "ticket": ticket, "position_id": position_id, "entry": entry, "price": price,
        "comment": comment, "closed_at": None, "raw": {"magic": magic},
    }


def test_reconciliation_push_reports_mt5_connected_and_a_fresh_timestamp():
    app, client, api, _executor = _app_with_client()
    client.is_connected.return_value = True
    client.get_open_positions.return_value = []
    client.get_recent_deals.return_value = []

    app._push_sar_reconciliation()

    payload = api.post_sar_reconcile.call_args[0][1]
    assert payload["mt5Connected"] is True
    assert payload["snapshotComplete"] is True
    assert "snapshotAt" in payload


def test_reconciliation_push_reports_disconnected_and_skips_deal_lookup_when_mt5_is_down():
    app, client, api, _executor = _app_with_client()
    client.is_connected.return_value = False
    client.get_open_positions.return_value = []

    app._push_sar_reconciliation()

    client.get_recent_deals.assert_not_called()
    payload = api.post_sar_reconcile.call_args[0][1]
    assert payload["mt5Connected"] is False


def test_reconciliation_push_sends_only_sar_owned_positions():
    app, client, api, _executor = _app_with_client()
    client.is_connected.return_value = True
    client.get_open_positions.return_value = [
        _sar_position(1, magic=262610220),
        _sar_position(2, magic=262610210),  # Engine B
        _sar_position(3, magic=262610200),  # legacy RSI M1
        _sar_position(4, magic=None),  # manual position, no magic
    ]
    client.get_recent_deals.return_value = []

    app._push_sar_reconciliation()

    payload = api.post_sar_reconcile.call_args[0][1]
    assert [p["ticket"] for p in payload["positions"]] == ["1"]


def test_reconciliation_push_includes_positionid_distinct_from_the_deals_own_ticket():
    """The deal's own ticket and the position it closed are different
    numbers. Sending only `ticket` (as the original, never-wired version of
    this payload did) makes it impossible for the backend to match a closing
    deal back to the ticket it is watching -- this is the regression test
    for that."""
    app, client, api, _executor = _app_with_client()
    client.is_connected.return_value = True
    client.get_open_positions.return_value = []
    client.get_recent_deals.return_value = [
        _sar_deal(ticket=99000001, position_id=58606170943, entry="OUT", price=4272.78, comment="[tp 4272.78]"),
    ]

    app._push_sar_reconciliation()

    deal = api.post_sar_reconcile.call_args[0][1]["deals"][0]
    assert deal["ticket"] == "99000001"
    assert deal["positionId"] == "58606170943"


def test_reconciliation_push_includes_a_broker_auto_close_even_without_the_order_comment():
    """Same lesson Engine B's reconciliation already learned: a broker's own
    auto-close (TP/SL/catastrophic backstop) does not carry the original
    order's comment forward, so filtering by magic (not comment) is what
    makes this close visible at all."""
    app, client, api, _executor = _app_with_client()
    client.is_connected.return_value = True
    client.get_open_positions.return_value = []
    client.get_recent_deals.return_value = [
        _sar_deal(ticket=1, position_id=58606170943, entry="OUT", price=4272.78, comment="[tp 4272.78]"),
    ]

    app._push_sar_reconciliation()

    assert len(api.post_sar_reconcile.call_args[0][1]["deals"]) == 1


def test_reconciliation_push_excludes_a_deal_under_another_engines_magic():
    app, client, api, _executor = _app_with_client()
    client.is_connected.return_value = True
    client.get_open_positions.return_value = []
    client.get_recent_deals.return_value = [
        _sar_deal(ticket=1, position_id=111, entry="OUT", price=1.0, magic=262610210),
    ]

    app._push_sar_reconciliation()

    assert api.post_sar_reconcile.call_args[0][1]["deals"] == []


def test_a_failed_position_query_makes_the_snapshot_incomplete_not_empty():
    from app.mt5_client import PositionsUnavailable

    app, client, api, _executor = _app_with_client()
    client.is_connected.return_value = True
    client.get_open_positions.side_effect = PositionsUnavailable("positions_get failed")

    app._push_sar_reconciliation()

    payload = api.post_sar_reconcile.call_args[0][1]
    assert payload["snapshotComplete"] is False
    assert payload["positions"] == []


def test_a_failed_deal_query_makes_the_snapshot_incomplete():
    app, client, api, _executor = _app_with_client()
    client.is_connected.return_value = True
    client.get_open_positions.return_value = []
    client.get_recent_deals.side_effect = RuntimeError("history unavailable")

    app._push_sar_reconciliation()

    assert api.post_sar_reconcile.call_args[0][1]["snapshotComplete"] is False


def test_a_reconciliation_push_failure_is_logged_and_never_crashes_the_loop():
    from app.api_client import ApiClientError

    app, client, api, _executor = _app_with_client()
    client.is_connected.return_value = True
    client.get_open_positions.return_value = []
    client.get_recent_deals.return_value = []
    api.post_sar_reconcile.side_effect = ApiClientError("network down")

    app._push_sar_reconciliation()  # must not raise


def test_fast_execution_pass_pushes_reconciliation_before_polling_the_order():
    app, client, api, _executor = _app_with_client()
    client.is_connected.return_value = True
    client.get_open_positions.return_value = []
    client.get_recent_deals.return_value = []
    api.get_pending_sar_order.return_value = {"order": None}

    app._sar_fast_execution_pass()

    api.post_sar_reconcile.assert_called_once()
    api.get_pending_sar_order.assert_called_once()


# --- the SAR execution watchdog poll ---------------------------------------
#
# Defense-in-depth against the normal scheduler PROCESS itself stalling or
# crashing -- a separate container from this collector and from the API.
# This poll touches no MT5 state at all; the backend decides everything.


def test_watchdog_poll_logs_when_the_watchdog_actually_acted():
    app, _client, api, _executor = _app_with_client()
    api.get_sar_watchdog_check.return_value = {"ok": True, "action": "REVERSAL_SUBMITTED", "detail": "...", "watchdogActed": True}

    app._poll_sar_watchdog()  # must not raise

    api.get_sar_watchdog_check.assert_called_once()


def test_watchdog_poll_is_quiet_when_the_watchdog_stood_down():
    app, _client, api, _executor = _app_with_client()
    api.get_sar_watchdog_check.return_value = {"ok": True, "action": "NONE", "detail": "normal evaluator is fresh", "watchdogActed": False}

    app._poll_sar_watchdog()  # must not raise


def test_a_watchdog_poll_failure_is_logged_and_never_crashes_the_loop():
    from app.api_client import ApiClientError

    app, _client, api, _executor = _app_with_client()
    api.get_sar_watchdog_check.side_effect = ApiClientError("network down")

    app._poll_sar_watchdog()  # must not raise


# --- 2026-09-25 strategy correction: no catastrophic bracket -----------------
#
# xauusd-sar-v1 has NO broker-side SL/TP by design (the $0.50 trailing
# reversal is the entire exit mechanism). `noBracket: true` on the order
# routes it to `send_market_order_no_bracket`, never `send_bracket_order`.


def test_noBracket_order_uses_send_market_order_no_bracket_not_send_bracket_order():
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {"order": _order(noBracket=True)}
    executor.send_market_order_no_bracket.return_value = OrderResult(ok=True, ticket=900001, price=4500.5)

    app._poll_and_execute_pending_sar_order()

    executor.send_bracket_order.assert_not_called()
    executor.send_market_order_no_bracket.assert_called_once()
    kwargs = executor.send_market_order_no_bracket.call_args.kwargs
    assert kwargs["side"] == "BUY"
    assert "stop_loss_points" not in kwargs
    assert "take_profit_points" not in kwargs

    payload = api.post_sar_execution_result.call_args.args[2]
    assert payload["ok"] is True
    assert payload["ticket"] == 900001


def test_a_reversal_with_noBracket_closes_then_opens_via_the_no_bracket_path():
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {
        "order": _order(kind="REVERSAL", side="SELL", closingTicket="900001", noBracket=True),
    }
    executor.find_open_position.return_value = _live_position(900001, 0.5)
    executor.close_position.return_value = OrderResult(ok=True, ticket=900001, price=4502.5)
    executor.send_market_order_no_bracket.return_value = OrderResult(ok=True, ticket=900002, price=4502.5)

    app._poll_and_execute_pending_sar_order()

    executor.close_position.assert_called_once()
    executor.send_bracket_order.assert_not_called()
    executor.send_market_order_no_bracket.assert_called_once()
    open_kwargs = executor.send_market_order_no_bracket.call_args.kwargs
    assert open_kwargs["side"] == "SELL"


# --- 2026-09-25 daily-close FLATTEN fix ---------------------------------------
#
# A daily close must close the existing position and NEVER reopen the
# opposite side -- unlike a REVERSAL, which always closes-then-opens by
# design. Confirmed production bug: closeForDay() used to reuse kind=
# 'REVERSAL', which this collector always followed with a fresh open,
# defeating "no new exposure at close."


def test_flatten_closes_the_position_and_never_opens_a_new_one():
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {
        "order": _order(kind="FLATTEN", side="SELL", closingTicket="900001", noBracket=True),
    }
    executor.find_open_position.return_value = _live_position(900001, 0.5)
    executor.close_position.return_value = OrderResult(ok=True, ticket=900001, price=4270.0)

    app._poll_and_execute_pending_sar_order()

    executor.close_position.assert_called_once()
    close_kwargs = executor.close_position.call_args.kwargs
    assert close_kwargs["ticket"] == 900001
    assert close_kwargs["side"] == "BUY"  # closing a BUY-side existing position

    # The whole point of this fix: no open call of any kind after a FLATTEN.
    executor.send_bracket_order.assert_not_called()
    executor.send_market_order_no_bracket.assert_not_called()

    payload = api.post_sar_execution_result.call_args.args[2]
    assert payload["ok"] is True
    assert payload["uncertain"] is False


def test_flatten_reports_uncertain_when_the_close_itself_fails():
    app, api, executor = _app()
    api.get_pending_sar_order.return_value = {
        "order": _order(kind="FLATTEN", side="SELL", closingTicket="900001", noBracket=True),
    }
    executor.find_open_position.return_value = _live_position(900001, 0.5)
    executor.close_position.return_value = OrderResult(ok=False, error_message="requote")

    app._poll_and_execute_pending_sar_order()

    executor.send_bracket_order.assert_not_called()
    executor.send_market_order_no_bracket.assert_not_called()
    payload = api.post_sar_execution_result.call_args.args[2]
    assert payload["ok"] is False
    assert payload["uncertain"] is True
