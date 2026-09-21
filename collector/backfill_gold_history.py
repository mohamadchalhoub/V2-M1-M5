"""Gold historical-data-collection project — a standalone, human-run,
one-shot backfill for XAUUSD tick + candle history. NEVER invoked by
runner.py's own loop; a human runs `python backfill_gold_history.py`
separately, once, against a live MT5 terminal.

Entry-point convention mirrors main.py: only the genuinely MT5-coupled
imports (`Mt5Client`, and `app.runner`'s constants — runner.py itself
imports Mt5Client) are deferred inside `main()`, so a `Config` error (or
simply importing/unit-testing this module) never requires the Windows-only
MetaTrader5 package to be importable first. Everything else used at module
scope (`app.config`, `app.api_client`, `app.api_mapper`,
`app.logging_setup`) has zero MetaTrader5 dependency and is safe to import
directly — the `GoldBackfillJob` class below is built to be unit-tested
with a plain mock standing in for `Mt5Client`/`ApiClient`, never a real one.

Two calendar/timezone notes worth reading before touching the boundary
math below:

- `REQUESTED_START_BEIRUT` is a Beirut LOCAL wall-clock time, converted to
  UTC via `zoneinfo.ZoneInfo("Asia/Beirut")` — a real, DST-aware IANA
  timezone lookup. This is Python; `zoneinfo` is the correct and expected
  tool here. (A different, non-Python research module elsewhere in this
  project has its own, unrelated timezone constraint — irrelevant to this
  file.)
- W1/MN1 "boundary overlap" uses the REAL previous calendar boundary (the
  actual previous Monday 00:00 UTC / first-of-month 00:00 UTC), computed
  by hand below — NOT `CANDLE_DURATION_BY_TIMEFRAME["W1"/"MN1"]`. Those
  constants (7 days / 31 days) exist for a completely different purpose —
  runner.py's live "is this bar still forming" check, where erring long is
  deliberately safe — and reusing them here would silently misalign every
  weekly/monthly chunk boundary against MT5's own actual bar boundaries.

Checkpointing rule that governs every fetch-and-push below: a `COMPLETED`
(or any other terminal, non-PENDING) row is written to the backfill-
intervals ledger ONLY after the fetched data has been successfully pushed
to the backend — never before. A crash between fetch and push simply
leaves that interval `PENDING` forever, which is correct: a future run
will see no matching `COMPLETED` row and safely re-fetch it.
"""
from __future__ import annotations

import calendar
import logging
import shutil
import sys
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

from app.api_client import ApiClientError
from app.api_mapper import build_candles_payload, build_symbol_metadata_payload, build_ticks_payload
from app.config import CANDLE_DURATION_BY_TIMEFRAME, Config, ConfigError
from app.logging_setup import configure_logging

logger = logging.getLogger("collector.backfill_gold_history")

SYMBOL = "XAUUSD"
REQUESTED_START_BEIRUT = "2024-03-01T00:00:00"
BEIRUT_TZ = "Asia/Beirut"

# Identifies rows this script writes in the shared backfill-intervals
# ledger (that table's upsert key includes `source`) — distinct from any
# other process that might one day also write rows for the same
# symbol/dataType/timeframe/range.
BACKFILL_SOURCE = "gold_backfill_script"

# Mirrors runner.py's own CANDLE_FETCH_CHUNK_DAYS/CANDLE_PUSH_BATCH_SIZE —
# duplicated here (not imported) specifically so this module stays free of
# runner.py's own transitive `Mt5Client` import at module scope (see the
# module docstring). main() below overrides these from that single real
# source of truth when actually constructing the job; a human changing
# either constant in runner.py should update this default too.
CANDLE_FETCH_CHUNK_DAYS_DEFAULT = 30
CANDLE_PUSH_BATCH_SIZE_DEFAULT = 2000

# Ticks are far denser per-day than any candle timeframe and MT5's own
# per-call tick cap is unknown up front (unlike candles' already-discovered
# ~1000-day-M5 cap, which CANDLE_FETCH_CHUNK_DAYS already safely avoids) —
# start small and only ever shrink further, same empirical "try, catch the
# terminal's real limit, shrink" pattern as that earlier discovery.
TICK_INITIAL_CHUNK_DAYS = 1.0
TICK_MIN_CHUNK_DAYS = 1.0 / 24  # floor: 1 hour
TICK_PUSH_BATCH_SIZE = 5000

ALL_CANDLE_TIMEFRAMES = ("M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1", "M1")

