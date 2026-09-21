"""Autonomous demo trading (v2), Phase 6 — the only test file exercising
order-placement code in this project, matching the same monkeypatch-the-mt5-
module convention test_mt5_client.py already uses for read-only calls.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace


def broker_epoch_now(offset_seconds: float = 0.0) -> int:
    """A broker wall-clock epoch for `now + offset_seconds`.

    Built with the project's own inverse conversion rather than by adding a
    hardcoded three hours, so the tests stay correct across the EET/EEST
    changeover and can never encode a guessed offset.
    """
    from app.mt5_client import _utc_to_mt5_epoch

    when = datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)
    return _utc_to_mt5_epoch(when, os.environ.get("MT5_BROKER_TIMEZONE", "").strip() or "EET")

import pytest

from app.executor import QUOTE_MAX_AGE_SECONDS, DemoAccountRequiredError, Executor, ReconciliationQueryFailed


ACCOUNT_TRADE_MODE_REAL = 0
ACCOUNT_TRADE_MODE_DEMO = 1
ACCOUNT_TRADE_MODE_CONTEST = 2
ORDER_TYPE_BUY = 0
ORDER_TYPE_SELL = 1
TRADE_ACTION_DEAL = 1
ORDER_TIME_GTC = 0
ORDER_FILLING_IOC = 2
TRADE_RETCODE_DONE = 10009
TRADE_RETCODE_REQUOTE = 10004


class FakeMt5:
    """A minimal stand-in for the MetaTrader5 module — just the constants
    and functions executor.py actually calls, with test-controllable
    return values recorded for assertions."""

    def __init__(self, *, trade_mode=ACCOUNT_TRADE_MODE_DEMO, tick_bid=1.0995, tick_ask=1.09952):
        self.ACCOUNT_TRADE_MODE_REAL = ACCOUNT_TRADE_MODE_REAL
        self.ACCOUNT_TRADE_MODE_DEMO = ACCOUNT_TRADE_MODE_DEMO
        self.ACCOUNT_TRADE_MODE_CONTEST = ACCOUNT_TRADE_MODE_CONTEST
        self.ORDER_TYPE_BUY = ORDER_TYPE_BUY
        self.ORDER_TYPE_SELL = ORDER_TYPE_SELL
        self.TRADE_ACTION_DEAL = TRADE_ACTION_DEAL
        self.ORDER_TIME_GTC = ORDER_TIME_GTC
        self.ORDER_FILLING_IOC = ORDER_FILLING_IOC
        self.TRADE_RETCODE_DONE = TRADE_RETCODE_DONE

        self._trade_mode = trade_mode
        self._tick_bid = tick_bid
        self._tick_ask = tick_ask
        self.order_send_calls: list[dict] = []
        self._order_send_results: list[SimpleNamespace | None] = []
        self._open_positions: list[SimpleNamespace] = []
        self.positions_get_calls: list[dict] = []
        self._positions_get_should_fail = False
        self._tick_time = None

    def last_error(self):
        return (1, "no error") if not self._positions_get_should_fail else (10021, "no connection to trade server")

    def make_positions_get_fail(self) -> None:
        """Test control: simulate positions_get() itself failing (returns
        None with a real error code) — distinct from a confirmed-empty
        result. Audit finding: these two must never be treated the same."""
        self._positions_get_should_fail = True

    def account_info(self):
        if self._trade_mode is None:
            return None
        return SimpleNamespace(trade_mode=self._trade_mode)

    def symbol_info_tick(self, symbol):
        # `time` is a BROKER wall-clock epoch, which is what MT5 actually
        # reports and what the executor's quote-age gate converts. Default:
        # right now, so the ordinary tests exercise a fresh quote.
        return SimpleNamespace(
            bid=self._tick_bid,
            ask=self._tick_ask,
            time=self._tick_time if self._tick_time is not None else broker_epoch_now(),
        )

    def set_tick_age_seconds(self, age_seconds: float) -> None:
        """Test control: make symbol_info_tick report a quote of a given age."""
        self._tick_time = broker_epoch_now(-age_seconds)

    def set_tick_time_raw(self, epoch_seconds) -> None:
        """Test control: an arbitrary raw `time`, for malformed-input cases."""
        self._tick_time = epoch_seconds

    def queue_order_send_result(self, result: SimpleNamespace | None) -> None:
        self._order_send_results.append(result)

    def order_send(self, request: dict):
        self.order_send_calls.append(request)
        if self._order_send_results:
            return self._order_send_results.pop(0)
        return SimpleNamespace(retcode=TRADE_RETCODE_DONE, order=1, volume=request["volume"], price=request["price"])

    def set_open_positions(self, positions: list[SimpleNamespace]) -> None:
        """Test control: pretend these positions are currently open on the account."""
        self._open_positions = positions

    def positions_get(self, symbol=None, ticket=None):
        self.positions_get_calls.append({"symbol": symbol, "ticket": ticket})
        if self._positions_get_should_fail:
            return None
        if ticket is not None:
            return [p for p in self._open_positions if getattr(p, "ticket", None) == ticket]
        return list(self._open_positions)


def open_position(ticket=555, magic=1, volume=0.01, price_open=1.1, sl=1.098):
    return SimpleNamespace(ticket=ticket, magic=magic, volume=volume, price_open=price_open, sl=sl)


def done_result(**overrides):
    base = dict(retcode=TRADE_RETCODE_DONE, order=42, volume=0.01, price=1.1)
    base.update(overrides)
    return SimpleNamespace(**base)


def failed_result(retcode=TRADE_RETCODE_REQUOTE, comment="Requote"):
    return SimpleNamespace(retcode=retcode, comment=comment, order=None, volume=None, price=None)


class TestVerifyDemoAccount:
    def test_passes_silently_on_a_demo_account(self):
        Executor(FakeMt5(trade_mode=ACCOUNT_TRADE_MODE_DEMO)).verify_demo_account()

    def test_raises_on_a_real_account(self):
        with pytest.raises(DemoAccountRequiredError, match="not ACCOUNT_TRADE_MODE_DEMO"):
            Executor(FakeMt5(trade_mode=ACCOUNT_TRADE_MODE_REAL)).verify_demo_account()

    def test_raises_on_a_contest_account(self):
        with pytest.raises(DemoAccountRequiredError):
            Executor(FakeMt5(trade_mode=ACCOUNT_TRADE_MODE_CONTEST)).verify_demo_account()

    def test_raises_when_account_info_is_unavailable(self):
        with pytest.raises(DemoAccountRequiredError, match="returned None"):
            Executor(FakeMt5(trade_mode=None)).verify_demo_account()


class TestSendBracketOrder:
    def test_refuses_on_a_non_demo_account_before_sending_anything(self):
        fake = FakeMt5(trade_mode=ACCOUNT_TRADE_MODE_REAL)
        with pytest.raises(DemoAccountRequiredError):
            Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=1, comment="x")
        assert fake.order_send_calls == []

    def test_rejects_an_invalid_side(self):
        with pytest.raises(ValueError, match="side"):
            Executor(FakeMt5()).send_bracket_order(side="LONG", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=1, comment="x")

    def test_rejects_a_missing_stop_loss(self):
        with pytest.raises(ValueError, match="stop_loss_points"):
            Executor(FakeMt5()).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=None, take_profit_points=180, magic=1, comment="x")

    def test_places_a_correctly_shaped_buy_order_on_first_try(self):
        fake = FakeMt5(tick_bid=1.0995, tick_ask=1.09952)
        result = Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=777, comment="autonomous")

        assert result.ok is True
        assert result.ticket == 1
        assert len(fake.order_send_calls) == 1
        sent = fake.order_send_calls[0]
        assert sent["symbol"] == "EURUSD"
        assert sent["type"] == ORDER_TYPE_BUY
        assert sent["price"] == 1.09952  # buys at ask
        assert sent["sl"] == pytest.approx(1.09952 - 0.0018)  # exactly 180 points below entry
        assert sent["tp"] == pytest.approx(1.09952 + 0.0018)  # exactly 180 points above entry
        assert sent["magic"] == 777
        assert sent["volume"] == 0.01

    def test_places_a_sell_at_bid_with_sl_above_and_tp_below(self):
        fake = FakeMt5(tick_bid=1.0995, tick_ask=1.09952)
        Executor(fake).send_bracket_order(side="SELL", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=1, comment="x")
        sent = fake.order_send_calls[0]
        assert sent["price"] == 1.0995  # sells at bid
        assert sent["type"] == ORDER_TYPE_SELL
        assert sent["sl"] == pytest.approx(1.0995 + 0.0018)
        assert sent["tp"] == pytest.approx(1.0995 - 0.0018)

    def test_respects_a_different_configured_point_distance(self):
        fake = FakeMt5(tick_bid=1.0995, tick_ask=1.1000)
        Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=100, take_profit_points=250, magic=1, comment="x")
        sent = fake.order_send_calls[0]
        assert sent["sl"] == pytest.approx(1.1000 - 0.001)
        assert sent["tp"] == pytest.approx(1.1000 + 0.0025)

    def test_returns_ok_false_when_no_live_tick_is_available(self):
        fake = FakeMt5()
        fake.symbol_info_tick = lambda symbol: None
        result = Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=1, comment="x")
        assert result.ok is False
        assert "tick" in result.error_message

    def test_retries_once_with_a_fresh_quote_after_a_requote_then_succeeds(self):
        fake = FakeMt5(tick_ask=1.1000)
        fake.queue_order_send_result(failed_result())  # first attempt fails
        # Second call to symbol_info_tick (inside the retry) should see a moved price.
        original_tick = fake.symbol_info_tick
        calls = {"n": 0}

        def moving_tick(symbol):
            calls["n"] += 1
            # The retry's quote is fresh in its own right: the gate re-reads the
            # clock on every attempt, not just the first.
            return SimpleNamespace(bid=1.0995, ask=1.1005, time=broker_epoch_now()) if calls["n"] > 1 else original_tick(symbol)

        fake.symbol_info_tick = moving_tick

        result = Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=1, comment="x")

        assert result.ok is True
        assert len(fake.order_send_calls) == 2
        assert fake.order_send_calls[0]["price"] == 1.1000  # original quote
        assert fake.order_send_calls[1]["price"] == 1.1005  # refreshed quote on retry
        # The retry's SL/TP are recomputed from the REFRESHED price, not frozen from the first attempt.
        assert fake.order_send_calls[1]["sl"] == pytest.approx(1.1005 - 0.0018)
        assert fake.order_send_calls[1]["tp"] == pytest.approx(1.1005 + 0.0018)

    def test_aborts_after_the_retry_also_fails_without_retrying_further(self):
        fake = FakeMt5()
        fake.queue_order_send_result(failed_result(comment="Requote"))
        fake.queue_order_send_result(failed_result(comment="Requote again"))

        result = Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=1, comment="x")

        assert result.ok is False
        assert result.error_message == "Requote again"
        assert len(fake.order_send_calls) == 2  # exactly one retry, never more

    def test_treats_a_none_response_from_order_send_as_a_failure_worth_retrying_when_no_position_actually_opened(self):
        fake = FakeMt5()
        fake.queue_order_send_result(None)  # ambiguous — reconciliation check finds nothing open
        result = Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=1, comment="x")
        assert result.ok is True  # second (default, un-queued) call succeeds
        assert len(fake.order_send_calls) == 2


class TestDuplicatePreventionAndReconciliation:
    """Audit finding: order_send's `None` response is ambiguous — it means
    the acknowledgment was lost, not that the order failed. Blindly
    retrying risks opening a second live position when the first attempt
    actually filled. These tests cover the reconciliation-by-magic-number
    fix (executor.py's `find_open_position`)."""

    def test_refuses_to_open_a_second_position_when_one_already_exists_under_this_magic(self):
        fake = FakeMt5()
        fake.set_open_positions([open_position(ticket=555, magic=777)])
        result = Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=777, comment="x")

        assert result.ok is False
        assert "555" in result.error_message
        assert fake.order_send_calls == []  # never even attempted — pure pre-flight check

    def test_an_open_position_under_a_DIFFERENT_magic_does_not_block_a_new_order(self):
        fake = FakeMt5()
        fake.set_open_positions([open_position(ticket=555, magic=999)])  # some other EA / manual trade
        result = Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=777, comment="x")

        assert result.ok is True
        assert len(fake.order_send_calls) == 1

    def test_reconciles_a_lost_acknowledgment_as_filled_instead_of_retrying(self):
        fake = FakeMt5()
        fake.queue_order_send_result(None)  # ambiguous: broker may have filled it anyway

        # Call 1 is the pre-flight dedup check (nothing open yet — the
        # default empty list). Call 2 is the post-ambiguous-response
        # reconciliation, which is where the fill should actually be found.
        real_positions_get = fake.positions_get

        def positions_get_stub(symbol=None, ticket=None):
            if len(fake.positions_get_calls) == 1:  # about to become the 2nd call
                fake.set_open_positions([open_position(ticket=888, magic=42, volume=0.01, price_open=1.1005)])
            return real_positions_get(symbol, ticket)

        fake.positions_get = positions_get_stub

        result = Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=42, comment="x")

        assert result.ok is True
        assert result.ticket == 888
        assert result.price == 1.1005
        assert len(fake.order_send_calls) == 1  # NEVER retried — reconciliation found the real fill first
        assert len(fake.positions_get_calls) == 3  # pre-flight + post-ambiguous-response reconciliation + post-fill stop verification

    def test_still_retries_when_the_lost_acknowledgment_reconciles_to_no_position(self):
        fake = FakeMt5()
        fake.queue_order_send_result(None)  # ambiguous, but genuinely never filled
        result = Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=42, comment="x")

        assert result.ok is True  # the retry (default queued result) succeeds
        assert len(fake.order_send_calls) == 2

    def test_a_definite_rejection_retcode_retries_without_an_extra_reconciliation_check(self):
        fake = FakeMt5()
        fake.queue_order_send_result(failed_result())  # a real retcode, not None — unambiguous
        Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=42, comment="x")

        # Exactly two positions_get calls: the pre-flight dedup check, and
        # the post-fill protective-stop verification once the retry
        # succeeds — NOT a third for reconciliation, since a definite
        # rejection retcode carries no ambiguity to reconcile.
        assert len(fake.positions_get_calls) == 2

    def test_reconciles_a_lost_acknowledgment_on_the_retry_itself_too(self):
        fake = FakeMt5()
        fake.queue_order_send_result(None)  # first attempt: ambiguous, reconciles to nothing open
        fake.queue_order_send_result(None)  # retry: ALSO ambiguous

        real_positions_get = fake.positions_get

        def positions_get_stub(symbol=None, ticket=None):
            # Calls: 1=pre-flight (empty), 2=post-1st-ambiguous-response
            # (still empty), 3=post-retry's-ambiguous-response (finds it).
            if len(fake.positions_get_calls) == 2:
                fake.set_open_positions([open_position(ticket=901, magic=42)])
            return real_positions_get(symbol, ticket)

        fake.positions_get = positions_get_stub

        result = Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=42, comment="x")

        assert result.ok is True
        assert result.ticket == 901
        assert len(fake.order_send_calls) == 2  # first attempt + one retry, never a third send


