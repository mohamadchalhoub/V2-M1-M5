"""Gold historical-data-collection project — tests for Mt5Client.get_ticks(),
get_instrument_verification(), and M1 timeframe support.

Same convention as test_mt5_client.py: pytest monkeypatch directly on
mt5_client_module.mt5 for MT5-boundary methods (copy_ticks_range,
symbol_info, account_info, last_error) — no live terminal involved.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app import mt5_client as mt5_client_module
from app.mt5_client import Mt5Client


class _FakeConfig:
    mt5_timeout_ms = 60_000
    mt5_terminal_path = None
    has_explicit_credentials = False
    mt5_broker_timezone = "EET"


def _tick(time_msc: int, bid: float, ask: float, last: float = 0.0,
          volume: float = 1.0, volume_real: float = 0.01, flags: int = 6) -> dict:
    return {
        "time_msc": time_msc, "bid": bid, "ask": ask, "last": last,
        "volume": volume, "volume_real": volume_real, "flags": flags,
    }


# -- get_ticks ----------------------------------------------------------------

def test_get_ticks_happy_path_maps_every_field(monkeypatch):
    # A real epoch-ms value: 2026-01-01T00:00:00.500Z
    t1 = _tick(1767225600500, bid=2400.10, ask=2400.30, last=0.0, volume=2.0, volume_real=0.02, flags=134)
    t2 = _tick(1767225601000, bid=2400.15, ask=2400.35, last=2400.20, volume=1.0, volume_real=0.01, flags=6)

    monkeypatch.setattr(mt5_client_module.mt5, "copy_ticks_range", lambda *a, **k: [t1, t2])

    client = Mt5Client(_FakeConfig())
    result = client.get_ticks(
        "XAUUSD",
        datetime(2026, 1, 1, tzinfo=timezone.utc),
        datetime(2026, 1, 2, tzinfo=timezone.utc),
    )

    assert len(result) == 2
    assert result[0]["timestamp"] == "2026-01-01T00:00:00.500000+00:00"
    assert result[0]["bid"] == 2400.10
    assert result[0]["ask"] == 2400.30
    # MT5 uses 0.0, not null, for "no last price" — must be normalized to None.
    assert result[0]["last"] is None
    assert result[0]["volume"] == 2.0
    assert result[0]["volume_real"] == 0.02
    assert result[0]["flags"] == 134
    assert result[0]["batch_seq"] == 0

    assert result[1]["last"] == 2400.20
    assert result[1]["batch_seq"] == 1  # 0-based index within this returned array


def test_get_ticks_returns_empty_list_when_mt5_returns_none(monkeypatch):
    monkeypatch.setattr(mt5_client_module.mt5, "copy_ticks_range", lambda *a, **k: None)
    monkeypatch.setattr(mt5_client_module.mt5, "last_error", lambda: (1, "RES_S_OK"))

    client = Mt5Client(_FakeConfig())
    result = client.get_ticks("XAUUSD", datetime.now(tz=timezone.utc), datetime.now(tz=timezone.utc))
    assert result == []


def test_get_ticks_raises_on_a_real_mt5_error(monkeypatch, caplog):
    """A genuine MT5 error (code != 1) must raise, not degrade to `[]` —
    live evidence (2026-09-13) showed the old degrade-to-empty shape made a
    hard failure indistinguishable from a real confirmed-empty (code 1)
    result, mis-recording FAILED backfill intervals as EMPTY_CONFIRMED.
    """
    monkeypatch.setattr(mt5_client_module.mt5, "copy_ticks_range", lambda *a, **k: None)
    monkeypatch.setattr(mt5_client_module.mt5, "last_error", lambda: (4301, "unknown symbol"))

    client = Mt5Client(_FakeConfig())
    with caplog.at_level("WARNING", logger="collector.mt5_client"):
        with pytest.raises(RuntimeError, match="unknown symbol"):
            client.get_ticks("NOT_A_SYMBOL", datetime.now(tz=timezone.utc), datetime.now(tz=timezone.utc))
    assert any("copy_ticks_range returned None" in r.message for r in caplog.records)


def test_get_ticks_returns_empty_on_a_genuine_confirmed_empty_result(monkeypatch):
    """code == 1 ("Success") with a None return is a real, error-free empty
    result (e.g. a window with no ticks) and must still return `[]`, not
    raise — only a genuine error (code != 1) should raise.
    """
    monkeypatch.setattr(mt5_client_module.mt5, "copy_ticks_range", lambda *a, **k: None)
    monkeypatch.setattr(mt5_client_module.mt5, "last_error", lambda: (1, "Success"))

    client = Mt5Client(_FakeConfig())
    result = client.get_ticks("XAUUSD", datetime.now(tz=timezone.utc), datetime.now(tz=timezone.utc))
    assert result == []


def test_get_ticks_handles_missing_volume_fields_gracefully(monkeypatch):
    monkeypatch.setattr(
        mt5_client_module.mt5, "copy_ticks_range",
        lambda *a, **k: [_tick(1767225600000, 2400.0, 2400.2, volume=None, volume_real=None)],
    )
    client = Mt5Client(_FakeConfig())
    result = client.get_ticks("XAUUSD", datetime.now(tz=timezone.utc), datetime.now(tz=timezone.utc))
    assert result[0]["volume"] is None
    assert result[0]["volume_real"] is None


# -- M1 timeframe ---------------------------------------------------------------

def test_m1_timeframe_maps_to_a_real_mt5_constant(monkeypatch):
    monkeypatch.setattr(mt5_client_module.mt5, "copy_rates_range", lambda *a, **k: [])
    client = Mt5Client(_FakeConfig())
    result = client.get_candles("XAUUSD", "M1", datetime.now(tz=timezone.utc), datetime.now(tz=timezone.utc))
    assert result == []  # would have raised ValueError("Unsupported timeframe") if M1 weren't mapped


# -- get_instrument_verification ------------------------------------------------

class _FakeAccountInfo:
    def __init__(self, **kwargs):
        self._d = kwargs

    def _asdict(self):
        return self._d


class _FakeSymbolInfoFull:
    def __init__(self, **kwargs):
        self._d = kwargs

    def _asdict(self):
        return self._d


def _account(**overrides) -> _FakeAccountInfo:
    base = dict(login=555111, server="MetaQuotes-Demo", currency="USD", balance=10000.0,
                equity=10000.0, margin=0.0, margin_free=10000.0, margin_level=None,
                profit=0.0, leverage=100, trade_allowed=True, trade_mode=1)
    base.update(overrides)
    return _FakeAccountInfo(**base)


def _gold_symbol_info(**overrides) -> _FakeSymbolInfoFull:
    base = dict(
        path="Metals\\XAUUSD", description="Gold vs US Dollar",
        currency_base="XAU", currency_profit="USD", currency_margin="USD",
        trade_tick_size=0.01, trade_tick_value_profit=1.0, trade_tick_value=1.0,
        trade_stops_level=100, trade_freeze_level=0, trade_mode=4,
        swap_mode=1, swap_long=-8.5, swap_short=2.1, swap_rollover3days=3,
        expiration_mode=7, expiration_time=0,
        volume_min=0.01, volume_max=50.0, volume_step=0.01,
        digits=2, point=0.01, trade_contract_size=100.0,
    )
    base.update(overrides)
    return _FakeSymbolInfoFull(**base)


def test_instrument_verification_combines_account_and_symbol_info(monkeypatch):
    monkeypatch.setattr(mt5_client_module.mt5, "account_info", lambda: _account())
    monkeypatch.setattr(mt5_client_module.mt5, "symbol_info", lambda symbol: _gold_symbol_info())

    client = Mt5Client(_FakeConfig())
    result = client.get_instrument_verification("XAUUSD")

    assert result["login"] == 555111
    assert result["server"] == "MetaQuotes-Demo"
    assert result["account_trade_mode"] == 1
    assert result["symbol"] == "XAUUSD"
    assert result["path"] == "Metals\\XAUUSD"
    assert result["currency_base"] == "XAU"
    assert result["currency_profit"] == "USD"
    assert result["currency_margin"] == "USD"
    assert result["trade_tick_size"] == 0.01
    assert result["trade_tick_value"] == 1.0
    assert result["trade_stops_level"] == 100
    assert result["swap_rollover3days"] == 3
    assert result["volume_min"] == 0.01
    assert result["contract_size"] == 100.0
    # Being a CFD / normal gold spec is never flagged.
    assert result["has_real_expiration"] is False
    assert result["non_usd_currencies"] == []


def test_instrument_verification_prefers_trade_tick_value_profit_when_present(monkeypatch):
    monkeypatch.setattr(mt5_client_module.mt5, "account_info", lambda: _account())
    monkeypatch.setattr(
        mt5_client_module.mt5, "symbol_info",
        lambda symbol: _gold_symbol_info(trade_tick_value_profit=1.23, trade_tick_value=9.99),
    )
    client = Mt5Client(_FakeConfig())
    result = client.get_instrument_verification("XAUUSD")
    assert result["trade_tick_value"] == 1.23


def test_instrument_verification_falls_back_to_trade_tick_value_when_profit_variant_absent(monkeypatch):
    info = _gold_symbol_info()
    del info._d["trade_tick_value_profit"]
    monkeypatch.setattr(mt5_client_module.mt5, "account_info", lambda: _account())
    monkeypatch.setattr(mt5_client_module.mt5, "symbol_info", lambda symbol: info)

    client = Mt5Client(_FakeConfig())
    result = client.get_instrument_verification("XAUUSD")
    assert result["trade_tick_value"] == 1.0


def test_instrument_verification_flags_a_real_dated_expiration(monkeypatch):
    monkeypatch.setattr(mt5_client_module.mt5, "account_info", lambda: _account())
    monkeypatch.setattr(
        mt5_client_module.mt5, "symbol_info",
        lambda symbol: _gold_symbol_info(expiration_time=1893456000),  # a real future epoch, not 0
    )
    client = Mt5Client(_FakeConfig())
    result = client.get_instrument_verification("XAUUSD")
    assert result["has_real_expiration"] is True
    assert result["expiration_time"] == datetime.fromtimestamp(1893456000, tz=timezone.utc).isoformat()


def test_instrument_verification_flags_non_usd_currency(monkeypatch):
    monkeypatch.setattr(mt5_client_module.mt5, "account_info", lambda: _account())
    monkeypatch.setattr(
        mt5_client_module.mt5, "symbol_info",
        lambda symbol: _gold_symbol_info(currency_profit="EUR"),
    )
    client = Mt5Client(_FakeConfig())
    result = client.get_instrument_verification("XAUUSD")
    assert result["non_usd_currencies"] == ["EUR"]


def test_instrument_verification_handles_symbol_info_none(monkeypatch):
    monkeypatch.setattr(mt5_client_module.mt5, "account_info", lambda: _account())
    monkeypatch.setattr(mt5_client_module.mt5, "symbol_info", lambda symbol: None)
    monkeypatch.setattr(mt5_client_module.mt5, "last_error", lambda: (4301, "unknown symbol"))

    client = Mt5Client(_FakeConfig())
    result = client.get_instrument_verification("NOT_A_REAL_SYMBOL")

    assert result["login"] == 555111  # account info is independent of symbol_info succeeding
    assert result["volume_min"] is None
    assert result["point"] is None
    assert result["has_real_expiration"] is False


def test_instrument_verification_handles_account_info_none(monkeypatch):
    monkeypatch.setattr(mt5_client_module.mt5, "account_info", lambda: None)
    monkeypatch.setattr(mt5_client_module.mt5, "symbol_info", lambda symbol: _gold_symbol_info())

    client = Mt5Client(_FakeConfig())
    result = client.get_instrument_verification("XAUUSD")

    assert result["login"] is None
    assert result["server"] is None
    assert result["volume_min"] == 0.01  # symbol info still populated independently