# SEED calendar-day estimates — verbatim from technical-analysis-report
# .service.ts's own already-vetted TIMEFRAME_LOOKBACK_DAYS, per this task's
# own instruction to reuse those exact numbers rather than inventing new
# ones. H4 is the one deliberate exception: 400d here (not that constant's
# 90d) because H4 alone additionally needs 1000 settled bars for EMA200
# (H4_EMA_SLOW, indicators.ts) — far more demanding than Ichimoku's 78 —
# and 400d is comfortably above the ~167-day theoretical no-gap minimum for
# 1000 H4 bars once ordinary weekend closures are accounted for. M1 is
# intentionally absent: nothing in this project's own indicators ever uses
# it, so it gets no warm-up at all (see WARM_UP_TARGET_BARS and
# run_warmup() below).
WARM_UP_SEED_DAYS: dict[str, int] = {
    "M5": 2, "M15": 5, "M30": 10, "H1": 30, "H4": 400, "D1": 500, "W1": 1095, "MN1": 3650,
}
# The true numeric bar-count requirement each timeframe's warm-up is
# verified against (not merely trusted from the calendar estimate above).
# H4: 1000 (H4_EMA_SLOW: period=200 * settleMultiplier=5, indicators.ts).
# H1: max(42, 78) = 78 (H1_ATR_PERIOD=14 * 3 = 42 for a settled ATR14,
# signal-engine.ts; Ichimoku's own 78-bar minimum — 26 displacement + 52
# Senkou B, ichimoku.service.ts — is the larger of the two). Every other
# timeframe here (M30/D1, and M5/M15/W1/MN1 whose SEED days above were
# THEMSELVES sized, per technical-analysis-report.service.ts's own
# TIMEFRAME_LOOKBACK_DAYS comment, specifically to clear that same 78-bar
# Ichimoku minimum) uses 78 uniformly — cited from source, not re-derived.
WARM_UP_TARGET_BARS: dict[str, int] = {
    "M5": 78, "M15": 78, "M30": 78, "H1": 78, "H4": 1000, "D1": 78, "W1": 78, "MN1": 78,
}
WARM_UP_MAX_DOUBLINGS = 6

# Resource-control safety margins (Resource controls, this script's own
# spec) — deliberately conservative, chosen and documented here rather
# than derived from anything: a multi-year tick backfill can consume disk
# far faster than a human is likely to be watching the console.
MIN_FREE_DISK_BYTES = 2 * 1024 ** 3          # 2 GiB
MAX_WAL_GROWTH_BYTES_PER_CHECK = 500 * 1024 ** 2  # 500 MiB between two consecutive checks


# --------------------------------------------------------------------------
# Pure helpers — no I/O, exercised directly by tests.
# --------------------------------------------------------------------------

def beirut_local_to_utc(local_iso: str) -> datetime:
    """Converts a naive Beirut-local ISO string to a true UTC datetime."""
    naive = datetime.fromisoformat(local_iso)
    beirut_aware = naive.replace(tzinfo=ZoneInfo(BEIRUT_TZ))
    return beirut_aware.astimezone(timezone.utc)


def previous_monday_utc(dt: datetime) -> datetime:
    """The real previous-or-same Monday 00:00 UTC boundary for `dt` — a
    genuine calendar computation, NOT CANDLE_DURATION_BY_TIMEFRAME["W1"]
    (see module docstring for why that constant must not be reused here).
    """
    d = dt.astimezone(timezone.utc)
    monday_date = d.date() - timedelta(days=d.weekday())  # Monday == 0
    return datetime(monday_date.year, monday_date.month, monday_date.day, tzinfo=timezone.utc)


def previous_month_start_utc(dt: datetime) -> datetime:
    """The real first-of-month 00:00 UTC boundary for `dt`'s own month —
    NOT CANDLE_DURATION_BY_TIMEFRAME["MN1"] (see module docstring)."""
    d = dt.astimezone(timezone.utc)
    return datetime(d.year, d.month, 1, tzinfo=timezone.utc)


def boundary_overlap_start(timeframe: str, requested_start_utc: datetime) -> datetime:
    """Where the main (non-warm-up) fetch grid begins for `timeframe`: one
    bar-duration before the requested start for every timeframe EXCEPT
    W1/MN1, which use their own real calendar boundary instead (see module
    docstring). This guarantees the very first bar covering-or-preceding
    the requested start is always included, matching the same "boundary
    overlap" reasoning runner.py's own CANDLE_SYNC_OVERLAP_BARS uses for
    incremental syncs.
    """
    if timeframe == "W1":
        return previous_monday_utc(requested_start_utc)
    if timeframe == "MN1":
        return previous_month_start_utc(requested_start_utc)
    return requested_start_utc - CANDLE_DURATION_BY_TIMEFRAME[timeframe]


def plan_chunks(start: datetime, end: datetime, chunk_days: float) -> list[tuple[datetime, datetime]]:
    """Splits [start, end) into chunk_days-sized [from, to) windows."""
    chunk = timedelta(days=chunk_days)
    chunks: list[tuple[datetime, datetime]] = []
    cursor = start
    while cursor < end:
        nxt = min(cursor + chunk, end)
        chunks.append((cursor, nxt))
        cursor = nxt
    return chunks