class TestFindOpenPosition:
    def test_returns_none_when_no_positions_are_open(self):
        assert Executor(FakeMt5()).find_open_position(magic=1) is None

    def test_returns_none_when_positions_exist_under_other_magic_numbers(self):
        fake = FakeMt5()
        fake.set_open_positions([open_position(magic=1), open_position(magic=2)])
        assert Executor(fake).find_open_position(magic=999) is None

    def test_finds_the_matching_position_by_magic(self):
        fake = FakeMt5()
        target = open_position(ticket=42, magic=777)
        fake.set_open_positions([open_position(magic=1), target])
        assert Executor(fake).find_open_position(magic=777) is target

    def test_raises_ReconciliationQueryFailed_when_positions_get_itself_fails(self):
        """Audit finding: positions_get() returning None means the query
        FAILED — it does not mean zero positions (an empty tuple would mean
        that). Treating them the same is exactly the "inferred safe to
        retry from an empty query" mistake this project was asked not to
        make."""
        fake = FakeMt5()
        fake.make_positions_get_fail()
        with pytest.raises(ReconciliationQueryFailed, match="positions_get"):
            Executor(fake).find_open_position(magic=1)


class TestUnknownOutcomeOnReconciliationFailure:
    """Audit finding: when reconciliation itself cannot be completed (the
    query fails, not just comes back empty), this module must report an
    explicit UNKNOWN outcome and refuse to guess — never silently proceed
    as if "no duplicate" or "safe to retry" were confirmed."""

    def test_send_bracket_order_reports_UNKNOWN_when_the_preflight_duplicate_check_itself_fails(self):
        fake = FakeMt5()
        fake.make_positions_get_fail()
        result = Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=1, comment="x")

        assert result.outcome == "UNKNOWN"
        assert result.ok is False
        assert fake.order_send_calls == []  # never sent — refusing to guess, not refusing to open

    def test_reports_UNKNOWN_when_reconciliation_after_a_lost_acknowledgment_itself_fails(self):
        fake = FakeMt5()
        fake.queue_order_send_result(None)  # ambiguous first response
        # Reconciliation's OWN query then fails too (e.g. connection dropped
        # right after the ambiguous send) — must not be read as "confirmed
        # empty, safe to retry."

        real_positions_get = fake.positions_get

        def positions_get_fails_after_preflight(symbol=None, ticket=None):
            if len(fake.positions_get_calls) >= 1:  # preflight already succeeded once; fail from here on
                fake.make_positions_get_fail()
            return real_positions_get(symbol, ticket)

        fake.positions_get = positions_get_fails_after_preflight

        result = Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=1, comment="x")

        assert result.outcome == "UNKNOWN"
        assert result.ok is False
        assert len(fake.order_send_calls) == 1  # never retried past the unresolved ambiguity


