"""Engine B's collector path: placing one 0.01 Telegram leg, safely.

The concerns here are different from Engine A's, and the differences are the
point:

  - the 60-second clock runs from the ORIGINAL Telegram publication, and is
    re-checked here, at the last possible moment before order_send;
  - a signal whose first target has already been reached is finished, and the
    leg must not be opened even though everything else about it is valid;
  - the SOURCE stop and the SOURCE target are sent as absolute prices, never
    re-derived from the fill and never widened;
  - several legs share one magic number, so duplicate detection is per LEG,
    by the tag carried in the order comment.

Nothing here places an order anywhere: the executor is a mock.
"""
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

from app.executor import DemoAccountRequiredError, OrderResult
from tests.test_runner_m1m5_execution import _app


def _leg(**overrides):
    leg = {
        "legId": "11111111-1111-1111-1111-111111111111",
        "signalId": "22222222-2222-2222-2222-222222222222",
        "legIndex": 1,
        "side": "SELL",
        "volume": 0.01,
        "sourceEntry": 4338.0,
        # The published levels, as absolute prices.
        "stopLoss": 4348.0,
        "takeProfit": 4329.0,
        "magic": 262610210,
        "symbol": "XAUUSD",
        "comment": "TGabc123def456-L1",
        "idempotencyTag": "TGabc123def456",
        "publishedAt": datetime.now(timezone.utc).isoformat(),
        "maxSignalAgeSeconds": 60,
        "tp1": 4329.0,
    }
    leg.update(overrides)
    return leg


def _filled():
    return OrderResult(ok=True, ticket=900001, volume_filled=0.01, price=4338.0, retcode=10009)


def _reported(api):
    return api.post_telegram_leg_result.call_args[0][2]


def _telegram_app(**overrides):
    app, client, api, executor = _app(**overrides)
    # A quote just short of TP1 at 4329: the leg is live, not spent.
    client.get_live_tick.return_value = {
        "bid": 4337.5, "ask": 4337.8, "time": datetime.now(timezone.utc).isoformat(),
    }
    app._read_position_protection = MagicMock(return_value=(4348.0, 4329.0))
    return app, client, api, executor


# --- nothing queued -----------------------------------------------------------


def test_nothing_is_attempted_when_no_leg_is_queued():
    app, _client, api, executor = _telegram_app()
    api.get_pending_telegram_leg.return_value = {"leg": None}

    app._poll_and_execute_pending_telegram_leg()

    executor.send_telegram_leg.assert_not_called()
    api.post_telegram_leg_result.assert_not_called()


# --- the source levels reach the broker unchanged ------------------------------


def test_the_published_stop_and_target_are_sent_as_absolute_prices():
    app, _client, api, executor = _telegram_app()
    api.get_pending_telegram_leg.return_value = {"leg": _leg()}
    executor.send_telegram_leg.return_value = _filled()

    app._poll_and_execute_pending_telegram_leg()

    sent = executor.send_telegram_leg.call_args.kwargs
    assert sent["stop_loss"] == 4348.0
    assert sent["take_profit"] == 4329.0
    assert sent["volume"] == 0.01
    assert sent["magic"] == 262610210
    assert sent["idempotency_tag"] == "TGabc123def456"


def test_engine_a_s_send_path_is_never_used_for_a_telegram_leg():
    """Engine A's method refuses a second position under one magic and derives
    SL/TP as distances. Either would be wrong here, so it must not be called."""
    app, _client, api, executor = _telegram_app()
    api.get_pending_telegram_leg.return_value = {"leg": _leg()}
    executor.send_telegram_leg.return_value = _filled()

    app._poll_and_execute_pending_telegram_leg()

    executor.send_bracket_order.assert_not_called()


# --- the 60-second lifetime, measured from publication -------------------------


def test_a_leg_past_its_lifetime_is_not_sent():
    app, _client, api, executor = _telegram_app()
    stale = (datetime.now(timezone.utc) - timedelta(seconds=90)).isoformat()
    api.get_pending_telegram_leg.return_value = {"leg": _leg(publishedAt=stale)}

    app._poll_and_execute_pending_telegram_leg()

    executor.send_telegram_leg.assert_not_called()
    payload = _reported(api)
    assert payload["notSent"] is True
    assert "60" in payload["errorMessage"] or "lifetime" in payload["errorMessage"]