def overlaps_weekend(start: datetime, end: datetime) -> bool:
    """Informational only — corroborating evidence text for an
    EMPTY_UNCONFIRMED/EMPTY_CONFIRMED interval, never itself decisive (see
    GoldBackfillJob's own fetch-and-record methods)."""
    cursor = start.date()
    end_date = end.date()
    while cursor <= end_date:
        if cursor.weekday() >= 5:  # Saturday=5, Sunday=6
            return True
        cursor += timedelta(days=1)
    return False


def is_covered(chunk: tuple[datetime, datetime], completed_ranges: list[tuple[datetime, datetime]]) -> bool:
    start, end = chunk
    return any(cs <= start and ce >= end for cs, ce in completed_ranges)


def parse_iso_utc(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# --------------------------------------------------------------------------
# Orchestration — depends only on duck-typed `client`/`api` collaborators
# (a real Mt5Client/ApiClient in production, a MagicMock in tests).
# --------------------------------------------------------------------------

@dataclass
class GoldBackfillJob:
    client: Any  # Mt5Client-shaped: get_candles/get_ticks/get_instrument_verification
    api: Any     # ApiClient-shaped: post_candles/post_ticks/upsert_backfill_interval/...
    symbol: str = SYMBOL
    requested_start_utc: datetime = field(default_factory=lambda: beirut_local_to_utc(REQUESTED_START_BEIRUT))
    requested_end_utc: datetime = field(default_factory=lambda: datetime.now(tz=timezone.utc))
    candle_fetch_chunk_days: int = CANDLE_FETCH_CHUNK_DAYS_DEFAULT
    candle_push_batch_size: int = CANDLE_PUSH_BATCH_SIZE_DEFAULT
    local_path: str = "."
    # `--candles-only`: refresh candle history without re-entering the tick
    # backfill, whose MT5 calls have been failing ("Terminal: Call failed").
    candles_only: bool = False

    def __post_init__(self) -> None:
        self._tick_chunk_days = TICK_INITIAL_CHUNK_DAYS
        self._last_wal_size_bytes: int | None = None
        self._stopped_for_resources = False
        self._candle_counts_seen: dict[str, set[int]] = {}
        self._tick_counts_seen: set[int] = set()
        # {(dataType, timeframe_or_None): {status: count}}
        self._summary: dict[tuple[str, str | None], dict[str, int]] = {}

    # -- top-level orchestration ------------------------------------------------

    def run(self) -> int:
        logger.warning("GOLD BACKFILL RUN STARTING", extra={
            "symbol": self.symbol,
            "requested_start_utc": self.requested_start_utc.isoformat(),
            "requested_end_utc": self.requested_end_utc.isoformat(),
        })

        self.verify_and_push_instrument_metadata()

        for timeframe in ALL_CANDLE_TIMEFRAMES:
            if self._stopped_for_resources:
                break
            self.run_candle_timeframe(timeframe)

        if self.candles_only:
            logger.warning("TICK BACKFILL SKIPPED (--candles-only)", extra={"symbol": self.symbol})
        elif not self._stopped_for_resources:
            self.run_ticks()

        self.print_summary()
        return 1 if self._stopped_for_resources else 0

    # -- instrument verification -------------------------------------------------

    def verify_and_push_instrument_metadata(self) -> dict[str, Any]:
        try:
            info = self.client.get_instrument_verification(self.symbol)
        except Exception as exc:  # noqa: BLE001 — must never abort the whole run
            logger.error("instrument verification raised an error", extra={"error": str(exc)})
            return {}

        # Logged prominently (WARNING, not INFO) so it's visible in the
        # run's output even before any bulk data moves — exactly the
        # "visible before any bulk data moves" requirement this step exists
        # to satisfy.
        logger.warning("INSTRUMENT VERIFICATION", extra={
            "login": info.get("login"), "server": info.get("server"),
            "account_trade_mode": info.get("account_trade_mode"),
            "symbol": self.symbol, "path": info.get("path"),
            "description": info.get("description"),
            "currency_base": info.get("currency_base"),
            "currency_profit": info.get("currency_profit"),
            "currency_margin": info.get("currency_margin"),
            "has_real_expiration": info.get("has_real_expiration"),
            "expiration_time": info.get("expiration_time"),
            "non_usd_currencies": info.get("non_usd_currencies"),
        })

        if info.get("volume_min") is None or info.get("point") is None:
            logger.error(
                "symbol_info unavailable — skipping symbol-metadata push (backfill continues anyway)",
                extra={"symbol": self.symbol},
            )
            return info

        payload = build_symbol_metadata_payload(info)
        try:
            self.api.post_symbol_metadata(payload)
            logger.info("symbol metadata pushed", extra={"symbol": self.symbol})
        except ApiClientError as exc:
            logger.error("symbol-metadata push failed", extra={"symbol": self.symbol, "error": str(exc)})
        return info

    # -- resource controls ---------------------------------------------------

    def check_resources(self) -> tuple[bool, str]:
        """True (with an empty reason) if it's safe to continue; False with
        a human-readable reason otherwise. See MIN_FREE_DISK_BYTES/
        MAX_WAL_GROWTH_BYTES_PER_CHECK's own comments for the thresholds.
        """
        usage = shutil.disk_usage(self.local_path)
        if usage.free < MIN_FREE_DISK_BYTES:
            return False, (
                f"collector-local free disk space ({usage.free} bytes) is below the "
                f"{MIN_FREE_DISK_BYTES}-byte safety margin"
            )

        try:
            health = self.api.get_storage_health()
        except ApiClientError as exc:
            # Can't confirm DB-side health — fail safe (treat as a stop
            # signal) rather than silently continuing blind.
            return False, f"could not check backend storage health: {exc}"

        wal_bytes = health.get("walSizeBytes")
        if wal_bytes is not None and self._last_wal_size_bytes is not None:
            growth = wal_bytes - self._last_wal_size_bytes
            if growth > MAX_WAL_GROWTH_BYTES_PER_CHECK:
                return False, (
                    f"WAL size grew by {growth} bytes since the last check "
                    f"(> {MAX_WAL_GROWTH_BYTES_PER_CHECK}-byte safety margin)"
                )
        self._last_wal_size_bytes = wal_bytes

        return True, ""

    # -- backfill-intervals ledger ---------------------------------------------

    def _upsert_interval(
        self, *, data_type: str, range_start: datetime, range_end: datetime, status: str,
        timeframe: str | None = None, record_count: int | None = None, evidence: str | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "source": BACKFILL_SOURCE,
            "symbol": self.symbol,
            "dataType": data_type,
            "rangeStart": range_start.isoformat(),
            "rangeEnd": range_end.isoformat(),
            "status": status,
        }
        if timeframe is not None:
            payload["timeframe"] = timeframe
        if record_count is not None:
            payload["recordCount"] = record_count
        if evidence is not None:
            payload["evidence"] = evidence
        try:
            self.api.upsert_backfill_interval(payload)
        except ApiClientError as exc:
            logger.error("failed to write backfill-interval ledger row", extra={
                "data_type": data_type, "timeframe": timeframe, "status": status, "error": str(exc),
            })

    def _completed_ranges(self, data_type: str, timeframe: str | None = None) -> list[tuple[datetime, datetime]]:
        try:
            rows = self.api.get_backfill_intervals(self.symbol, data_type, timeframe=timeframe, statuses=["COMPLETED"])
        except ApiClientError as exc:
            logger.warning("could not fetch existing backfill-interval coverage, assuming none", extra={
                "data_type": data_type, "timeframe": timeframe, "error": str(exc),
            })
            return []
        return [(parse_iso_utc(r["rangeStart"]), parse_iso_utc(r["rangeEnd"])) for r in rows]

    def _record_summary(self, data_type: str, timeframe: str | None, status: str) -> None:
        key = (data_type, timeframe)
        counts = self._summary.setdefault(key, {})
        counts[status] = counts.get(status, 0) + 1

    # -- candle warm-up --------------------------------------------------------

    def run_warmup(self, timeframe: str) -> None:
        if timeframe not in WARM_UP_SEED_DAYS:
            logger.info("skipping warm-up — no indicator in this project ever uses this timeframe", extra={
                "timeframe": timeframe,
            })
            return

        target_bars = WARM_UP_TARGET_BARS[timeframe]
        days = WARM_UP_SEED_DAYS[timeframe]
        warmup_end = self.requested_start_utc
        warmup_start = warmup_end - timedelta(days=days)
        candles: list[dict[str, Any]] = []
        in_range: list[dict[str, Any]] = []

        for attempt in range(WARM_UP_MAX_DOUBLINGS + 1):
            warmup_start = warmup_end - timedelta(days=days)
            candles = self._fetch_candles_chunked(timeframe, warmup_start, warmup_end)
            # Same range-validation fix as _fetch_push_and_record_candles:
            # a candle whose open_time doesn't actually fall in
            # [warmup_start, warmup_end) does not count toward the target —
            # confirmed live that copy_rates_range can return an
            # out-of-range row (the nearest cached bar) instead of empty
            # when the requested window predates the terminal's cache.
            in_range = [c for c in candles if warmup_start <= parse_iso_utc(c["open_time"]) < warmup_end]
            logger.info("warm-up fetch", extra={
                "timeframe": timeframe, "window_days": days, "bars_found": len(in_range),
                "raw_rows_returned": len(candles), "target_bars": target_bars, "attempt": attempt,
            })
            if len(in_range) >= target_bars:
                break
            if attempt < WARM_UP_MAX_DOUBLINGS:
                logger.warning("warm-up short of the true target — doubling the window and retrying", extra={
                    "timeframe": timeframe, "bars_found": len(in_range), "target_bars": target_bars,
                    "old_window_days": days, "new_window_days": days * 2,
                })
            days *= 2

        met_target = len(in_range) >= target_bars
        if not met_target:
            logger.error("warm-up never reached the true target even after the maximum doublings", extra={
                "timeframe": timeframe, "bars_found": len(in_range), "target_bars": target_bars,
            })

        # Whatever was returned (in-range or not) is still pushed — harmless
        # and idempotent, each row upserts under its own true open_time —
        # but the interval's STATUS reflects only genuine in-range coverage,
        # never raw non-emptiness.
        if candles:
            try:
                self._push_candles(timeframe, candles)
            except ApiClientError as exc:
                self._upsert_interval(
                    data_type="CANDLE", timeframe=timeframe, range_start=warmup_start, range_end=warmup_end,
                    status="FAILED", record_count=len(in_range),
                    evidence=f"WARM_UP push failed: {exc}",
                )
                self._record_summary("CANDLE", timeframe, "WARM_UP:FAILED")
                logger.error("warm-up push failed", extra={"timeframe": timeframe, "error": str(exc)})
                return

        status = "COMPLETED" if met_target else "EMPTY_UNCONFIRMED" if not in_range else "INCOMPLETE"
        self._upsert_interval(
            data_type="CANDLE", timeframe=timeframe, range_start=warmup_start, range_end=warmup_end,
            status=status, record_count=len(in_range),
            evidence=f"WARM_UP target_bars={target_bars} bars_found={len(in_range)} "
                     f"raw_rows_returned={len(candles)} met_target={met_target}",
        )
        self._record_summary("CANDLE", timeframe, f"WARM_UP:{status}")

    # -- candle main grid --------------------------------------------------------

    def run_candle_timeframe(self, timeframe: str) -> None:
        self.run_warmup(timeframe)

        start = boundary_overlap_start(timeframe, self.requested_start_utc)
        completed = self._completed_ranges("CANDLE", timeframe)
        chunks = plan_chunks(start, self.requested_end_utc, self.candle_fetch_chunk_days)

        for chunk_start, chunk_end in chunks:
            if is_covered((chunk_start, chunk_end), completed):
                self._record_summary("CANDLE", timeframe, "COMPLETED")
                continue

            ok, reason = self.check_resources()
            if not ok:
                self._upsert_interval(
                    data_type="CANDLE", timeframe=timeframe, range_start=chunk_start, range_end=chunk_end,
                    status="INCOMPLETE", evidence=f"resource stop: {reason}",
                )
                logger.error("STOPPING CLEANLY — resource safety margin breached", extra={
                    "reason": reason, "timeframe": timeframe,
                    "chunk_start": chunk_start.isoformat(), "chunk_end": chunk_end.isoformat(),
                })
                self._record_summary("CANDLE", timeframe, "INCOMPLETE")
                self._stopped_for_resources = True
                return

            status = self._fetch_push_and_record_candles_with_recheck(timeframe, chunk_start, chunk_end)
            self._record_summary("CANDLE", timeframe, status)

    def _fetch_push_and_record_candles(
        self, timeframe: str, range_start: datetime, range_end: datetime, evidence_prefix: str = "",
    ) -> str:
        self._upsert_interval(
            data_type="CANDLE", timeframe=timeframe, range_start=range_start, range_end=range_end,
            status="PENDING", evidence=evidence_prefix or None,
        )

        try:
            candles = self._fetch_candles_chunked(timeframe, range_start, range_end)
        except Exception as exc:  # noqa: BLE001 — MT5-boundary call
            self._upsert_interval(
                data_type="CANDLE", timeframe=timeframe, range_start=range_start, range_end=range_end,
                status="FAILED", evidence=f"{evidence_prefix} MT5 error: {exc}".strip(),
            )
            return "FAILED"

        # Range-validation, added after a real, confirmed failure mode: when
        # a requested range predates what the terminal actually has cached
        # (pre-fix, this was every old M1/M5 chunk once MaxBars=100000 was
        # exhausted by more recent bars), copy_rates_range does NOT reliably
        # return empty — it can return a small number of rows that do NOT
        # fall inside [range_start, range_end) at all (observed live: one
        # single out-of-range row per chunk, silently accepted as
        # "COMPLETED" by the original version of this method). Whatever was
        # returned is still pushed below (harmless/idempotent — each row
        # upserts under its own true open_time regardless), but THIS
        # interval's status is scored only on rows that actually fall
        # inside the requested window, never on raw non-emptiness.
        in_range = [c for c in candles if range_start <= parse_iso_utc(c["open_time"]) < range_end]

        if not in_range:
            if candles:
                evidence_prefix = (
                    f"{evidence_prefix} MT5 returned {len(candles)} row(s) but NONE fell inside the "
                    f"requested range (likely the nearest cached bar, not real history for this "
                    f"period) — pushed anyway (harmless/idempotent under their own true open_time), "
                    f"but this interval is scored as empty.".strip()
                )
                try:
                    self._push_candles(timeframe, candles)
                except ApiClientError:
                    pass  # best-effort — this interval's own status doesn't depend on this push
            weekend_note = "overlaps an ordinary weekend" if overlaps_weekend(range_start, range_end) \
                else "does not overlap an ordinary weekend"
            self._upsert_interval(
                data_type="CANDLE", timeframe=timeframe, range_start=range_start, range_end=range_end,
                status="EMPTY_UNCONFIRMED", record_count=0,
                evidence=f"{evidence_prefix} 0 in-range rows, no MT5 error; {weekend_note} "
                         f"(corroborating only, not decisive)".strip(),
            )
            return "EMPTY_UNCONFIRMED"

        suspected_cap = self._detect_candle_cap(timeframe, len(in_range))
        try:
            self._push_candles(timeframe, candles)
        except ApiClientError as exc:
            self._upsert_interval(
                data_type="CANDLE", timeframe=timeframe, range_start=range_start, range_end=range_end,
                status="FAILED", evidence=f"{evidence_prefix} push failed: {exc}".strip(),
            )
            return "FAILED"

        status = "SUSPECTED_TRUNCATED" if suspected_cap else "COMPLETED"
        evidence = f"{evidence_prefix} {'cap suspected at ' + str(len(in_range)) + ' rows' if suspected_cap else ''}".strip()
        self._upsert_interval(
            data_type="CANDLE", timeframe=timeframe, range_start=range_start, range_end=range_end,
            status=status, record_count=len(in_range), evidence=evidence or None,
        )
        return status

    def _fetch_push_and_record_candles_with_recheck(
        self, timeframe: str, range_start: datetime, range_end: datetime,
    ) -> str:
        status = self._fetch_push_and_record_candles(timeframe, range_start, range_end)
        if status != "EMPTY_UNCONFIRMED":
            return status

        # One independent re-check attempt on this same run (no separate
        # wall-clock budget is tracked — this always runs immediately
        # unless a resource stop has already ended the run, which is the
        # practical meaning of "if time permits" here) before ever
        # promoting to EMPTY_CONFIRMED.
        logger.info("re-checking an EMPTY_UNCONFIRMED candle interval (one independent second attempt)", extra={
            "timeframe": timeframe, "range_start": range_start.isoformat(), "range_end": range_end.isoformat(),
        })
        status2 = self._fetch_push_and_record_candles(timeframe, range_start, range_end, evidence_prefix="RECHECK")
        if status2 != "EMPTY_UNCONFIRMED":
            return status2

        self._upsert_interval(
            data_type="CANDLE", timeframe=timeframe, range_start=range_start, range_end=range_end,
            status="EMPTY_CONFIRMED", record_count=0,
            evidence="confirmed empty after one independent re-check",
        )
        return "EMPTY_CONFIRMED"

    def _detect_candle_cap(self, timeframe: str, count: int) -> bool:
        """Heuristic empirical-cap detector — CANDLE_FETCH_CHUNK_DAYS was
        already sized (in this project's prior M5 investigation) to stay
        safely under MT5's real per-call limit, so silent truncation
        within one chunk is expected to be rare. This only flags the
        specific pattern that would actually indicate one: two OR MORE
        differently-sized fetches for the same timeframe landing on the
        exact same large row count — a real, growing dataset essentially
        never does that by chance.
        """
        seen = self._candle_counts_seen.setdefault(timeframe, set())
        is_repeat_of_a_large_count = count >= 10_000 and count in seen
        seen.add(count)
        return is_repeat_of_a_large_count

    def _fetch_candles_chunked(self, timeframe: str, date_from: datetime, date_to: datetime) -> list[dict[str, Any]]:
        """Same chunking shape as runner.py's own `_fetch_candles_chunked`
        (composed here, not imported — that one is a bound CollectorApp
        method, and importing app.runner would pull in its own Mt5Client
        import; see module docstring). MT5's own per-call limits are
        identical regardless of which script calls get_candles.
        """
        chunk = timedelta(days=self.candle_fetch_chunk_days)
        all_candles: list[dict[str, Any]] = []
        cursor = date_from
        while cursor < date_to:
            nxt = min(cursor + chunk, date_to)
            all_candles.extend(self.client.get_candles(self.symbol, timeframe, cursor, nxt))
            cursor = nxt
        return all_candles

    def _push_candles(self, timeframe: str, candles: list[dict[str, Any]]) -> None:
        for i in range(0, len(candles), self.candle_push_batch_size):
            batch = candles[i:i + self.candle_push_batch_size]
            payload = build_candles_payload(self.symbol, timeframe, batch)
            self.api.post_candles(payload)

    # -- ticks -----------------------------------------------------------------

    def run_ticks(self) -> None:
        self.measure_representative_tick_day()

        completed = self._completed_ranges("TICK")
        cursor = self.requested_start_utc
        while cursor < self.requested_end_utc:
            chunk_end = min(cursor + timedelta(days=self._tick_chunk_days), self.requested_end_utc)

            if is_covered((cursor, chunk_end), completed):
                self._record_summary("TICK", None, "COMPLETED")
                cursor = chunk_end
                continue

            ok, reason = self.check_resources()
            if not ok:
                self._upsert_interval(
                    data_type="TICK", range_start=cursor, range_end=chunk_end,
                    status="INCOMPLETE", evidence=f"resource stop: {reason}",
                )
                logger.error("STOPPING CLEANLY — resource safety margin breached", extra={
                    "reason": reason, "chunk_start": cursor.isoformat(), "chunk_end": chunk_end.isoformat(),
                })
                self._record_summary("TICK", None, "INCOMPLETE")
                self._stopped_for_resources = True
                return

            status = self._fetch_push_and_record_ticks_with_recheck(cursor, chunk_end)
            self._record_summary("TICK", None, status)
            cursor = chunk_end

    def measure_representative_tick_day(self) -> None:
        """Before committing to the full multi-year range, fetch and time
        ONE representative day and log the actual row count/elapsed time
        prominently — the key scale signal the user explicitly wants
        surfaced early. Not itself recorded in the ledger: the chunked
        backfill below will fetch (and properly record) this same day
        again as part of its normal grid.
        """
        day_end = min(self.requested_start_utc + timedelta(days=1), self.requested_end_utc)
        started = time.monotonic()
        try:
            ticks = self.client.get_ticks(self.symbol, self.requested_start_utc, day_end)
        except Exception as exc:  # noqa: BLE001
            logger.error("representative tick-day measurement failed", extra={"error": str(exc)})
            return
        elapsed = time.monotonic() - started
        logger.warning("REPRESENTATIVE TICK DAY MEASURED", extra={
            "date": self.requested_start_utc.date().isoformat(),
            "row_count": len(ticks), "elapsed_seconds": round(elapsed, 2),
        })

    def _fetch_push_and_record_ticks(
        self, range_start: datetime, range_end: datetime, evidence_prefix: str = "",
    ) -> str:
        self._upsert_interval(
            data_type="TICK", range_start=range_start, range_end=range_end,
            status="PENDING", evidence=evidence_prefix or None,
        )

        try:
            ticks = self.client.get_ticks(self.symbol, range_start, range_end)
        except Exception as exc:  # noqa: BLE001 — treated as a discovered per-call cap; see module docstring
            old_days = self._tick_chunk_days
            self._tick_chunk_days = max(self._tick_chunk_days / 2, TICK_MIN_CHUNK_DAYS)
            logger.warning("tick fetch raised an error — shrinking chunk size", extra={
                "old_chunk_days": old_days, "new_chunk_days": self._tick_chunk_days, "error": str(exc),
            })
            self._upsert_interval(
                data_type="TICK", range_start=range_start, range_end=range_end, status="FAILED",
                evidence=f"{evidence_prefix} MT5 error: {exc}; shrinking chunk to "
                         f"{self._tick_chunk_days:.4f} days".strip(),
            )
            return "FAILED"

        if not ticks:
            weekend_note = "overlaps an ordinary weekend" if overlaps_weekend(range_start, range_end) \
                else "does not overlap an ordinary weekend"
            self._upsert_interval(
                data_type="TICK", range_start=range_start, range_end=range_end,
                status="EMPTY_UNCONFIRMED", record_count=0,
                evidence=f"{evidence_prefix} 0 rows, no MT5 error; {weekend_note} "
                         f"(corroborating only, not decisive)".strip(),
            )
            return "EMPTY_UNCONFIRMED"

        suspected_cap = self._detect_tick_cap(len(ticks))
        try:
            self._push_ticks(ticks)
        except ApiClientError as exc:
            self._upsert_interval(
                data_type="TICK", range_start=range_start, range_end=range_end, status="FAILED",
                evidence=f"{evidence_prefix} push failed: {exc}".strip(),
            )
            return "FAILED"

        status = "SUSPECTED_TRUNCATED" if suspected_cap else "COMPLETED"
        evidence = f"{evidence_prefix} {'cap suspected at ' + str(len(ticks)) + ' rows' if suspected_cap else ''}".strip()
        self._upsert_interval(
            data_type="TICK", range_start=range_start, range_end=range_end,
            status=status, record_count=len(ticks), evidence=evidence or None,
        )
        return status

    def _fetch_push_and_record_ticks_with_recheck(self, range_start: datetime, range_end: datetime) -> str:
        status = self._fetch_push_and_record_ticks(range_start, range_end)
        if status != "EMPTY_UNCONFIRMED":
            return status

        logger.info("re-checking an EMPTY_UNCONFIRMED tick interval (one independent second attempt)", extra={
            "range_start": range_start.isoformat(), "range_end": range_end.isoformat(),
        })
        status2 = self._fetch_push_and_record_ticks(range_start, range_end, evidence_prefix="RECHECK")
        if status2 != "EMPTY_UNCONFIRMED":
            return status2

        self._upsert_interval(
            data_type="TICK", range_start=range_start, range_end=range_end,
            status="EMPTY_CONFIRMED", record_count=0,
            evidence="confirmed empty after one independent re-check",
        )
        return "EMPTY_CONFIRMED"

    def _detect_tick_cap(self, count: int) -> bool:
        is_repeat = count >= 50_000 and count in self._tick_counts_seen
        self._tick_counts_seen.add(count)
        return is_repeat

    def _push_ticks(self, ticks: list[dict[str, Any]]) -> None:
        for i in range(0, len(ticks), TICK_PUSH_BATCH_SIZE):
            batch = ticks[i:i + TICK_PUSH_BATCH_SIZE]
            payload = build_ticks_payload(self.symbol, None, None, None, batch)
            self.api.post_ticks(payload)

    # -- summary -----------------------------------------------------------------

    def print_summary(self) -> None:
        separator = "=" * 72
        print(separator)
        print(f"GOLD BACKFILL SUMMARY — symbol={self.symbol}")
        print(f"Requested range: {self.requested_start_utc.isoformat()} -> {self.requested_end_utc.isoformat()}")
        print(f"Frozen end timestamp (this run): {self.requested_end_utc.isoformat()}")
        for timeframe in ALL_CANDLE_TIMEFRAMES:
            counts = self._summary.get(("CANDLE", timeframe), {})
            print(f"  CANDLE {timeframe}: {counts if counts else '(nothing to do)'}")
        tick_counts = self._summary.get(("TICK", None), {})
        print(f"  TICK: {tick_counts if tick_counts else '(nothing to do)'}")
        if self._stopped_for_resources:
            print("STOPPED EARLY — a resource safety margin was breached; see logs for details.")
        print(separator, flush=True)
        logger.info("backfill summary", extra={"summary": {
            f"{dt}:{tf}": counts for (dt, tf), counts in self._summary.items()
        }, "stopped_for_resources": self._stopped_for_resources})


def main() -> int:
    try:
        from dotenv import load_dotenv
        load_dotenv()  # no-op if no .env file is present; never overrides real env vars
    except ImportError:
        pass

    try:
        config = Config.from_env()
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2

    logger_root = configure_logging(config.log_level, config.log_format)
    logger_root.info("backfill_gold_history starting", extra={"symbol": SYMBOL})

    # Late imports — see module docstring. Only these two transitively pull
    # in the Windows-only MetaTrader5 package.
    from app.api_client import ApiClient
    from app.mt5_client import Mt5Client
    from app.runner import CANDLE_FETCH_CHUNK_DAYS, CANDLE_PUSH_BATCH_SIZE

    client = Mt5Client(config)
    result = client.connect()
    if not result.ok:
        print(f"MT5 connection failed: {result.error_message} (code {result.error_code})", file=sys.stderr)
        return 2

    api = ApiClient(config)

    requested_start_utc = beirut_local_to_utc(REQUESTED_START_BEIRUT)
    requested_end_utc = datetime.now(tz=timezone.utc)
    logger_root.warning("FROZEN BACKFILL WINDOW FOR THIS RUN", extra={
        "requested_start_beirut": REQUESTED_START_BEIRUT,
        "requested_start_utc": requested_start_utc.isoformat(),
        "requested_end_utc": requested_end_utc.isoformat(),
    })

    job = GoldBackfillJob(
        client=client,
        api=api,
        symbol=SYMBOL,
        requested_start_utc=requested_start_utc,
        requested_end_utc=requested_end_utc,
        candle_fetch_chunk_days=CANDLE_FETCH_CHUNK_DAYS,
        candle_push_batch_size=CANDLE_PUSH_BATCH_SIZE,
        local_path=str(Path(__file__).resolve().parent),
        candles_only="--candles-only" in sys.argv[1:],
    )

    try:
        return job.run()
    finally:
        client.disconnect()


if __name__ == "__main__":
    sys.exit(main())