class TestDealHistoryReconciliation:
    """Audit finding: a position that FILLED and was ALSO already closed
    (e.g. an immediate stop-out) before reconciliation runs is invisible to
    positions_get() alone — it must also be checked against recent deal
    history via `set_deals_lookup`."""

    def test_find_recent_deal_returns_none_and_warns_when_no_lookup_is_wired_up(self, caplog):
        executor = Executor(FakeMt5())
        assert executor.find_recent_deal(magic=1) is None
        assert "no deals_lookup wired up" in caplog.text

    def test_find_recent_deal_finds_a_matching_closed_deal(self):
        executor = Executor(FakeMt5())
        executor.set_deals_lookup(lambda since: [
            {"symbol": "GBPUSD", "magic": 1, "ticket": 1},  # wrong symbol
            {"symbol": "EURUSD", "magic": 2, "ticket": 2},  # wrong magic
            {"symbol": "EURUSD", "magic": 1, "ticket": 3, "volume": 0.01, "price": 1.105},
        ])
        found = executor.find_recent_deal(magic=1)
        assert found is not None
        assert found["ticket"] == 3

    def test_reconciles_a_lost_acknowledgment_against_deal_history_when_no_open_position_exists(self):
        """The core "filled position already closed before reconciliation"
        scenario: order_send is ambiguous, positions_get() correctly comes
        back empty (the position already closed), but deal history shows it
        really did fill — must be reported as FILLED, never retried."""
        fake = FakeMt5()
        fake.queue_order_send_result(None)
        executor = Executor(fake)
        executor.set_deals_lookup(lambda since: [{"symbol": "EURUSD", "magic": 42, "ticket": 909, "volume": 0.01, "price": 1.11}])

        result = executor.send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=42, comment="x")

        assert result.outcome == "FILLED"
        assert result.ticket == 909
        assert len(fake.order_send_calls) == 1  # never retried — deal history already confirmed the fill