def test_a_leg_just_inside_its_lifetime_is_sent():
    app, _client, api, executor = _telegram_app()
    fresh = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat()
    api.get_pending_telegram_leg.return_value = {"leg": _leg(publishedAt=fresh)}
    executor.send_telegram_leg.return_value = _filled()

    app._poll_and_execute_pending_telegram_leg()

    executor.send_telegram_leg.assert_called_once()


def test_a_leg_missing_its_publication_time_is_refused_rather_than_assumed_fresh():
    app, _client, api, executor = _telegram_app()
    api.get_pending_telegram_leg.return_value = {"leg": _leg(publishedAt=None)}

    app._poll_and_execute_pending_telegram_leg()

    executor.send_telegram_leg.assert_not_called()
    assert _reported(api)["notSent"] is True


# --- TP1 already reached -------------------------------------------------------


def test_a_leg_is_not_opened_once_price_has_reached_the_first_target():
    app, client, api, executor = _telegram_app()
    # A SELL is closed at the ask, and the ask has reached TP1.
    client.get_live_tick.return_value = {
        "bid": 4328.7, "ask": 4329.0, "time": datetime.now(timezone.utc).isoformat(),
    }
    api.get_pending_telegram_leg.return_value = {"leg": _leg()}

    app._poll_and_execute_pending_telegram_leg()

    executor.send_telegram_leg.assert_not_called()
    assert "first target" in _reported(api)["errorMessage"]


def test_a_sell_is_still_live_while_the_ask_is_short_of_the_target():
    app, client, api, executor = _telegram_app()
    client.get_live_tick.return_value = {
        "bid": 4328.8, "ask": 4329.1, "time": datetime.now(timezone.utc).isoformat(),
    }
    api.get_pending_telegram_leg.return_value = {"leg": _leg()}
    executor.send_telegram_leg.return_value = _filled()

    app._poll_and_execute_pending_telegram_leg()

    executor.send_telegram_leg.assert_called_once()


def test_a_buy_is_judged_on_the_bid():
    app, client, api, executor = _telegram_app()
    client.get_live_tick.return_value = {
        "bid": 4338.0, "ask": 4338.3, "time": datetime.now(timezone.utc).isoformat(),
    }
    api.get_pending_telegram_leg.return_value = {
        "leg": _leg(side="BUY", sourceEntry=4331.0, stopLoss=4321.0, takeProfit=4338.0, tp1=4338.0)
    }

    app._poll_and_execute_pending_telegram_leg()

    executor.send_telegram_leg.assert_not_called()


# --- favourable movement is not a reason to refuse -----------------------------


def test_a_market_that_has_moved_toward_the_target_is_still_traded():
    """The collector has no adverse-deviation check of its own: the backend
    made that decision with the full signal in hand. What the collector must
    NOT do is invent a symmetric drift rule that rejects a better price."""
    app, client, api, executor = _telegram_app()
    client.get_live_tick.return_value = {
        "bid": 4331.0, "ask": 4331.3, "time": datetime.now(timezone.utc).isoformat(),
    }
    api.get_pending_telegram_leg.return_value = {"leg": _leg()}
    executor.send_telegram_leg.return_value = _filled()

    app._poll_and_execute_pending_telegram_leg()

    executor.send_telegram_leg.assert_called_once()


# --- outcomes ------------------------------------------------------------------


def test_a_fill_is_reported_with_the_broker_protection_read_back():
    app, _client, api, executor = _telegram_app()
    api.get_pending_telegram_leg.return_value = {"leg": _leg()}
    executor.send_telegram_leg.return_value = _filled()

    app._poll_and_execute_pending_telegram_leg()

    payload = _reported(api)
    assert payload["ok"] is True
    assert payload["ticket"] == 900001
    assert payload["brokerStopLoss"] == 4348.0
    assert payload["brokerTakeProfit"] == 4329.0


def test_an_exception_during_the_broker_call_is_uncertain_not_failed():
    """The order may have reached the broker. Calling it a plain failure
    would release a signal group that might hold a live position."""
    app, _client, api, executor = _telegram_app()
    api.get_pending_telegram_leg.return_value = {"leg": _leg()}
    executor.send_telegram_leg.side_effect = RuntimeError("connection reset")

    app._poll_and_execute_pending_telegram_leg()

    payload = _reported(api)
    assert payload["uncertain"] is True
    assert payload.get("notSent") is not True


def test_an_answerless_broker_response_is_uncertain():
    app, _client, api, executor = _telegram_app()
    api.get_pending_telegram_leg.return_value = {"leg": _leg()}
    executor.send_telegram_leg.return_value = OrderResult(
        ok=False, outcome="UNKNOWN", error_message="response lost"
    )

    app._poll_and_execute_pending_telegram_leg()

    assert _reported(api)["uncertain"] is True


