"""Task item 3 — "restore-then-close" protection remediation, RESTORE half.
Executor.modify_protection (TRADE_ACTION_SLTP), same monkeypatch-the-mt5-
module convention as test_executor.py.
"""
from __future__ import annotations

from types import SimpleNamespace

from app.executor import Executor
from tests.test_executor import FakeMt5, TRADE_RETCODE_DONE, TRADE_RETCODE_REQUOTE

TRADE_ACTION_SLTP = 6  # real MT5 constant value


def _fake(**kwargs) -> FakeMt5:
    fake = FakeMt5(**kwargs)
    fake.TRADE_ACTION_SLTP = TRADE_ACTION_SLTP
    return fake


class TestModifyProtection:
    def test_sends_the_exact_sl_tp_prices_supplied(self):
        fake = _fake()
        fake.queue_order_send_result(SimpleNamespace(retcode=TRADE_RETCODE_DONE, order=0, volume=0, price=0))

        result = Executor(fake).modify_protection(ticket=555, stop_loss=2640.0, take_profit=2660.0, symbol="XAUUSD")

        assert result.ok is True
        sent = fake.order_send_calls[0]
        assert sent["action"] == TRADE_ACTION_SLTP
        assert sent["position"] == 555
        assert sent["symbol"] == "XAUUSD"
        assert sent["sl"] == 2640.0
        assert sent["tp"] == 2660.0

    def test_reports_failure_when_the_broker_rejects_the_modify(self):
        fake = _fake()
        fake.queue_order_send_result(SimpleNamespace(retcode=TRADE_RETCODE_REQUOTE, order=0, volume=0, price=0, comment="requote"))

        result = Executor(fake).modify_protection(ticket=557, stop_loss=2640.0, take_profit=2660.0, symbol="XAUUSD")

        assert result.ok is False
        assert result.error_message == "requote"

    def test_never_touches_volume_or_price_only_sl_tp(self):
        fake = _fake()
        fake.queue_order_send_result(SimpleNamespace(retcode=TRADE_RETCODE_DONE, order=0, volume=0, price=0))

        Executor(fake).modify_protection(ticket=558, stop_loss=2640.0, take_profit=2660.0, symbol="XAUUSD")

        sent = fake.order_send_calls[0]
        assert "volume" not in sent
        assert "price" not in sent
        assert "type" not in sent

    def test_default_symbol_is_used_when_not_specified(self):
        fake = _fake()
        fake.queue_order_send_result(SimpleNamespace(retcode=TRADE_RETCODE_DONE, order=0, volume=0, price=0))

        Executor(fake).modify_protection(ticket=559, stop_loss=1.09, take_profit=1.11)

        sent = fake.order_send_calls[0]
        assert sent["symbol"]  # default symbol constant, whatever it resolves to