class TestConcurrentExecutionCalls:
    """Audit finding: nothing previously prevented two overlapping calls to
    send_bracket_order from interleaving their order_send requests against
    the same MT5 session. `Executor._lock` serializes them."""

    def test_two_concurrent_calls_never_interleave_their_order_send_requests(self):
        import threading
        import time

        fake = FakeMt5()
        real_order_send = fake.order_send
        in_flight = {"count": 0, "max_concurrent": 0}

        def slow_order_send(request):
            in_flight["count"] += 1
            in_flight["max_concurrent"] = max(in_flight["max_concurrent"], in_flight["count"])
            time.sleep(0.05)  # hold the "critical section" open long enough to overlap if unlocked
            result = real_order_send(request)
            # Simulate the broker-side effect of a successful send: a
            # position now genuinely exists, so a SECOND (serialized, later)
            # call sees it via positions_get() — otherwise this fake never
            # links "order_send succeeded" to "a position is now open" and
            # the duplicate-prevention check has nothing to find.
            fake.set_open_positions([open_position(magic=request["magic"], ticket=result.order, price_open=result.price)])
            in_flight["count"] -= 1
            return result

        fake.order_send = slow_order_send
        executor = Executor(fake)

        threads = [
            threading.Thread(target=lambda: executor.send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=1, comment="x")),
            threading.Thread(target=lambda: executor.send_bracket_order(side="SELL", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=1, comment="y")),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert in_flight["max_concurrent"] == 1  # the lock ensured only one was ever mid-flight
        # Exactly one of the two must have been refused by the OTHER's
        # now-open position (magic=1 is shared here on purpose) — this also
        # incidentally proves the duplicate-prevention check itself is safe
        # under real concurrency, not just in a single-threaded test.
        assert len(fake.order_send_calls) == 1


