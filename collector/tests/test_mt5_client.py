"""Historical chart reconstruction phase — the first tests for mt5_client.py.

Every other method in this module talks to a live MT5 terminal (Windows
IPC) and has only ever been verified manually against one (see
PROJECT_STATUS.md). `get_candles` is different: its logic (mapping our
timeframe strings, filtering out the still-forming bar) is pure and worth
covering deterministically — `mt5.copy_rates_range`/`mt5.last_error` are
monkeypatched, no live terminal involved.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app import mt5_client as mt5_client_module
from app.mt5_client import Mt5Client, _mt5_time_to_utc, _utc_to_mt5_epoch, stored_candle_time_to_true_utc


class _FakeConfig:
    mt5_timeout_ms = 60_000
    mt5_terminal_path = None
    has_explicit_credentials = False
    mt5_broker_timezone = "EET"


def _rate(open_time: datetime, o: float, h: float, l: float, c: float, tick_volume: float = 10.0) -> dict:
    # `open_time` is the raw value get_candles() reports back as-is (it does
    # NOT correct bar times — see its docstring): plain naive-decoded-as-UTC,
    # same convention this file always stored candles under. These tests
    # exercise the "still forming" cutoff and field mapping, not the
    # separate broker-mislabeling question (covered below by the two
    # `_broker_mislabeled_*` tests using a fixed, non-"now" instant so the
    # offset math is deterministic).
    return {
        "time": int(open_time.timestamp()),
        "open": o, "high": h, "low": l, "close": c,
        "tick_volume": tick_volume,
    }


def test_get_candles_excludes_the_still_forming_bar(monkeypatch):
    # get_candles() converts the real "now" into the broker-mislabeled epoch
    # internally before comparing it to r["time"] (see its docstring) — so
    # bar raw times here are built from that same conversion of the real
    # current instant, not a plain UTC offset, to match what the function
    # actually compares against.
    now = datetime.now(tz=timezone.utc).replace(microsecond=0)
    mislabeled_now_epoch = _utc_to_mt5_epoch(now, "EET")
    closed_bar_raw = mislabeled_now_epoch - 600  # closed 10 (mislabeled) minutes ago
    forming_bar_raw = mislabeled_now_epoch - 120  # opened 2 (mislabeled) minutes ago, M5 not closed yet

    monkeypatch.setattr(
        mt5_client_module.mt5,
        "copy_rates_range",
        lambda symbol, timeframe, date_from, date_to: [
            {"time": closed_bar_raw, "open": 1.1, "high": 1.11, "low": 1.09, "close": 1.105, "tick_volume": 10.0},
            {"time": forming_bar_raw, "open": 1.105, "high": 1.106, "low": 1.104, "close": 1.1055, "tick_volume": 10.0},
        ],
    )

    client = Mt5Client(_FakeConfig())
    result = client.get_candles("EURUSD", "M5", now - timedelta(hours=1), now)

    assert len(result) == 1
    assert result[0]["open_time"] == datetime.fromtimestamp(closed_bar_raw, tz=timezone.utc).isoformat()
    assert result[0]["open"] == 1.1
    assert result[0]["high"] == 1.11
    assert result[0]["low"] == 1.09
    assert result[0]["close"] == 1.105
    assert result[0]["volume"] == 10.0


def test_get_candles_maps_every_closed_bar(monkeypatch):
    now = datetime.now(tz=timezone.utc).replace(microsecond=0)
    bars = [now - timedelta(hours=h) for h in (30, 29, 28)]  # comfortably closed regardless of broker offset
    monkeypatch.setattr(
        mt5_client_module.mt5,
        "copy_rates_range",
        lambda symbol, timeframe, date_from, date_to: [_rate(b, 1.0, 1.0, 1.0, 1.0) for b in bars],
    )

    client = Mt5Client(_FakeConfig())
    result = client.get_candles("EURUSD", "H1", now - timedelta(hours=31), now)
    assert len(result) == 3
    assert [r["open_time"] for r in result] == [b.isoformat() for b in bars]


def test_get_candles_returns_empty_list_when_mt5_returns_none(monkeypatch):
    monkeypatch.setattr(mt5_client_module.mt5, "copy_rates_range", lambda *a, **k: None)
    monkeypatch.setattr(mt5_client_module.mt5, "last_error", lambda: (1, "RES_S_OK"))

    client = Mt5Client(_FakeConfig())
    result = client.get_candles("EURUSD", "M15", datetime.now(tz=timezone.utc), datetime.now(tz=timezone.utc))
    assert result == []


def test_get_candles_rejects_an_unsupported_timeframe():
    client = Mt5Client(_FakeConfig())
    with pytest.raises(ValueError, match="Unsupported timeframe"):
        client.get_candles("EURUSD", "W2", datetime.now(tz=timezone.utc), datetime.now(tz=timezone.utc))


@pytest.mark.parametrize("timeframe", ["M30", "H4", "D1"])
def test_get_candles_accepts_the_technical_analysis_timeframes(monkeypatch, timeframe):
    # Technical-analysis phase (support/resistance, Ichimoku, Fibonacci) —
    # these three were added alongside the original M5/M15/H1; confirms each
    # maps to a real MT5 TIMEFRAME_* constant rather than raising.
    monkeypatch.setattr(mt5_client_module.mt5, "copy_rates_range", lambda *a, **k: [])
    client = Mt5Client(_FakeConfig())
    result = client.get_candles("EURUSD", timeframe, datetime.now(tz=timezone.utc), datetime.now(tz=timezone.utc))
    assert result == []


@pytest.mark.parametrize("timeframe", ["W1", "MN1"])
def test_get_candles_accepts_the_weekly_monthly_timeframes(monkeypatch, timeframe):
    # Ichimoku breakout alerts on W1/MN1 — confirms each maps to a real MT5
    # TIMEFRAME_* constant (TIMEFRAME_W1/TIMEFRAME_MN1) rather than raising.
    monkeypatch.setattr(mt5_client_module.mt5, "copy_rates_range", lambda *a, **k: [])
    client = Mt5Client(_FakeConfig())
    result = client.get_candles("EURUSD", timeframe, datetime.now(tz=timezone.utc), datetime.now(tz=timezone.utc))
    assert result == []


def test_mt5_time_to_utc_returns_none_for_none():
    assert _mt5_time_to_utc(None, "EET") is None


def test_mt5_time_to_utc_corrects_the_real_live_discrepancy_found_this_session():
    # The exact real epoch a live open position reported (raw.time), which
    # naively decoded as UTC read 2026-09-09T01:16:54 — 2h44m ahead of the
    # real UTC time at that moment. Re-interpreting those wall-clock digits
    # as EEST (summer — Sept 9 is within EU DST) and converting properly
    # lands on 2026-09-08T22:16:54Z, within a plausible ~15 minutes of the
    # real UTC time observed live — the fix this test guards against regressing.
    assert _mt5_time_to_utc(1788916614, "EET") == "2026-09-08T22:16:54+00:00"


def test_mt5_time_to_utc_uses_winter_offset_across_a_dst_boundary():
    # Proves this is genuinely DST-aware (EET=+2 winter, EEST=+3 summer), not
    # a hardcoded fixed offset — January is outside EU summer time.
    winter_epoch = int(datetime(2026, 1, 15, 10, 0, 0, tzinfo=timezone.utc).timestamp())
    assert _mt5_time_to_utc(winter_epoch, "EET") == "2026-01-15T08:00:00+00:00"


def test_stored_candle_time_to_true_utc_corrects_a_stored_open_time():
    # The exact live-observed value found while diagnosing the candle-sync
    # stall: a stored (broker-mislabeled) open_time of 12:44 UTC is really
    # 09:44 true UTC in EEST (+3h) — matching this session's own live
    # measurement, not a hypothetical.
    raw = datetime(2026, 9, 15, 12, 44, 0, tzinfo=timezone.utc)
    result = stored_candle_time_to_true_utc(raw, "EET")
    assert result == datetime(2026, 9, 15, 9, 44, 0, tzinfo=timezone.utc)


def test_stored_candle_time_to_true_utc_is_a_no_op_in_utc():
    raw = datetime(2026, 9, 15, 12, 44, 0, tzinfo=timezone.utc)
    assert stored_candle_time_to_true_utc(raw, "UTC") == raw


def test_mt5_time_to_utc_uses_summer_offset_across_a_dst_boundary():
    summer_epoch = int(datetime(2026, 7, 15, 10, 0, 0, tzinfo=timezone.utc).timestamp())
    assert _mt5_time_to_utc(summer_epoch, "EET") == "2026-07-15T07:00:00+00:00"


def test_get_candles_converts_query_bounds_to_the_broker_mislabeled_epoch(monkeypatch):
    # 2026-09-15 fix: a true-UTC `date_from`/`date_to` passed straight through
    # to copy_rates_range() silently excluded the last ~broker-offset hours of
    # bars, because MT5 compares them against each bar's raw (broker
    # wall-clock, mislabeled UTC) epoch, not true UTC — the same bug
    # get_deals_since() was already fixed for. Captures what get_candles()
    # actually sends MT5 and checks it against the independent conversion.
    captured = {}

    def fake_copy_rates_range(symbol, timeframe, date_from, date_to):
        captured["date_from"] = date_from
        captured["date_to"] = date_to
        return []

    monkeypatch.setattr(mt5_client_module.mt5, "copy_rates_range", fake_copy_rates_range)
    client = Mt5Client(_FakeConfig())

    true_utc_from = datetime(2026, 7, 15, 9, 0, 0, tzinfo=timezone.utc)  # EU summer -> EEST +3
    true_utc_to = datetime(2026, 7, 15, 10, 0, 0, tzinfo=timezone.utc)
    client.get_candles("EURUSD", "H1", true_utc_from, true_utc_to)

    assert captured["date_from"] == _utc_to_mt5_epoch(true_utc_from, "EET")
    assert captured["date_to"] == _utc_to_mt5_epoch(true_utc_to, "EET")
    # Not the naive/raw epoch — this is the exact bug being fixed.
    assert captured["date_from"] != int(true_utc_from.timestamp())


def test_get_candles_does_not_relabel_the_bar_time_itself(monkeypatch):
    # get_candles() fixes the QUERY BOUND mislabeling (see the test above)
    # but deliberately leaves r["time"] as its raw naive-decoded-as-UTC
    # value, unlike _mt5_time_to_utc() (positions/deals) — see the
    # docstring: the research layer's data-source.ts already re-corrects
    # stored open_time at read time, and millions of existing rows are
    # already stored this same (uncorrected) way; converting here too would
    # double-convert every new bar against them.
    now = datetime(2026, 7, 15, 12, 0, 0, tzinfo=timezone.utc)
    raw_epoch = int(datetime(2026, 7, 15, 10, 0, 0, tzinfo=timezone.utc).timestamp())
    monkeypatch.setattr(
        mt5_client_module.mt5,
        "copy_rates_range",
        lambda *a, **k: [{
            "time": raw_epoch,
            "open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0, "tick_volume": 1.0,
        }],
    )
    client = Mt5Client(_FakeConfig())
    result = client.get_candles("EURUSD", "H1", now - timedelta(hours=4), now)

    assert len(result) == 1
    assert result[0]["open_time"] == "2026-07-15T10:00:00+00:00"  # unchanged, not "07:00:00"


def test_get_candles_handles_missing_tick_volume(monkeypatch):
    now = datetime.now(tz=timezone.utc).replace(microsecond=0)
    bar_open = now - timedelta(hours=2)
    monkeypatch.setattr(
        mt5_client_module.mt5,
        "copy_rates_range",
        lambda *a, **k: [_rate(bar_open, 1.0, 1.0, 1.0, 1.0, tick_volume=None)],
    )
    client = Mt5Client(_FakeConfig())
    result = client.get_candles("EURUSD", "H1", now - timedelta(hours=3), now)
    assert result[0]["volume"] is None


class _FakeSymbolInfo:
    def __init__(self, **kwargs):
        self._d = kwargs

    def _asdict(self):
        return self._d


def test_get_symbol_info_maps_broker_fields_for_gold(monkeypatch):
    monkeypatch.setattr(
        mt5_client_module.mt5,
        "symbol_info",
        lambda symbol: _FakeSymbolInfo(
            volume_min=0.01, volume_max=50.0, volume_step=0.01,
            digits=2, point=0.01, trade_contract_size=100.0, currency_profit="USD",
            trade_mode=4,
        ),
    )
    client = Mt5Client(_FakeConfig())
    result = client.get_symbol_info("XAUUSD")
    assert result == {
        "symbol": "XAUUSD",
        "volume_min": 0.01,
        "volume_max": 50.0,
        "volume_step": 0.01,
        "digits": 2,
        "point": 0.01,
        "contract_size": 100.0,
        "profit_currency": "USD",
        # SYMBOL_TRADE_MODE_FULL. The m1m5 session check reads this field.
        "trade_mode": 4,
    }


def test_get_symbol_info_returns_none_when_mt5_does_not_know_the_symbol(monkeypatch):
    monkeypatch.setattr(mt5_client_module.mt5, "symbol_info", lambda symbol: None)
    monkeypatch.setattr(mt5_client_module.mt5, "last_error", lambda: (4301, "unknown symbol"))
    client = Mt5Client(_FakeConfig())
    assert client.get_symbol_info("NOT_A_REAL_SYMBOL") is None
