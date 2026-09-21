"""Gold historical-data-collection project — tests for
backfill_gold_history.py: the pure calendar-boundary helpers, the warm-up
count-verification-and-extend loop, and the resource-control clean-stop
behavior. Same convention as test_runner_candle_sync.py: GoldBackfillJob's
`client`/`api` collaborators are MagicMocks, never a real Mt5Client/
ApiClient — no live terminal or backend involved.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

from app.api_client import ApiClientError
from backfill_gold_history import (
    GoldBackfillJob,
    WARM_UP_TARGET_BARS,
    boundary_overlap_start,
    overlaps_weekend,
    plan_chunks,
    previous_month_start_utc,
    previous_monday_utc,
)


def _job(**overrides) -> GoldBackfillJob:
    client = MagicMock()
    api = MagicMock()
    defaults = dict(
        client=client,
        api=api,
        symbol="XAUUSD",
        requested_start_utc=datetime(2024, 3, 1, tzinfo=timezone.utc),
        requested_end_utc=datetime(2024, 3, 10, tzinfo=timezone.utc),
        candle_fetch_chunk_days=30,
        candle_push_batch_size=2000,
    )
    defaults.update(overrides)
    return GoldBackfillJob(**defaults)


def _candle(i: int, base: datetime = datetime(2024, 1, 1, tzinfo=timezone.utc)) -> dict:
    """Real, ordered, in-range-by-construction candle — one per hour after
    `base` — so tests exercising the range-validation fix (candles must
    fall inside [range_start, range_end) to count) get a fixture that
    actually does, unless a test deliberately wants an out-of-range one."""
    return {"open_time": (base + timedelta(hours=i)).isoformat(), "open": 1, "high": 1, "low": 1, "close": 1}


# -- real calendar boundaries (W1/MN1), not a fixed-days subtraction ----------

def test_previous_monday_utc_mid_week():
    # 2024-03-01 is a Friday.
    assert previous_monday_utc(datetime(2024, 3, 1, 12, 0, tzinfo=timezone.utc)) == datetime(2024, 2, 26, tzinfo=timezone.utc)


def test_previous_monday_utc_on_a_monday_returns_the_same_day():
    assert previous_monday_utc(datetime(2024, 2, 26, 23, 0, tzinfo=timezone.utc)) == datetime(2024, 2, 26, tzinfo=timezone.utc)


def test_previous_month_start_utc_mid_month():
    assert previous_month_start_utc(datetime(2024, 3, 15, tzinfo=timezone.utc)) == datetime(2024, 3, 1, tzinfo=timezone.utc)


def test_previous_month_start_utc_on_the_first_returns_the_same_day():
    assert previous_month_start_utc(datetime(2024, 3, 1, 5, 0, tzinfo=timezone.utc)) == datetime(2024, 3, 1, tzinfo=timezone.utc)


def test_boundary_overlap_start_uses_real_calendar_boundary_for_w1_and_mn1_not_a_fixed_days_subtraction():
    requested_start = datetime(2024, 3, 1, tzinfo=timezone.utc)  # a Friday, mid-month
    w1_start = boundary_overlap_start("W1", requested_start)
    mn1_start = boundary_overlap_start("MN1", requested_start)
    # A fixed "7 days back" would give 2024-02-23; a fixed "31 days back"
    # would give 2024-01-30 — neither is a real calendar boundary.
    assert w1_start == datetime(2024, 2, 26, tzinfo=timezone.utc)  # the real previous Monday
    assert mn1_start == datetime(2024, 3, 1, tzinfo=timezone.utc)  # the real 1st-of-month (same month, since 3/1 IS the 1st)


def test_boundary_overlap_start_uses_one_bar_duration_for_fixed_duration_timeframes():
    requested_start = datetime(2024, 3, 1, 6, 0, tzinfo=timezone.utc)
    h4_start = boundary_overlap_start("H4", requested_start)
    assert h4_start == requested_start - timedelta(hours=4)


def test_plan_chunks_splits_into_bounded_windows_covering_the_full_range():
    chunks = plan_chunks(datetime(2024, 1, 1, tzinfo=timezone.utc), datetime(2024, 1, 10, tzinfo=timezone.utc), chunk_days=3)
    assert chunks[0] == (datetime(2024, 1, 1, tzinfo=timezone.utc), datetime(2024, 1, 4, tzinfo=timezone.utc))
    assert chunks[-1][1] == datetime(2024, 1, 10, tzinfo=timezone.utc)
    # No gaps: each chunk's end is the next chunk's start.
    for (_, end), (next_start, _) in zip(chunks, chunks[1:]):
        assert end == next_start


def test_overlaps_weekend_true_for_a_range_spanning_saturday():
    assert overlaps_weekend(datetime(2024, 3, 1, tzinfo=timezone.utc), datetime(2024, 3, 3, tzinfo=timezone.utc)) is True


def test_overlaps_weekend_false_for_a_pure_midweek_range():
    assert overlaps_weekend(datetime(2024, 3, 4, tzinfo=timezone.utc), datetime(2024, 3, 5, tzinfo=timezone.utc)) is False


# -- warm-up: verify actual returned bar counts, extend if short --------------

def test_run_warmup_accepts_the_seed_window_when_it_already_meets_the_target():
    job = _job()
    target = WARM_UP_TARGET_BARS["H1"]
    # Placed to END right at warmup_end (job.requested_start_utc) and count
    # backward — guarantees every candle is genuinely in-range regardless
    # of exactly how wide the seed window is, since range-validation now
    # requires it (see backfill_gold_history.py's _fetch_push_and_record_candles).
    base = job.requested_start_utc - timedelta(hours=target)
    job.client.get_candles.return_value = [_candle(i, base=base) for i in range(target)]

    job.run_warmup("H1")

    # Only ONE fetch attempt needed — the seed window already met the target.
    assert job.api.upsert_backfill_interval.call_count == 1
    call = job.api.upsert_backfill_interval.call_args_list[0].args[0]
    assert call["status"] == "COMPLETED"
    assert call["recordCount"] == target


def test_run_warmup_doubles_the_window_and_retries_when_short_of_the_true_target(monkeypatch):
    # Mocked at the _fetch_candles_chunked boundary (one call per run_warmup
    # attempt, regardless of that method's own internal 30-day sub-chunking,
    # which is a separate concern from the doubling/verification loop this
    # test targets) — a plain-list side_effect then correctly represents
    # "attempt 1 was short, attempt 2 (the doubled window) was enough."
    job = _job()
    target = WARM_UP_TARGET_BARS["H4"]  # 1000 — deliberately demanding
    # Ending right at warmup_end (constant across attempts — only
    # warmup_start moves earlier as the window doubles), so these stay
    # genuinely in-range no matter which attempt's window they're checked
    # against.
    base = job.requested_start_utc - timedelta(hours=target)
    short = [_candle(i, base=base) for i in range(target - 1)]  # one bar short
    enough = [_candle(i, base=base) for i in range(target)]
    fetch_mock = MagicMock(side_effect=[short, enough])
    monkeypatch.setattr(job, "_fetch_candles_chunked", fetch_mock)

    job.run_warmup("H4")

    # Two distinct fetch windows were attempted (the doubling), and the
    # second, wider one is what actually gets pushed/recorded as COMPLETED.
    assert fetch_mock.call_count == 2
    first_window = fetch_mock.call_args_list[0].args[1:3]
    second_window = fetch_mock.call_args_list[1].args[1:3]
    assert second_window[0] < first_window[0]  # the retry reaches further back
    final_call = job.api.upsert_backfill_interval.call_args_list[-1].args[0]
    assert final_call["status"] == "COMPLETED"
    assert final_call["recordCount"] == target


def test_run_warmup_logs_a_shortfall_honestly_if_never_met_even_after_max_doublings(monkeypatch):
    job = _job()
    target = WARM_UP_TARGET_BARS["H4"]
    base = job.requested_start_utc - timedelta(hours=target)
    # Always short, no matter how wide the window gets.
    fetch_mock = MagicMock(return_value=[_candle(i, base=base) for i in range(target - 1)])
    monkeypatch.setattr(job, "_fetch_candles_chunked", fetch_mock)

    job.run_warmup("H4")

    final_call = job.api.upsert_backfill_interval.call_args_list[-1].args[0]
    assert "met_target=False" in final_call["evidence"]
    assert final_call["recordCount"] == target - 1
    assert fetch_mock.call_count == 7  # the initial attempt + WARM_UP_MAX_DOUBLINGS (6) retries


def test_run_warmup_skips_m1_entirely_no_indicator_in_this_project_uses_it():
    job = _job()
    job.run_warmup("M1")
    job.client.get_candles.assert_not_called()
    job.api.upsert_backfill_interval.assert_not_called()


# -- resource controls: stop cleanly, never silently truncate ----------------

def test_check_resources_fails_closed_when_local_disk_is_low(monkeypatch, tmp_path):
    job = _job(local_path=str(tmp_path))
    fake_usage = MagicMock(free=1)  # far below MIN_FREE_DISK_BYTES
    monkeypatch.setattr("backfill_gold_history.shutil.disk_usage", lambda _path: fake_usage)

    ok, reason = job.check_resources()

    assert ok is False
    assert "disk" in reason


def test_check_resources_fails_closed_on_excessive_wal_growth_between_checks(monkeypatch, tmp_path):
    job = _job(local_path=str(tmp_path))
    monkeypatch.setattr(
        "backfill_gold_history.shutil.disk_usage",
        lambda _path: MagicMock(free=10 * 1024 ** 3),
    )
    job.api.get_storage_health.side_effect = [
        {"walSizeBytes": 100 * 1024 ** 2},
        {"walSizeBytes": 900 * 1024 ** 2},  # 800 MiB growth > the 500 MiB margin
    ]

    ok1, _ = job.check_resources()
    ok2, reason2 = job.check_resources()

    assert ok1 is True
    assert ok2 is False
    assert "WAL" in reason2


def test_run_candle_timeframe_stops_cleanly_marks_incomplete_and_preserves_prior_completions(monkeypatch, tmp_path):
    job = _job(
        local_path=str(tmp_path),
        requested_start_utc=datetime(2024, 3, 1, tzinfo=timezone.utc),
        requested_end_utc=datetime(2024, 3, 1, tzinfo=timezone.utc) + timedelta(days=90),
        candle_fetch_chunk_days=30,
    )
    job.client.get_candles.return_value = [_candle(i) for i in range(WARM_UP_TARGET_BARS["H1"])]
    job.api.get_backfill_intervals.return_value = []

    call_count = {"n": 0}

    def fake_check_resources():
        call_count["n"] += 1
        # Let warm-up + the first chunk through, then stop.
        return (True, "") if call_count["n"] <= 1 else (False, "simulated resource exhaustion")

    monkeypatch.setattr(job, "check_resources", fake_check_resources)

    job.run_candle_timeframe("H1")

    assert job._stopped_for_resources is True
    incomplete_calls = [
        c.args[0] for c in job.api.upsert_backfill_interval.call_args_list
        if c.args[0].get("status") == "INCOMPLETE"
    ]
    assert len(incomplete_calls) == 1
    assert "resource stop" in incomplete_calls[0]["evidence"]
    # A resource stop is recorded and explained — never a silent truncation
    # of the requested period.


def test_run_returns_nonzero_and_skips_ticks_when_stopped_for_resources(monkeypatch, tmp_path):
    job = _job(local_path=str(tmp_path))
    job.client.get_instrument_verification.return_value = {}
    monkeypatch.setattr(job, "check_resources", lambda: (False, "simulated"))
    job.api.get_backfill_intervals.return_value = []

    exit_code = job.run()

    assert exit_code == 1
    job.client.get_ticks.assert_not_called()


def test_candles_only_never_enters_the_tick_backfill(monkeypatch, tmp_path):
    job = _job(local_path=str(tmp_path), candles_only=True)
    job.client.get_instrument_verification.return_value = {}
    ran = []
    monkeypatch.setattr(job, "run_candle_timeframe", lambda tf: ran.append(tf))
    monkeypatch.setattr(job, "run_ticks", lambda: (_ for _ in ()).throw(AssertionError("tick backfill must not run")))

    assert job.run() == 0
    assert "M1" in ran and "H4" in ran and "D1" in ran
    job.client.get_ticks.assert_not_called()


# -- EMPTY_UNCONFIRMED -> one independent recheck -> EMPTY_CONFIRMED ---------

def test_empty_candle_response_is_unconfirmed_then_confirmed_after_one_recheck(tmp_path):
    job = _job(local_path=str(tmp_path))
    job.client.get_candles.return_value = []

    status = job._fetch_push_and_record_candles_with_recheck(
        "H1", datetime(2024, 3, 1, tzinfo=timezone.utc), datetime(2024, 3, 2, tzinfo=timezone.utc),
    )

    assert status == "EMPTY_CONFIRMED"
    # Fetched twice (the original attempt + exactly one independent recheck).
    assert job.client.get_candles.call_count == 2
    statuses_written = [c.args[0]["status"] for c in job.api.upsert_backfill_interval.call_args_list]
    assert statuses_written == ["PENDING", "EMPTY_UNCONFIRMED", "PENDING", "EMPTY_UNCONFIRMED", "EMPTY_CONFIRMED"]


def test_checkpoint_is_only_written_completed_after_a_successful_push_never_before(tmp_path):
    job = _job(local_path=str(tmp_path))
    job.client.get_candles.return_value = [_candle(0, base=datetime(2024, 3, 1, tzinfo=timezone.utc))]
    job.api.post_candles.side_effect = ApiClientError("network died mid-push")

    status = job._fetch_push_and_record_candles("H1", datetime(2024, 3, 1, tzinfo=timezone.utc), datetime(2024, 3, 2, tzinfo=timezone.utc))

    # A crash between fetch and push must never be checkpointed as COMPLETED.
    assert status == "FAILED"
    statuses_written = [c.args[0]["status"] for c in job.api.upsert_backfill_interval.call_args_list]
    assert "COMPLETED" not in statuses_written
    assert statuses_written[-1] == "FAILED"