class TestProtectiveStopVerification:
    """Audit finding (§5 — post-execution verification of protective
    stops): a FILLED result only means the broker accepted a request that
    ASKED for an SL, not that the SL is actually attached. Deciding what to
    DO about a confirmed-missing stop is a policy choice left to the
    caller — this module only ever reports what it found."""

    def _fake_with_post_fill_position(self, *, sl: float) -> "FakeMt5":
        """A position must appear only AFTER order_send is called — if it
        were registered up front, the pre-flight duplicate check would
        refuse to send at all (correctly, but not what these tests probe)."""
        fake = FakeMt5()
        real_order_send = fake.order_send

        def order_send_then_register(request):
            result = real_order_send(request)
            fake.set_open_positions([open_position(ticket=result.order, magic=request["magic"], sl=sl)])
            return result

        fake.order_send = order_send_then_register
        return fake

    def test_confirms_the_stop_when_the_broker_kept_it(self):
        fake = self._fake_with_post_fill_position(sl=1.098)
        result = Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=1, comment="x")
        assert result.outcome == "FILLED"
        assert result.sl_confirmed is True

    def test_reports_a_confirmed_MISSING_stop_rather_than_silently_passing(self):
        fake = self._fake_with_post_fill_position(sl=0)  # broker stripped/rejected the SL
        result = Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=1, comment="x")
        assert result.outcome == "FILLED"  # the ORDER still filled — outcome is unaffected
        assert result.sl_confirmed is False  # but the stop is confirmed absent

    def test_leaves_sl_confirmed_unknown_rather_than_false_when_verification_cannot_find_the_position(self):
        fake = FakeMt5()  # nothing registered — verification query finds nothing
        result = Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=1, comment="x")
        assert result.outcome == "FILLED"
        assert result.sl_confirmed is None  # NOT False — "couldn't check" must never look like "confirmed missing"

    def test_does_not_attempt_verification_on_a_non_filled_result(self):
        fake = FakeMt5()
        fake.symbol_info_tick = lambda symbol: None  # no live tick — fails before ever getting a ticket
        result = Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=1, comment="x")
        assert result.outcome == "FAILED"
        assert result.ticket is None
        assert result.sl_confirmed is None