def test_a_demo_check_failure_is_not_sent_rather_than_uncertain():
    """The executor's DEMO check runs BEFORE order_send, so nothing was
    opened and the leg can be closed out safely."""
    app, _client, api, executor = _telegram_app()
    api.get_pending_telegram_leg.return_value = {"leg": _leg()}
    executor.send_telegram_leg.side_effect = DemoAccountRequiredError("account is REAL")

    app._poll_and_execute_pending_telegram_leg()

    payload = _reported(api)
    assert payload["notSent"] is True
    assert payload["uncertain"] is False


def test_a_leg_with_no_volume_is_refused_rather_than_defaulted():
    app, _client, api, executor = _telegram_app()
    api.get_pending_telegram_leg.return_value = {"leg": _leg(volume=None)}

    app._poll_and_execute_pending_telegram_leg()

    executor.send_telegram_leg.assert_not_called()
    assert _reported(api)["notSent"] is True


def test_no_live_quote_means_no_order():
    app, client, api, executor = _telegram_app()
    client.get_live_tick.return_value = None
    api.get_pending_telegram_leg.return_value = {"leg": _leg()}

    app._poll_and_execute_pending_telegram_leg()

    executor.send_telegram_leg.assert_not_called()


# --- reconciliation ------------------------------------------------------------


def test_reconciliation_reports_an_incomplete_snapshot_as_incomplete():
    """An account that could not be enumerated and an account with no
    positions look identical in the payload. Only this flag tells them
    apart, so a failed query must never send snapshotComplete: true."""
    from app.mt5_client import PositionsUnavailable

    app, client, api, _executor = _telegram_app()
    client.get_open_positions.side_effect = PositionsUnavailable("terminal disconnected")

    app._push_telegram_reconciliation()

    payload = api.post_telegram_reconcile.call_args[0][1]
    assert payload["snapshotComplete"] is False
    assert payload["positions"] == []


def test_reconciliation_sends_only_telegram_positions():
    app, client, api, _executor = _telegram_app()
    client.get_open_positions.return_value = [
        {"ticket": 1, "symbol": "XAUUSD", "volume": 0.01, "price_open": 4338.0, "sl": 4348.0,
         "tp": 4329.0, "profit": 1.0, "comment": "TGabc123def456-L1", "raw": {"magic": 262610210}},
        {"ticket": 2, "symbol": "XAUUSD", "volume": 0.5, "price_open": 4360.0, "sl": 4365.0,
         "tp": 4355.0, "profit": 2.0, "comment": "m1m5-m1-dec1", "raw": {"magic": 262610200}},
        {"ticket": 3, "symbol": "XAUUSD", "volume": 0.1, "price_open": 4300.0, "sl": 0.0,
         "tp": 0.0, "profit": 0.0, "comment": "", "raw": {}},
    ]
    client.get_recent_deals.return_value = []

    app._push_telegram_reconciliation()

    payload = api.post_telegram_reconcile.call_args[0][1]
    assert [p["ticket"] for p in payload["positions"]] == ["1"]
    assert payload["snapshotComplete"] is True


def test_an_absent_broker_stop_is_reported_as_null_not_as_zero():
    """MT5 reports "no stop loss" as 0.0. Passing the zero through would make
    an UNPROTECTED position look like one with a stop at zero."""
    app, client, api, _executor = _telegram_app()
    client.get_open_positions.return_value = [
        {"ticket": 1, "symbol": "XAUUSD", "volume": 0.01, "price_open": 4338.0, "sl": 0.0,
         "tp": 0.0, "profit": 1.0, "comment": "TGabc123def456-L1", "raw": {"magic": 262610210}},
    ]
    client.get_recent_deals.return_value = []

    app._push_telegram_reconciliation()

    position = api.post_telegram_reconcile.call_args[0][1]["positions"][0]
    assert position["stopLoss"] is None
    assert position["takeProfit"] is None


def test_a_failed_deal_query_makes_the_snapshot_incomplete():
    """Deals are how a realised result is established. Without them the
    snapshot cannot support a closure conclusion."""
    app, client, api, _executor = _telegram_app()
    client.get_open_positions.return_value = []
    client.get_recent_deals.side_effect = RuntimeError("history unavailable")

    app._push_telegram_reconciliation()

    assert api.post_telegram_reconcile.call_args[0][1]["snapshotComplete"] is False
