"""A failed positions fetch must never look like "nothing is open".

The backend treats a positions list as AUTHORITATIVE: replaceOpenPositions
marks every stored position missing from it as CLOSED. Combined with the
rule-family slot logic, which releases a slot once the broker confirms a
position closed, an empty list produced by a dropped trade-server connection
would:

  1. mark a live position CLOSED,
  2. release its rule-family slot,
  3. and let a new entry open while the old one was still live at the broker.

positions_get() returns None for BOTH a genuine zero and a genuine failure,
separated only by last_error(). Collapsing the two is the bug these tests
exist to prevent.
"""
from types import SimpleNamespace

import pytest

from app.mt5_client import Mt5Client, PositionsUnavailable


class FakeMt5:
    POSITION_TYPE_BUY = 0
    POSITION_TYPE_SELL = 1

    def __init__(self, positions, error):
        self._positions = positions
        self._error = error
        self.last_error_calls = 0

    def positions_get(self):
        return self._positions

    def last_error(self):
        self.last_error_calls += 1
        return self._error


def client(positions, error):
    c = Mt5Client.__new__(Mt5Client)
    c._mt5 = FakeMt5(positions, error)
    c._config = SimpleNamespace(mt5_broker_timezone="EET")
    return c


def a_position(ticket=58537207521, volume=0.5):
    return SimpleNamespace(
        _asdict=lambda: {
            "ticket": ticket, "symbol": "XAUUSD", "type": 0, "volume": volume,
            "price_open": 4369.96, "price_current": 4366.43,
            "sl": 4364.96, "tp": 4374.96, "swap": 0.0, "profit": -153.77,
            "time": 1789958784, "magic": 262610190, "comment": "rsi-966bf32f",
        }
    )


class TestFailedFetchIsNotAnEmptySnapshot:
    def test_a_genuine_zero_returns_an_empty_list(self):
        # RES_S_OK with None means the account really has no open positions.
        assert client(None, (1, "no error")).get_open_positions() == []

    def test_a_failed_fetch_raises_instead_of_returning_empty(self):
        with pytest.raises(PositionsUnavailable) as err:
            client(None, (10021, "no connection to trade server")).get_open_positions()
        assert "no connection to trade server" in str(err.value)

    @pytest.mark.parametrize(
        "code,message",
        [
            (10021, "no connection to trade server"),
            (-10005, "timeout"),
            (10004, "requote"),
            (5, "internal error"),
        ],
    )
    def test_every_non_ok_error_code_raises(self, code, message):
        with pytest.raises(PositionsUnavailable):
            client(None, (code, message)).get_open_positions()

    def test_real_positions_still_come_back_normally(self):
        out = client([a_position()], (1, "no error")).get_open_positions()
        assert len(out) == 1
        assert out[0]["ticket"] == 58537207521
        assert out[0]["volume"] == 0.5
        assert out[0]["comment"] == "rsi-966bf32f"
        # Deal/position times go through the broker-timezone correction.
        assert out[0]["opened_at"].startswith("2026-09-20T23:46:24")

    def test_the_exception_is_not_swallowed_as_a_falsy_empty_result(self):
        # A caller writing `positions = ... or []` would reintroduce the bug.
        # PositionsUnavailable is an exception, not a falsy value.
        c = client(None, (10021, "no connection"))
        try:
            c.get_open_positions()
        except PositionsUnavailable as exc:
            assert not isinstance(exc, (list, tuple))
            assert bool(exc) is True
        else:
            pytest.fail("a failed fetch must raise")