class TestClosePosition:
    def test_closing_a_buy_sells_at_bid(self):
        fake = FakeMt5(tick_bid=1.0995, tick_ask=1.09952)
        result = Executor(fake).close_position(ticket=99, side="BUY", volume=0.01)
        assert result.ok is True
        sent = fake.order_send_calls[0]
        assert sent["type"] == ORDER_TYPE_SELL
        assert sent["price"] == 1.0995
        assert sent["position"] == 99

    def test_closing_a_sell_buys_at_ask(self):
        fake = FakeMt5(tick_bid=1.0995, tick_ask=1.09952)
        Executor(fake).close_position(ticket=100, side="SELL", volume=0.01)
        sent = fake.order_send_calls[0]
        assert sent["type"] == ORDER_TYPE_BUY
        assert sent["price"] == 1.09952

    def test_refuses_to_close_on_a_non_demo_account(self):
        fake = FakeMt5(trade_mode=ACCOUNT_TRADE_MODE_REAL)
        with pytest.raises(DemoAccountRequiredError):
            Executor(fake).close_position(ticket=1, side="BUY", volume=0.01)
        assert fake.order_send_calls == []

    def test_does_not_retry_a_failed_close(self):
        fake = FakeMt5()
        fake.queue_order_send_result(failed_result())
        result = Executor(fake).close_position(ticket=1, side="BUY", volume=0.01)
        assert result.ok is False
        assert len(fake.order_send_calls) == 1

    def test_uses_the_given_symbol_instead_of_the_eurusd_default(self):
        fake = FakeMt5()
        Executor(fake).close_position(ticket=1, side="BUY", volume=0.01, symbol="XAUUSD")
        assert fake.order_send_calls[0]["symbol"] == "XAUUSD"


class TestMultiSymbolSupport:
    """trend-breakout strategy (v3) — gold (XAUUSD) has a materially
    different point size than EURUSD; every method that used to hardcode
    EURUSD's symbol/point size must be explicitly told a different
    instrument's values, never silently reuse EURUSD's."""

    def test_send_bracket_order_defaults_to_eurusd_symbol_and_point_size(self):
        fake = FakeMt5(tick_bid=1.0995, tick_ask=1.09952)
        Executor(fake).send_bracket_order(side="BUY", volume=0.01, stop_loss_points=180, take_profit_points=180, magic=1, comment="x")
        sent = fake.order_send_calls[0]
        assert sent["symbol"] == "EURUSD"
        # 180 points x EURUSD's 0.00001 point size = 0.0018
        assert sent["sl"] == pytest.approx(1.09952 - 0.0018)
        assert sent["tp"] == pytest.approx(1.09952 + 0.0018)

    def test_send_bracket_order_uses_golds_own_symbol_and_point_size(self):
        fake = FakeMt5(tick_bid=2650.00, tick_ask=2650.05)
        Executor(fake).send_bracket_order(
            side="BUY", volume=0.01, stop_loss_points=150, take_profit_points=300,
            magic=2, comment="gold", symbol="XAUUSD", point_size=0.01,
        )
        sent = fake.order_send_calls[0]
        assert sent["symbol"] == "XAUUSD"
        # 150 points x gold's 0.01 point size = 1.5 — NOT 0.0015 (EURUSD's own point size would silently corrupt this).
        assert sent["sl"] == pytest.approx(2650.05 - 1.5)
        assert sent["tp"] == pytest.approx(2650.05 + 3.0)

    def test_duplicate_prevention_checks_the_given_symbol_only(self):
        # An existing EURUSD position under this magic number must NOT block a gold order under the same magic — they're different instruments.
        fake = FakeMt5()
        fake.set_open_positions([open_position(magic=2)])
        Executor(fake).send_bracket_order(
            side="BUY", volume=0.01, stop_loss_points=150, take_profit_points=300,
            magic=2, comment="gold", symbol="XAUUSD", point_size=0.01,
        )
        # positions_get was queried with symbol="XAUUSD" — FakeMt5 doesn't
        # itself filter by symbol, but this asserts the CALL was scoped
        # correctly, which is what a real MT5 terminal would filter on.
        assert any(c["symbol"] == "XAUUSD" for c in fake.positions_get_calls)


