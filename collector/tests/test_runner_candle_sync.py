"""Historical chart reconstruction phase — CollectorApp's candle-sync
cadence (_candle_sync_due / _sync_candles / _sync_one_candle_series).
Mt5Client/ApiClient are both mocked; no live terminal or backend involved,
same posture as the rest of this test suite (test_api_mapper.py, etc.)
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

from app.api_client import ApiClientError
from app.runner import CANDLE_PUSH_BATCH_SIZE, CollectorApp


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
    autonomous_execution_enabled: bool = False
    mt5_broker_timezone: str = "UTC"  # UTC makes stored_candle_time_to_true_utc a no-op, isolating these tests' own overlap-arithmetic assertions from the timezone-conversion fix itself (covered separately below)


def _app(config: _FakeConfig) -> tuple[CollectorApp, MagicMock, MagicMock]:
    client = MagicMock()
    api = MagicMock()
    executor = MagicMock()
    app = CollectorApp(config, client, api, executor)
    return app, client, api


def test_candle_sync_never_due_when_no_symbols_configured():
    app, _, _ = _app(_FakeConfig(candle_symbols=()))
    assert app._candle_sync_due() is False


def test_candle_sync_due_on_first_check_when_configured():
    app, _, _ = _app(_FakeConfig(candle_symbols=("EURUSD",)))
    assert app._candle_sync_due() is True


def test_candle_sync_not_due_again_until_interval_elapses():
    app, _, _ = _app(_FakeConfig(candle_symbols=("EURUSD",), candle_sync_interval_seconds=300))
    app._last_candle_sync_at = datetime.now(tz=timezone.utc)
    assert app._candle_sync_due() is False

    app._last_candle_sync_at = datetime.now(tz=timezone.utc) - timedelta(seconds=301)
    assert app._candle_sync_due() is True


def test_sync_candles_runs_every_symbol_by_timeframe_pair():
    config = _FakeConfig(candle_symbols=("EURUSD", "GBPUSD"), candle_timeframes=("M5", "H1"))
    app, client, api = _app(config)
    api.get_latest_candle_time.return_value = {"latestOpenTime": None}
    client.get_candles.return_value = [
        {"open_time": "2026-01-01T00:00:00+00:00", "open": 1, "high": 1, "low": 1, "close": 1, "volume": None},
    ]
    api.post_candles.return_value = {"ok": True, "upserted": 1}

    app._sync_candles()

    pairs = {(c.args[0], c.args[1]) for c in client.get_candles.call_args_list}
    assert pairs == {("EURUSD", "M5"), ("EURUSD", "H1"), ("GBPUSD", "M5"), ("GBPUSD", "H1")}
    assert app._last_candle_sync_at is not None


def test_initial_backfill_uses_candle_initial_sync_days_when_no_cursor():
    config = _FakeConfig(candle_symbols=("EURUSD",), candle_timeframes=("M5",), candle_initial_sync_days=730)
    app, client, api = _app(config)
    api.get_latest_candle_time.return_value = {"latestOpenTime": None}
    client.get_candles.return_value = []

    app._sync_one_candle_series("EURUSD", "M5")

    # Chunked fetching (CANDLE_FETCH_CHUNK_DAYS) — the FIRST chunk's start is
    # the overall backfill start; later calls cover later, smaller windows.
    date_from = client.get_candles.call_args_list[0].args[2]
    now = datetime.now(tz=timezone.utc)
    expected = now - timedelta(days=730)
    assert abs((date_from - expected).total_seconds()) < 5  # allow for test execution time
    assert client.get_candles.call_count > 1  # a 730-day range is chunked, not one call


def test_w1_initial_backfill_uses_its_own_floor_not_the_global_setting():
    # candle_initial_sync_days=1000 (this deployment's real value) is far
    # below W1's own 1825-day floor (_MIN_INITIAL_SYNC_DAYS_BY_TIMEFRAME) —
    # confirms the floor wins so Ichimoku has enough weekly history.
    config = _FakeConfig(candle_symbols=("EURUSD",), candle_timeframes=("W1",), candle_initial_sync_days=1000)
    app, client, api = _app(config)
    api.get_latest_candle_time.return_value = {"latestOpenTime": None}
    client.get_candles.return_value = []

    app._sync_one_candle_series("EURUSD", "W1")

    date_from = client.get_candles.call_args_list[0].args[2]
    now = datetime.now(tz=timezone.utc)
    expected = now - timedelta(days=1825)
    assert abs((date_from - expected).total_seconds()) < 5


def test_mn1_initial_backfill_uses_its_own_floor_not_the_global_setting():
    config = _FakeConfig(candle_symbols=("EURUSD",), candle_timeframes=("MN1",), candle_initial_sync_days=1000)
    app, client, api = _app(config)
    api.get_latest_candle_time.return_value = {"latestOpenTime": None}
    client.get_candles.return_value = []

    app._sync_one_candle_series("EURUSD", "MN1")

    date_from = client.get_candles.call_args_list[0].args[2]
    now = datetime.now(tz=timezone.utc)
    expected = now - timedelta(days=5475)
    assert abs((date_from - expected).total_seconds()) < 5


def test_other_timeframes_still_use_the_global_setting_unaffected_by_the_w1_mn1_floors():
    config = _FakeConfig(candle_symbols=("EURUSD",), candle_timeframes=("M5",), candle_initial_sync_days=1000)
    app, client, api = _app(config)
    api.get_latest_candle_time.return_value = {"latestOpenTime": None}
    client.get_candles.return_value = []

    app._sync_one_candle_series("EURUSD", "M5")

    date_from = client.get_candles.call_args_list[0].args[2]
    now = datetime.now(tz=timezone.utc)
    expected = now - timedelta(days=1000)
    assert abs((date_from - expected).total_seconds()) < 5


def test_incremental_sync_uses_cursor_minus_overlap():
    config = _FakeConfig(candle_symbols=("EURUSD",), candle_timeframes=("M5",))
    app, client, api = _app(config)
    api.get_latest_candle_time.return_value = {"latestOpenTime": "2026-01-01T00:00:00+00:00"}
    client.get_candles.return_value = []

    app._sync_one_candle_series("EURUSD", "M5")

    date_from = client.get_candles.call_args_list[0].args[2]
    # 3 bars of M5 = 15 minutes overlap (CANDLE_SYNC_OVERLAP_BARS=3 in runner.py)
    assert date_from == datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc) - timedelta(minutes=15)


def test_incremental_sync_converts_the_stored_broker_mislabeled_cursor_to_true_utc_first():
    """Regression test for a live-found bug: the stored cursor
    (`latestOpenTime`) is the broker-wall-clock-mislabeled-as-UTC value, not
    true UTC. Computing date_from directly from it (treating it as already
    true UTC) produced a date_from roughly the broker's own UTC offset
    AHEAD of true now — an inverted range that MT5 answers with zero bars,
    forever, every cycle. With a broker offset of +3h (EEST) and a stored
    cursor of 12:44 UTC (mislabeled), the correct true-UTC anchor is 09:44,
    so date_from (minus 15min overlap for M5's 3-bar window) must be
    09:29 — NOT 12:29 (what the pre-fix code would have produced).
    """
    config = _FakeConfig(candle_symbols=("XAUUSD",), candle_timeframes=("M5",), mt5_broker_timezone="EET")  # this deployment's real broker timezone; +3h (EEST) in September
    app, client, api = _app(config)
    api.get_latest_candle_time.return_value = {"latestOpenTime": "2026-09-15T12:44:00.000Z"}
    client.get_candles.return_value = []

    app._sync_one_candle_series("XAUUSD", "M5")

    date_from = client.get_candles.call_args_list[0].args[2]
    assert date_from == datetime(2026, 9, 15, 9, 29, tzinfo=timezone.utc)


def test_large_date_range_is_fetched_in_bounded_chunks():
    config = _FakeConfig(candle_symbols=("EURUSD",), candle_timeframes=("M5",), candle_initial_sync_days=90)
    app, client, api = _app(config)
    api.get_latest_candle_time.return_value = {"latestOpenTime": None}
    client.get_candles.return_value = []

    app._sync_one_candle_series("EURUSD", "M5")

    # 90 days / 30-day chunks = 3 calls, each spanning <= CANDLE_FETCH_CHUNK_DAYS.
    assert client.get_candles.call_count == 3
    for call in client.get_candles.call_args_list:
        _, _, chunk_from, chunk_to = call.args
        assert (chunk_to - chunk_from) <= timedelta(days=30)


def test_no_candles_returned_pushes_nothing():
    config = _FakeConfig(candle_symbols=("EURUSD",), candle_timeframes=("M5",))
    app, client, api = _app(config)
    api.get_latest_candle_time.return_value = {"latestOpenTime": None}
    client.get_candles.return_value = []

    app._sync_one_candle_series("EURUSD", "M5")
    api.post_candles.assert_not_called()


def test_large_result_is_pushed_in_bounded_batches():
    # A single day (well within one CANDLE_FETCH_CHUNK_DAYS chunk, so exactly
    # one get_candles call) that happens to return more candles than one
    # push batch — proves batching is about push size, independent of chunking.
    config = _FakeConfig(candle_symbols=("EURUSD",), candle_timeframes=("M5",), candle_initial_sync_days=1)
    app, client, api = _app(config)
    api.get_latest_candle_time.return_value = {"latestOpenTime": None}
    client.get_candles.return_value = [
        {"open_time": f"2026-01-01T00:{i:02d}:00+00:00", "open": 1, "high": 1, "low": 1, "close": 1, "volume": None}
        for i in range(CANDLE_PUSH_BATCH_SIZE + 50)
    ]
    api.post_candles.return_value = {"ok": True, "upserted": 1}

    app._sync_one_candle_series("EURUSD", "M5")

    assert client.get_candles.call_count == 1
    assert api.post_candles.call_count == 2
    first_batch = api.post_candles.call_args_list[0].args[0]
    second_batch = api.post_candles.call_args_list[1].args[0]
    assert len(first_batch["candles"]) == CANDLE_PUSH_BATCH_SIZE
    assert len(second_batch["candles"]) == 50


def test_a_failing_pair_never_stops_the_others_this_tick():
    config = _FakeConfig(candle_symbols=("EURUSD", "GBPUSD"), candle_timeframes=("M5",))
    app, client, api = _app(config)
    api.get_latest_candle_time.return_value = {"latestOpenTime": None}
    client.get_candles.return_value = [
        {"open_time": "2026-01-01T00:00:00+00:00", "open": 1, "high": 1, "low": 1, "close": 1, "volume": None},
    ]

    def post_candles(payload):
        if payload["symbol"] == "EURUSD":
            raise ApiClientError("network blip")
        return {"ok": True, "upserted": 1}

    api.post_candles.side_effect = post_candles

    app._sync_candles()  # must not raise

    gbpusd_calls = [c for c in api.post_candles.call_args_list if c.args[0]["symbol"] == "GBPUSD"]
    assert len(gbpusd_calls) == 1
