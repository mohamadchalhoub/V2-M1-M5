"""Gold historical-data-collection project — CollectorApp's ongoing tick-sync
cadence (_tick_sync_due / _sync_ticks), plus its isolation-from-the-main-loop
and bounded-failure-cooldown behavior (_maybe_start_tick_sync,
_sync_ticks_isolated, _mt5_call_lock). Mt5Client/ApiClient are both mocked;
no live terminal or backend involved, same posture as
test_runner_candle_sync.py.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

from app.api_client import ApiClientError
from app.runner import TICK_SYNC_INTERVAL_SECONDS, TICK_SYNC_MAX_BACKOFF_SECONDS, TICK_SYNC_SOURCE, CollectorApp


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
    # These tests are specifically about tick sync's own due/backoff/thread
    # logic, so it is opted in here regardless of the real Config's off-by-
    # default posture (see Config.tick_sync_enabled).
    tick_sync_enabled: bool = True
    candle_sync_interval_seconds: int = 300
    candle_initial_sync_days: int = 730
    autonomous_execution_enabled: bool = False


def _app(config: _FakeConfig) -> tuple[CollectorApp, MagicMock, MagicMock]:
    client = MagicMock()
    api = MagicMock()
    executor = MagicMock()
    app = CollectorApp(config, client, api, executor)
    return app, client, api


def test_tick_sync_never_due_when_no_symbols_configured():
    app, _, _ = _app(_FakeConfig(candle_symbols=()))
    assert app._tick_sync_due() is False


def test_tick_sync_never_due_when_disabled_even_with_symbols_configured():
    """Real incident, 2026-09-24: fetching a multi-minute raw-tick window
    through the Wine/MT5 IPC boundary held the shared MT5 lock for 10+
    minutes straight, starving xauusd-sar-v1's order execution entirely.
    Tick sync (an optional historical-data side project) must be
    independently disableable without touching candle syncing, which live
    strategies actually depend on."""
    app, _, _ = _app(_FakeConfig(candle_symbols=("XAUUSD",), tick_sync_enabled=False))
    assert app._tick_sync_due() is False


def test_tick_sync_due_on_first_cycle_when_symbols_configured():
    app, _, _ = _app(_FakeConfig(candle_symbols=("XAUUSD",)))
    assert app._tick_sync_due() is True


def test_tick_sync_not_due_again_immediately_after_running():
    app, _, _ = _app(_FakeConfig(candle_symbols=("XAUUSD",)))
    app._last_tick_sync_at = datetime.now(tz=timezone.utc)
    assert app._tick_sync_due() is False


def test_sync_ticks_pushes_and_records_completed_on_real_rows():
    app, client, api = _app(_FakeConfig(candle_symbols=("XAUUSD",)))
    client.get_ticks.return_value = [
        {"timestamp": "2026-01-01T00:00:00+00:00", "bid": 2400.1, "ask": 2400.3, "last": None,
         "volume": 1.0, "volume_real": 0.01, "flags": 6, "batch_seq": 0},
    ]
    api.post_ticks.return_value = {"ok": True, "inserted": 1}

    app._sync_ticks()

    api.post_ticks.assert_called_once()
    ledger_call = api.upsert_backfill_interval.call_args_list[0].args[0]
    assert ledger_call["source"] == TICK_SYNC_SOURCE
    assert ledger_call["symbol"] == "XAUUSD"
    assert ledger_call["dataType"] == "TICK"
    assert ledger_call["status"] == "COMPLETED"
    assert ledger_call["recordCount"] == 1
    assert app._last_tick_sync_at is not None


def test_sync_ticks_records_empty_unconfirmed_on_zero_rows_no_error():
    app, client, api = _app(_FakeConfig(candle_symbols=("XAUUSD",)))
    client.get_ticks.return_value = []

    app._sync_ticks()

    api.post_ticks.assert_not_called()
    ledger_call = api.upsert_backfill_interval.call_args_list[0].args[0]
    assert ledger_call["status"] == "EMPTY_UNCONFIRMED"
    assert ledger_call["recordCount"] == 0


def test_sync_ticks_records_failed_on_mt5_error_never_crashes_the_loop():
    app, client, api = _app(_FakeConfig(candle_symbols=("XAUUSD",)))
    client.get_ticks.side_effect = RuntimeError("Terminal: Call failed")

    app._sync_ticks()  # must not raise

    api.post_ticks.assert_not_called()
    ledger_call = api.upsert_backfill_interval.call_args_list[0].args[0]
    assert ledger_call["status"] == "FAILED"
    assert "Call failed" in ledger_call["evidence"]
    assert app._last_tick_sync_at is not None  # still advances — never retries the same cycle in a hot loop


def test_sync_ticks_records_failed_when_push_itself_fails():
    app, client, api = _app(_FakeConfig(candle_symbols=("XAUUSD",)))
    client.get_ticks.return_value = [
        {"timestamp": "2026-01-01T00:00:00+00:00", "bid": 2400.1, "ask": 2400.3, "last": None,
         "volume": 1.0, "volume_real": 0.01, "flags": 6, "batch_seq": 0},
    ]
    api.post_ticks.side_effect = ApiClientError("network error")

    app._sync_ticks()

    statuses = [c.args[0]["status"] for c in api.upsert_backfill_interval.call_args_list]
    assert statuses == ["FAILED"]


def test_sync_ticks_one_symbol_failing_does_not_stop_the_others():
    app, client, api = _app(_FakeConfig(candle_symbols=("EURUSD", "XAUUSD")))
    client.get_ticks.side_effect = [RuntimeError("boom"), []]

    app._sync_ticks()

    assert client.get_ticks.call_count == 2
    statuses = [c.args[0]["status"] for c in api.upsert_backfill_interval.call_args_list]
    assert statuses == ["FAILED", "EMPTY_UNCONFIRMED"]


# -- return value used to drive the bounded failure cooldown -----------------

def test_sync_ticks_returns_true_when_any_symbol_failed():
    app, client, _ = _app(_FakeConfig(candle_symbols=("XAUUSD",)))
    client.get_ticks.side_effect = RuntimeError("Terminal: Call failed")
    assert app._sync_ticks() is True


def test_sync_ticks_returns_false_on_success():
    app, client, api = _app(_FakeConfig(candle_symbols=("XAUUSD",)))
    client.get_ticks.return_value = []
    assert app._sync_ticks() is False


def test_sync_ticks_returns_false_when_only_some_symbols_are_empty():
    app, client, _ = _app(_FakeConfig(candle_symbols=("EURUSD", "XAUUSD")))
    client.get_ticks.side_effect = [[], []]
    assert app._sync_ticks() is False


# -- isolation: never two tick-sync attempts running at once ------------------

def test_tick_sync_not_due_while_a_previous_thread_is_still_alive():
    app, _, _ = _app(_FakeConfig(candle_symbols=("XAUUSD",)))
    app._last_tick_sync_at = datetime.now(tz=timezone.utc) - timedelta(hours=1)

    class _FakeAliveThread:
        def is_alive(self):
            return True

    app._tick_sync_thread = _FakeAliveThread()
    assert app._tick_sync_due() is False


def test_maybe_start_tick_sync_launches_a_thread_that_calls_sync_ticks():
    app, client, api = _app(_FakeConfig(candle_symbols=("XAUUSD",)))
    client.get_ticks.return_value = []

    app._maybe_start_tick_sync()
    assert app._tick_sync_thread is not None
    app._tick_sync_thread.join(timeout=5)

    client.get_ticks.assert_called_once()
    assert app._last_tick_sync_at is not None


def test_maybe_start_tick_sync_does_nothing_when_not_due():
    app, client, _ = _app(_FakeConfig(candle_symbols=()))
    app._maybe_start_tick_sync()
    assert app._tick_sync_thread is None
    client.get_ticks.assert_not_called()


def test_sync_ticks_isolated_serializes_on_the_shared_mt5_lock():
    """The main loop takes `_mt5_call_lock` with a non-blocking attempt to
    decide whether to skip a cycle; this proves `_sync_ticks_isolated` (the
    tick-sync thread's entry point) actually holds that same lock while the
    MT5 call runs, so the main loop's non-blocking attempt would correctly
    see it as busy.
    """
    app, client, _ = _app(_FakeConfig(candle_symbols=("XAUUSD",)))
    lock_was_held_during_call = []

    def slow_get_ticks(*_a, **_k):
        lock_was_held_during_call.append(app._mt5_call_lock.acquire(blocking=False))
        if lock_was_held_during_call[-1]:
            app._mt5_call_lock.release()  # release what we just speculatively grabbed for the probe
        return []

    client.get_ticks.side_effect = slow_get_ticks
    app._sync_ticks_isolated()

    # The probe ran from *inside* the same call the real lock was held for,
    # so a non-blocking acquire attempt during that call must fail (already
    # locked by _sync_ticks_isolated itself).
    assert lock_was_held_during_call == [False]


# -- bounded failure cooldown --------------------------------------------------

def test_sync_ticks_isolated_increments_failure_count_on_failure():
    app, client, _ = _app(_FakeConfig(candle_symbols=("XAUUSD",)))
    client.get_ticks.side_effect = RuntimeError("Terminal: Call failed")

    app._sync_ticks_isolated()
    assert app._tick_sync_consecutive_failures == 1

    app._sync_ticks_isolated()
    assert app._tick_sync_consecutive_failures == 2


def test_sync_ticks_isolated_resets_failure_count_on_success():
    app, client, api = _app(_FakeConfig(candle_symbols=("XAUUSD",)))
    app._tick_sync_consecutive_failures = 3
    client.get_ticks.return_value = []

    app._sync_ticks_isolated()
    assert app._tick_sync_consecutive_failures == 0


def test_tick_sync_backoff_extends_the_wait_after_a_failure():
    app, _, _ = _app(_FakeConfig(candle_symbols=("XAUUSD",)))
    app._tick_sync_consecutive_failures = 1
    # Just past the normal interval but still well inside the doubled backoff.
    app._last_tick_sync_at = datetime.now(tz=timezone.utc) - timedelta(seconds=TICK_SYNC_INTERVAL_SECONDS + 5)
    assert app._tick_sync_due() is False


def test_tick_sync_backoff_is_capped_and_eventually_retries():
    app, _, _ = _app(_FakeConfig(candle_symbols=("XAUUSD",)))
    app._tick_sync_consecutive_failures = 20  # far beyond the point the cap kicks in
    app._last_tick_sync_at = datetime.now(tz=timezone.utc) - timedelta(seconds=TICK_SYNC_MAX_BACKOFF_SECONDS + 1)
    assert app._tick_sync_due() is True


def test_tick_sync_backoff_does_not_retry_before_the_capped_wait_elapses():
    app, _, _ = _app(_FakeConfig(candle_symbols=("XAUUSD",)))
    app._tick_sync_consecutive_failures = 20
    app._last_tick_sync_at = datetime.now(tz=timezone.utc) - timedelta(seconds=TICK_SYNC_MAX_BACKOFF_SECONDS - 5)
    assert app._tick_sync_due() is False