class TestFindAnyPosition:
    """§3 — "account-wide positions... including manual or other-strategy
    activity, must block an additional strategy entry." Unlike
    find_open_position, this must find a position regardless of its magic
    number."""

    def test_finds_a_position_regardless_of_magic_number(self):
        fake = FakeMt5()
        fake.set_open_positions([open_position(magic=999)])  # some OTHER system's/manual position
        result = Executor(fake).find_any_position("EURUSD")
        assert result is not None
        assert result.magic == 999

    def test_returns_none_when_genuinely_no_position_exists(self):
        fake = FakeMt5()
        assert Executor(fake).find_any_position("EURUSD") is None

    def test_raises_on_a_genuine_query_failure_rather_than_inferring_none(self):
        fake = FakeMt5()
        fake._positions_get_should_fail = True
        with pytest.raises(ReconciliationQueryFailed):
            Executor(fake).find_any_position("EURUSD")

    def test_queries_with_the_given_symbol(self):
        fake = FakeMt5()
        Executor(fake).find_any_position("XAUUSD")
        assert fake.positions_get_calls[-1]["symbol"] == "XAUUSD"


class TestQuoteFreshnessAtTheSendBoundary:
    """The last gate before `order_send`.

    A one-second polling loop guarantees a one-second READ, not a
    one-second-old market price: `symbol_info_tick` returns the last tick
    the terminal ever saw, so a frozen or halted feed yields a brand-new
    read of a very old quote. Nothing upstream can close this gap, because
    the backend approves against the quote it was last PUSHED and the order
    then travels here, where MT5 is read directly.
    """

    def test_a_fresh_quote_is_accepted_and_priced_off_that_quote(self):
        fake = FakeMt5(tick_bid=4374.77, tick_ask=4375.28)
        fake.set_tick_age_seconds(1.0)

        result = Executor(fake).send_bracket_order(
            side="BUY", volume=0.5, stop_loss_points=500, take_profit_points=500,
            magic=262610190, comment="x", symbol="XAUUSD", point_size=0.01,
        )

        assert result.ok is True
        assert len(fake.order_send_calls) == 1
        assert fake.order_send_calls[0]["price"] == 4375.28

    def test_a_quote_older_than_the_limit_is_rejected_before_order_send(self):
        fake = FakeMt5(tick_bid=4374.77, tick_ask=4375.28)
        fake.set_tick_age_seconds(QUOTE_MAX_AGE_SECONDS + 5)

        result = Executor(fake).send_bracket_order(
            side="BUY", volume=0.5, stop_loss_points=500, take_profit_points=500,
            magic=262610190, comment="x", symbol="XAUUSD", point_size=0.01,
        )

        assert result.ok is False
        assert result.outcome == "FAILED"
        # Nothing reached the broker at all: this is a refusal, not a rejection.
        assert fake.order_send_calls == []
        assert "old at the send boundary" in result.error_message
        assert "not repriced" in result.error_message

    def test_a_quote_just_inside_the_limit_is_still_accepted(self):
        # The limit must not be silently tightened either.
        fake = FakeMt5(tick_bid=4374.77, tick_ask=4375.28)
        fake.set_tick_age_seconds(QUOTE_MAX_AGE_SECONDS - 1)

        result = Executor(fake).send_bracket_order(
            side="SELL", volume=0.5, stop_loss_points=500, take_profit_points=500,
            magic=262610191, comment="x", symbol="XAUUSD", point_size=0.01,
        )

        assert result.ok is True

    def test_re_reading_the_same_old_tick_does_not_make_it_fresh(self):
        """Repeated reads of one unchanged tick must keep ageing.

        The age comes from the tick's OWN timestamp, never from when it was
        read, so a frozen feed gets staler on every attempt instead of being
        renewed by the act of looking at it.
        """
        fake = FakeMt5(tick_bid=4374.77, tick_ask=4375.28)
        fake.set_tick_time_raw(broker_epoch_now(-(QUOTE_MAX_AGE_SECONDS + 60)))

        executor = Executor(fake)
        ages = []
        for _ in range(3):
            age, problem = executor._quote_age_seconds(fake.symbol_info_tick("XAUUSD"))
            assert problem is None
            ages.append(age)
            result = executor.send_bracket_order(
                side="BUY", volume=0.5, stop_loss_points=500, take_profit_points=500,
                magic=262610190, comment="x", symbol="XAUUSD", point_size=0.01,
            )
            assert result.ok is False

        # Same tick, same original timestamp: it only ever gets older.
        assert ages[0] >= QUOTE_MAX_AGE_SECONDS
        assert ages[1] >= ages[0]
        assert ages[2] >= ages[1]
        assert fake.order_send_calls == []

    def test_a_quote_that_expires_after_an_earlier_approval_is_rejected_at_submission(self):
        """Approved while fresh, expired by the time it is sent.

        This is the ordering the gate exists for: the decision was allowed
        through upstream against a quote that was fine at the time, and the
        send boundary is the only place left that can notice it no longer is.
        """
        fake = FakeMt5(tick_bid=4374.77, tick_ask=4375.28)
        executor = Executor(fake)

        # Approval moment: the quote is fresh and would have been accepted.
        fake.set_tick_age_seconds(2.0)
        age_at_approval, problem = executor._quote_age_seconds(fake.symbol_info_tick("XAUUSD"))
        assert problem is None and age_at_approval <= QUOTE_MAX_AGE_SECONDS

        # Time passes and the feed stops updating; the SAME quote is now expired.
        fake.set_tick_age_seconds(QUOTE_MAX_AGE_SECONDS + 2)
        result = executor.send_bracket_order(
            side="BUY", volume=0.5, stop_loss_points=500, take_profit_points=500,
            magic=262610190, comment="x", symbol="XAUUSD", point_size=0.01,
        )

        assert result.ok is False
        assert fake.order_send_calls == []
        assert "old at the send boundary" in result.error_message

    def test_the_retry_re_checks_freshness_and_will_not_resend_a_stale_quote(self):
        fake = FakeMt5(tick_bid=4374.77, tick_ask=4375.28)
        fake.queue_order_send_result(failed_result())  # first attempt requotes
        calls = {"n": 0}

        def ageing_tick(symbol):
            calls["n"] += 1
            age = 1.0 if calls["n"] == 1 else QUOTE_MAX_AGE_SECONDS + 10
            return SimpleNamespace(bid=4374.77, ask=4375.28, time=broker_epoch_now(-age))

        fake.symbol_info_tick = ageing_tick

        result = Executor(fake).send_bracket_order(
            side="BUY", volume=0.5, stop_loss_points=500, take_profit_points=500,
            magic=262610190, comment="x", symbol="XAUUSD", point_size=0.01,
        )

        assert result.ok is False
        # The first attempt was sent; the retry was refused, not sent stale.
        assert len(fake.order_send_calls) == 1
        assert "on retry" in result.error_message

    def test_a_missing_timestamp_refuses_rather_than_assuming_freshness(self):
        fake = FakeMt5(tick_bid=4374.77, tick_ask=4375.28)
        fake.set_tick_time_raw(0)

        result = Executor(fake).send_bracket_order(
            side="BUY", volume=0.5, stop_loss_points=500, take_profit_points=500,
            magic=262610190, comment="x", symbol="XAUUSD", point_size=0.01,
        )

        assert result.ok is False
        assert fake.order_send_calls == []
        assert "cannot establish quote age" in result.error_message

    def test_the_broker_offset_is_applied_once_not_twice_or_never(self):
        """A quote decoded on the wrong timeline must not pass as fresh.

        Reading the broker's wall-clock epoch as if it were UTC puts the
        quote three hours in the future. That is the exact failure this
        project hit in its stored tick timestamps, and here it would turn
        the whole gate into a no-op, so it is refused rather than treated as
        very fresh.
        """
        fake = FakeMt5(tick_bid=4374.77, tick_ask=4375.28)
        executor = Executor(fake)

        # A correctly-built fresh quote reads as ~0s old, not ~-10800s.
        fake.set_tick_age_seconds(0.0)
        age, problem = executor._quote_age_seconds(fake.symbol_info_tick("XAUUSD"))
        assert problem is None
        assert abs(age) < 5, "a fresh quote should read about 0s old; got %ss" % age

        # Double-applying the offset lands the quote in the future; refused.
        fake.set_tick_time_raw(broker_epoch_now() + 3 * 3600)
        age, problem = executor._quote_age_seconds(fake.symbol_info_tick("XAUUSD"))
        assert problem is not None
        assert "in the future" in problem
