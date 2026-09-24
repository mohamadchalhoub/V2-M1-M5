"""The Phase 2 main loop: connect, push to the backend, print locally,
reconnect on failure, shut down cleanly.

Three cadences share one loop rather than separate threads: every tick
pushes an account snapshot (idempotent on captured_at); every
TRADE_SYNC_INTERVAL_SECONDS, a trade-sync runs; every
CANDLE_SYNC_INTERVAL_SECONDS (historical chart reconstruction phase, off
unless CANDLE_SYMBOLS is set), a candle-sync runs. All three read the
server's own cursor rather than local state, so a process restart can never
desync any of them.
"""
from __future__ import annotations

import logging
import signal
import threading
import time
from datetime import datetime, timedelta, timezone
from types import FrameType
from typing import Any

from app.api_client import ApiClient, ApiClientError
from app.api_mapper import (
    build_candles_payload,
    build_permissions_payload,
    build_snapshot_payload,
    build_symbol_metadata_payload,
    build_ticks_payload,
    build_trades_payload,
)
from app.config import CANDLE_DURATION_BY_TIMEFRAME, Config
from app.executor import DemoAccountRequiredError, Executor
from app.formatting import (
    format_account_summary,
    format_connection_status,
    format_deals_table,
    format_positions_table,
)
from app.mt5_client import Mt5Client, PositionsUnavailable, stored_candle_time_to_true_utc

logger = logging.getLogger("collector.runner")

COLLECTOR_VERSION = "0.2.0"

# Distinguishes "never observed" from an observed None ("could not read").
_UNSEEN = object()


def _as_utc_datetime(value: Any) -> datetime | None:
    """An aware UTC datetime from an ISO string or a datetime, else None.

    None rather than an exception for anything unrecognised: the callers are
    permission and session checks, where "could not tell" must block, and an
    exception would instead escape into the main loop.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        # A naive value is not safe to guess at: it could be UTC or broker
        # local, and the two differ by hours.
        return None
    return parsed.astimezone(timezone.utc)

# xauusd-m1-m5-rsi-threshold-v2 -- the only symbol this project's strategy
# trades. Named here rather than read from config so it cannot drift from the
# backend's own frozen SPEC.symbol.
M1M5_SYMBOL = "XAUUSD"

# Engine B's magic number. Distinct from every Engine A magic, which is what
# keeps Engine A's Friday liquidation from selecting a Telegram position, and
# what lets the reconciliation below select only Telegram ones.
TELEGRAM_MAGIC = 262610210
# How far back to look for closing deals when establishing a realised result.
TELEGRAM_RECONCILE_DEAL_DAYS = 3

# xauusd-sar-v1's own magic (Engine A replacement) -- see safety-constants.ts
# for the full list this must stay disjoint from.
SAR_MAGIC = 262610220
SAR_RECONCILE_DEAL_DAYS = 3


def _position_magic(position: dict[str, Any]) -> int | None:
    """MT5's magic number for a position OR a deal.

    Despite the name (kept for the existing position call sites),
    this reads the same "raw" shape `get_open_positions()` and
    `get_deals_since()`/`get_recent_deals()` both produce, and MT5 carries
    magic on deals exactly the same way it does on positions - it is set
    once, on the order, and every deal that order produces (the opening fill
    AND the broker's own auto-close on hitting TP/SL) inherits it. That is
    what makes magic the reliable way to attribute a CLOSING deal to this
    engine: unlike the order comment, which a broker's auto-close does not
    reliably carry forward from the original order, magic survives it.

    `get_open_positions()`/`get_deals_since()` flatten the terminal's tuple
    into a friendlier dict but keep the magic only inside `raw`. Reading it
    from the top level silently yields None, which for a position would make
    reconciliation see an account with no Telegram positions and wrongly
    conclude a live leg had closed; for a deal it would make every closing
    deal invisible and leave a correctly-detected closure with no realised
    P/L attached (see _push_telegram_reconciliation's own comment on this).
    """
    raw = position.get("raw")
    if isinstance(raw, dict):
        magic = raw.get("magic")
        if isinstance(magic, int):
            return magic
    magic = position.get("magic")
    return magic if isinstance(magic, int) else None


def _level_or_none(value: Any) -> float | None:
    """MT5 reports "no stop loss" as 0.0 rather than null."""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return None if number == 0.0 else number



# How recent a tick must be for the broker session to count as OPEN.
#
# Generous on purpose. This is not the quote-freshness gate -- the backend
# applies its own, tighter one before acting on a price. This answers the much
# coarser question "is the market trading at all", where a quiet minute in thin
# conditions must not read as a closed market and trigger a weekend-style
# entry block.
M1M5_SESSION_TICK_MAX_AGE_SECONDS = 120

# How long the one-second execution pass waits for the MT5 lock before giving
# up for this second. Short, so a busy main-loop cycle costs at most one pass
# rather than stretching the cadence; the order stays PENDING, unclaimed, and
# is picked up by the next pass.
M1M5_EXECUTION_LOCK_TIMEOUT_SECONDS = 0.25

# Same reasoning as M1M5's, applied to xauusd-sar-v1's fast pass.
SAR_EXECUTION_LOCK_TIMEOUT_SECONDS = 0.25

# Trend-breakout's canonical instrument identifiers — must match the
# backend's own `TREND_BREAKOUT_INSTRUMENTS` (instrument-config.ts) exactly;
# this is the internal identity used in the URL path segment, never the raw
# broker symbol string (the backend resolves broker symbol on its own side).
TREND_BREAKOUT_INSTRUMENTS: tuple[str, ...] = ("EURUSD", "XAUUSD")
TRADE_SYNC_INTERVAL_SECONDS = 60
# Historical chart reconstruction phase — how many candles go in one
# /collector/candles push. A multi-year M5 backfill is hundreds of
# thousands of rows; batching keeps any single HTTP request (and the
# backend's own per-request upsert loop) to a bounded size rather than one
# giant payload.
CANDLE_PUSH_BATCH_SIZE = 2000
# Re-fetched every candle-sync tick alongside whatever's new, in case the
# most recently stored bar was still forming (and therefore incomplete) the
# last time it was pushed.
CANDLE_SYNC_OVERLAP_BARS = 3
# MT5's copy_rates_range() rejects an overly large request outright (found
# live, this session: a ~1000-day M5 request — ~288k bars — returned None
# with "Terminal: Invalid params"; the same call for a coarser timeframe
# over the same date range succeeded). Fetching in bounded date chunks
# regardless of timeframe sidesteps whatever the terminal's own per-call
# limit actually is, at the cost of more (still local, still fast) calls —
# never fewer real candles, never a fabricated one.
CANDLE_FETCH_CHUNK_DAYS = 30
# Ichimoku needs 78 closed candles minimum (26 displacement + 52 Senkou B
# period — see technical-analysis-report.service.ts's own comment) before
# it can compute anything at all. CANDLE_INITIAL_SYNC_DAYS is one global
# setting shared by every timeframe (currently 1000d in this deployment's
# own collector/.env, sized for M5/M15/H1/M30/H4/D1's needs) — raising it
# globally to cover W1/MN1 would multiply the M5 backfill by the same
# factor for no reason, since M5 already has far more than 78 candles in
# 1000 days. This per-timeframe FLOOR only ever pushes W1/MN1's own
# first-ever backfill further back; every other timeframe is unaffected
# (max() with 0 is a no-op for any timeframe not listed here).
_MIN_INITIAL_SYNC_DAYS_BY_TIMEFRAME: dict[str, int] = {
    "W1": 1825,   # ~5 years / ~260 weekly candles — well past the 78 minimum
    "MN1": 5475,  # ~15 years / ~180 monthly candles — same reasoning
}
# M1 is ~1,440 bars per day: a first-ever M1 sync (no stored rows) is capped
# so a newly configured symbol cannot trigger a multi-year M1 download from
# the live loop. Deep M1 history belongs to backfill_gold_history.py.
_MAX_INITIAL_SYNC_DAYS_BY_TIMEFRAME: dict[str, int] = {"M1": 30}
# Gold historical-data-collection project — get_instrument_verification()
# reads broker-reported specs (volume/point/contract size/swap/expiration)
# that essentially never change intraday; once at startup (see
# _attempt_connect) plus a slow daily refresh is enough to catch a broker-
# side spec change without adding meaningful load to either MT5 or the
# backend.
SYMBOL_METADATA_SYNC_INTERVAL_SECONDS = 86400
# Gold historical-data-collection project — ongoing (forward-looking) tick
# sync: a small, recent window pulled every cycle, independent of and never
# gating the one-off historical `backfill_gold_history.py` script. Wired
# and running even while historical copy_ticks_range calls for OLD dates
# are confirmed failing (diagnosed 2026-09-13: hard failures for ~2024
# dates, but clean — if occasionally slow — empty-or-real responses for
# recent dates) — this exists so the moment real tick data becomes
# available going forward, it's captured, with zero code change needed.
#
# ISOLATION (revised 2026-09-13 — this used to be a disclosed trade-off
# instead of a fix; live evidence made that no longer acceptable). The same
# live diagnosis found copy_ticks_range/copy_ticks_from can each take up to
# ~106s to hard-fail. Originally this ran inline in the main loop, so a
# failing tick call froze snapshot/candle/trade-sync AND the shutdown-signal
# check for the full ~106s every time it happened. It now runs on its own
# background thread (see _maybe_start_tick_sync), serialized against the
# main loop's own MT5 calls with `_mt5_call_lock` — the MetaTrader5 Python
# module is documented as not thread-safe for concurrent calls on one
# connection, so true parallel MT5 calls are never allowed, but the main
# loop only does a NON-BLOCKING lock attempt: if tick sync is mid-call, the
# main loop skips that one ~poll_interval_seconds cycle's MT5 work and
# checks again next cycle, rather than blocking synchronously for the
# tick call's entire duration. Net effect: the loop keeps cycling and stays
# responsive to shutdown throughout a slow/failing tick call, and normal
# work resumes on the very next cycle once the tick call finishes — instead
# of one uninterruptible ~106s freeze.
TICK_SYNC_INTERVAL_SECONDS = 300
# Bounded failure cooldown ("do not repeat the same unsuccessful query
# every five minutes indefinitely"): each consecutive FAILED tick-sync
# attempt (a real MT5/push error — EMPTY_UNCONFIRMED does not count, that's
# a legitimate "asked, got zero" answer, not a failure) doubles the
# effective wait before the next attempt, capped here. Evidence is still
# recorded on every attempt (including the ones this skips due to
# backoff — those simply don't happen, they are not disguised as
# untried). Any non-failure result resets the counter back to the normal
# TICK_SYNC_INTERVAL_SECONDS cadence.
TICK_SYNC_MAX_BACKOFF_SECONDS = 3600
# Small overlap so a tick landing right at a previous cycle's boundary is
# never silently skipped — mirrors CANDLE_SYNC_OVERLAP_BARS' own reasoning.
TICK_SYNC_OVERLAP_SECONDS = 30
# Provenance (Preserve source provenance, gold-collection plan): distinct
# from the one-off backfill script's own "gold_backfill_script" source, so
# the BackfillInterval ledger always shows which process actually attempted
# a given range.
TICK_SYNC_SOURCE = "collector_live_sync"

# xauusd-m1-rsi-retest-extremes-v1 — the LIVE tick stream that feeds the
# strategy's intrabar RSI, deliberately separate from the archival tick sync
# above.
#
# The archival sync runs every TICK_SYNC_INTERVAL_SECONDS (300s) on a
# background thread because a tick call can hang for ~106s. That cadence is
# right for building history and useless for trading: a signal this strategy
# can only act on for about a minute would be five minutes stale before the
# backend ever saw the tick that produced it.
#
# So this second path fetches a SMALL, recent window (seconds, not minutes)
# for one symbol on the MAIN loop, at poll_interval_seconds cadence. A window
# this narrow returns quickly, and the main loop's existing non-blocking lock
# discipline is unchanged. The ticks land in the same deduplicated store via
# the same /collector/ticks endpoint, so the archival sync and this one can
# freely overlap — whichever sees a tick first, the other's copy is dropped
# by the database's own uniqueness constraint.
#
# Honest limitation: delivery latency is up to one poll interval, so the
# backend observes a crossing a few seconds after it happened. No crossing is
# MISSED (copy_ticks_range returns every tick in the window), but the
# strategy's own signal-age and entry-deviation guards may legitimately
# reject a signal that arrived too late to still be the event the rules
# described. That is intended behaviour, not a defect.
RSI_TICK_SYMBOL = "XAUUSD"
# The observation cadence the strategy requires: read XAUUSD once per SECOND.
#
# This runs on its own dedicated thread rather than on the main poll loop,
# because the main loop's interval also governs snapshots, trades, candles and
# every other execution poll — dropping that to one second would change
# unrelated EURUSD collection behaviour, which is explicitly out of scope.
#
# The thread serialises its MT5 calls against everything else through the same
# `_mt5_call_lock` the rest of this file uses, since the MetaTrader5 module is
# not thread-safe for concurrent calls on one connection. It uses a BOUNDED
# blocking acquire so that a slow main-loop cycle delays an observation rather
# than silently skipping it, and a genuinely stuck lock skips the tick instead
# of piling threads up.
RSI_OBSERVATION_INTERVAL_SECONDS = 1.0
RSI_OBSERVATION_LOCK_TIMEOUT_SECONDS = 0.75
# How many incremental ticks one observation will pull. A second of gold
# rarely produces more than a handful; this is headroom, not an expectation.
RSI_OBSERVATION_TICK_COUNT = 2000
# How far back the cursor starts on the very first observation of a run.
RSI_OBSERVATION_COLD_START_SECONDS = 10
# How far back each fetch reaches. Comfortably wider than one poll interval
# so a slow cycle cannot leave a hole; the overlap costs nothing because
# duplicates are rejected at the database.
RSI_TICK_WINDOW_SECONDS = 90



class CollectorApp:
    def __init__(self, config: Config, client: Mt5Client, api: ApiClient, executor: Executor) -> None:
        self._config = config
        self._client = client
        self._api = api
        self._executor = executor
        self._stop_event = threading.Event()
        self._last_trade_sync_at: datetime | None = None
        self._last_candle_sync_at: datetime | None = None
        self._last_symbol_metadata_sync_at: datetime | None = None
        self._last_tick_sync_at: datetime | None = None
        # Isolation: serializes every MT5 call this app makes (main loop
        # AND the tick-sync background thread) against each other, never
        # against a truly external process — see TICK_SYNC_INTERVAL_SECONDS'
        # own comment for why concurrent calls on one connection aren't safe.
        self._mt5_call_lock = threading.Lock()
        self._tick_sync_thread: threading.Thread | None = None
        # One-second XAUUSD observation loop (see RSI_OBSERVATION_INTERVAL_SECONDS).
        self._rsi_observation_thread: threading.Thread | None = None
        self._rsi_cursor_msc: int | None = None
        self._rsi_last_pushed_msc: int | None = None
        self._rsi_observations = 0
        self._rsi_ticks_pushed = 0
        self._rsi_duplicate_skips = 0
        self._rsi_last_observation_at: datetime | None = None
        self._rsi_cadence_samples: list[float] = []
        self._tick_sync_consecutive_failures = 0
        # The terminal's algo-trading switch, as last seen. A sentinel rather
        # than None, because None is itself a state worth logging ("could not
        # read it") and the first observation must always be recorded.
        self._last_terminal_trade_allowed: object = _UNSEEN

    def install_signal_handlers(self) -> None:
        signal.signal(signal.SIGINT, self._handle_signal)
        signal.signal(signal.SIGTERM, self._handle_signal)

    def _handle_signal(self, signum: int, frame: FrameType | None) -> None:
        logger.info("shutdown signal received", extra={"signal": signum})
        self._stop_event.set()

    def run(self) -> int:
        logger.info("collector starting", extra={
            "poll_interval_seconds": self._config.poll_interval_seconds,
            "trade_sync_interval_seconds": TRADE_SYNC_INTERVAL_SECONDS,
            "explicit_credentials": self._config.has_explicit_credentials,
            "account_id": self._config.collector_account_id,
            "api_base_url": self._config.collector_api_base_url,
            "candle_symbols": self._config.candle_symbols,
            "candle_timeframes": self._config.candle_timeframes if self._config.candle_symbols else (),
            "autonomous_execution_enabled": self._config.autonomous_execution_enabled,
            "gold_execution_enabled": self._config.gold_execution_enabled,
            "trend_breakout_execution_enabled": self._config.trend_breakout_execution_enabled,
            "rsi_execution_enabled": self._config.rsi_execution_enabled,
            "m1m5_execution_enabled": self._config.m1m5_execution_enabled,
            "sar_execution_enabled": getattr(self._config, "sar_execution_enabled", False),
            "telegram_engine_execution_enabled": getattr(self._config, "telegram_engine_execution_enabled", False),
        })

        backoff = self._config.reconnect_initial_backoff_seconds
        if self._tick_stream_wanted():
            self._start_rsi_observation_loop()
        try:
            while not self._stop_event.is_set():
                if not self._mt5_call_lock.acquire(blocking=False):
                    # Isolation fix: the tick-sync thread is mid MT5-call.
                    # Skip this cycle's MT5 work rather than block waiting
                    # for it — see TICK_SYNC_INTERVAL_SECONDS' own comment.
                    logger.info("main loop cycle skipped — tick sync holds the MT5 connection")
                    self._maybe_start_tick_sync()
                    self._stop_event.wait(timeout=self._config.poll_interval_seconds)
                    continue

                try:
                    if not self._client.is_connected():
                        connected, backoff = self._attempt_connect(backoff)
                        if not connected:
                            continue

                    self._push_and_print_snapshot()
                    if self._trade_sync_due():
                        self._sync_trades()
                    if self._candle_sync_due():
                        self._sync_candles()
                    if self._symbol_metadata_sync_due():
                        self._sync_symbol_metadata()
                    if self._config.autonomous_execution_enabled:
                        self._poll_and_execute_pending_order()
                    if self._config.gold_execution_enabled:
                        self._poll_and_execute_pending_gold_order()
                        self._poll_and_execute_gold_close_request()
                        self._poll_and_execute_gold_restore_protection_request()
                    if self._config.m1m5_execution_enabled:
                        # Permissions FIRST, then the order poll. The backend
                        # refuses to submit without a recent permission report,
                        # so reporting after the poll would mean the first
                        # candidate of every restart is refused for a reason
                        # that had already been fixed.
                        self._push_m1m5_mt5_snapshot()
                        self._poll_and_execute_pending_m1m5_order()
                        # Closes are polled on the same flag as entries. That
                        # means turning this flag off while a position is open
                        # leaves it unmanaged, including through a Friday --
                        # so the way to stop NEW entries without abandoning an
                        # open one is the backend kill switch, which keeps
                        # reconciliation and liquidation running.
                        self._poll_and_execute_m1m5_close_request()
                        self._poll_and_execute_m1m5_protection_request()
                    if getattr(self._config, "sar_execution_enabled", False):
                        # Engine A REPLACEMENT, in its own try — the same
                        # isolation Engine B gets below. A SAR poll, execution
                        # or reconciliation failure must never stop the frozen
                        # RSI strategy's residual management or Engine B.
                        try:
                            self._poll_and_execute_pending_sar_order()
                        except Exception as exc:  # noqa: BLE001
                            logger.warning("xauusd-sar pass failed, continuing", extra={"error": str(exc)})
                    # `getattr` with a default, not a direct attribute read:
                    # Engine A's existing tests build their own config doubles,
                    # and adding a field to the real Config must not make those
                    # doubles raise inside the shared loop. Absent means off,
                    # which is the safe default for an execution flag.
                    if getattr(self._config, "telegram_engine_execution_enabled", False):
                        # Engine B, in its OWN try. A Telegram ingestion,
                        # execution or reconciliation failure must never stop
                        # Engine A monitoring or placing its orders, so nothing
                        # below is allowed to escape into the shared loop.
                        try:
                            self._push_telegram_reconciliation()
                            self._poll_and_execute_pending_telegram_leg()
                        except Exception as exc:  # noqa: BLE001
                            logger.warning("telegram engine pass failed, continuing", extra={"error": str(exc)})
                    if self._config.rsi_execution_enabled:
                        # Tick observation now runs on its own one-second
                        # thread (see _start_rsi_observation_loop); only the
                        # order poll happens here.
                        self._poll_and_execute_pending_rsi_order()
                    if self._config.trend_breakout_execution_enabled:
                        # Both instruments go live together (confirmed
                        # rollout decision) — looped every cycle, never
                        # gated independently per instrument here (the
                        # backend's own execution mode / kill switch /
                        # stop-new-entries are the actual per-decision
                        # gates; this loop just polls both routes).
                        for instrument in TREND_BREAKOUT_INSTRUMENTS:
                            self._poll_and_execute_pending_trend_breakout_order(instrument)
                            self._poll_and_execute_trend_breakout_close_request(instrument)
                finally:
                    self._mt5_call_lock.release()

                self._maybe_start_tick_sync()
                backoff = self._config.reconnect_initial_backoff_seconds
                self._stop_event.wait(timeout=self._config.poll_interval_seconds)
        finally:
            logger.info("collector shutting down, disconnecting from terminal")
            if self._tick_sync_thread is not None and self._tick_sync_thread.is_alive():
                # Best-effort only — a tick call can take up to ~106s and
                # shutdown must not hang that long. The thread is a daemon
                # thread, so if it's still running when the process exits
                # the interpreter tears it down; this join just gives a
                # currently-fast/finishing call a brief chance to record its
                # own outcome (and release the lock) before disconnect().
                self._tick_sync_thread.join(timeout=5)
            self._client.disconnect()

        logger.info("collector stopped cleanly")
        return 0

    def _note_terminal_trade_allowed(self, terminal: dict[str, Any] | None) -> None:
        """Logs the moment the terminal's algo-trading switch changes.

        On this deployment the switch has been observed ON after one terminal
        launch and OFF after an identical launch, with nothing in the
        terminal's own journal explaining either. Without the time of the
        change there is nothing to correlate it with. This records exactly
        that, once per change rather than once per cycle, so it stays
        readable.

        OFF is a WARNING: with algo trading off every order is refused by the
        terminal, and the backend's readiness gate blocks entries until it
        comes back.
        """
        allowed = (terminal or {}).get("trade_allowed")
        allowed = None if allowed is None else bool(allowed)
        previous = self._last_terminal_trade_allowed
        if allowed == previous:
            return
        self._last_terminal_trade_allowed = allowed
        context = {"from": None if previous is _UNSEEN else previous, "to": allowed}
        if allowed is False:
            logger.warning("terminal algo trading is OFF -- every order will be refused until it is re-enabled", extra=context)
        elif allowed is None:
            logger.warning("terminal algo trading state could not be read", extra=context)
        else:
            logger.info("terminal algo trading is ON", extra=context)

    def _deals_lookup_adapter(self, since):
        """Adapts `Mt5Client.get_deals_since()`'s dicts to the flat
        `{"symbol", "magic", "ticket", "volume", "price"}` shape
        `executor.py`'s `find_recent_deal` expects. `get_deals_since()`
        doesn't surface `magic` as a top-level field (it wasn't needed by
        this project's own analytics use of it), but preserves the full raw
        deal under `"raw"`, which does — extracted here rather than
        changing `get_deals_since()`'s own established return shape for
        every other caller.
        """
        deals = self._client.get_deals_since(since)
        return [{**d, "magic": (d.get("raw") or {}).get("magic")} for d in deals]

    def _attempt_connect(self, backoff: float) -> tuple[bool, float]:
        result = self._client.connect()
        if result.ok:
            logger.info("connected to MT5 terminal")
            if self._config.autonomous_execution_enabled:
                # Points the executor at THIS connection's real handle
                # (native import or RPyC bridge proxy) — not knowable at
                # construction time, and re-pointed on every reconnect
                # since a bridge reconnect gets a genuinely new proxy object.
                self._executor.set_mt5_module(self._client.get_mt5_module())
                # Audit finding: wires deal-history reconciliation (see
                # executor.py's own `set_deals_lookup` comment) through
                # `Mt5Client.get_deals_since`, which already handles a real,
                # verified-live MT5-under-Wine quirk (history_deals_get()
                # needs broker-timezone-aware epoch seconds, not datetime
                # objects) — reusing it here instead of a second,
                # independent implementation of the same lookup.
                self._executor.set_deals_lookup(self._deals_lookup_adapter)
            # Once per successful connect (covers both process startup and
            # any later reconnect) — see SYMBOL_METADATA_SYNC_INTERVAL_SECONDS'
            # own comment for why a slow periodic refresh (wired into the
            # main loop below) is enough on top of this for a connection
            # that stays up for a long time without ever reconnecting.
            self._sync_symbol_metadata()
            return True, self._config.reconnect_initial_backoff_seconds

        logger.warning(
            "MT5 connection failed, will retry",
            extra={"error_code": result.error_code, "error_message": result.error_message,
                   "retry_in_seconds": backoff},
        )
        self._stop_event.wait(timeout=backoff)
        next_backoff = min(backoff * 2, self._config.reconnect_max_backoff_seconds)
        return False, next_backoff

    def _push_and_print_snapshot(self) -> None:
        terminal = self._client.get_terminal_info()
        self._note_terminal_trade_allowed(terminal)
        mt5_connected = terminal.get("connected") if terminal else None
        last_error = None if mt5_connected else self._client.last_error()[1]
        account = self._client.get_account_info()
        # A failed positions fetch aborts this snapshot rather than sending
        # an empty list. The backend treats the list as authoritative and
        # closes anything missing from it, so "we could not ask" must never
        # be reported as "there is nothing open".
        try:
            positions = self._client.get_open_positions()
        except PositionsUnavailable as exc:
            logger.error(
                "skipping this snapshot cycle: open positions could not be read, and an empty "
                "list would be treated as authoritative by the backend",
                extra={"error": str(exc)},
            )
            print("=" * 72)
            print("SNAPSHOT SKIPPED - could not read open positions from the broker.")
            print(f"  {exc}")
            print("  Nothing was reported, so no position can be wrongly marked closed.")
            print("=" * 72, flush=True)
            return
        # Best-effort — a fresh, genuine bid/ask read on every snapshot tick
        # (this method's own 10s cadence) closes the gap between this
        # system's coarsest number (an M5 candle close, up to ~10 minutes
        # stale by the time it's synced) and what a trader sees live on
        # their own terminal. `None` (e.g. no candle_symbols configured, or
        # a transient MT5 error) is a safe no-op — the backend/technical-
        # analysis layer falls back to the candle-based price exactly as
        # before this existed.
        # One quote per configured candle symbol (gold collection alongside
        # EURUSD). The first symbol is still sent as `liveTick`, exactly as
        # before, for existing consumers; all are also sent as `liveTicks`.
        live_ticks = [t for t in (self._client.get_live_tick(s) for s in self._config.candle_symbols) if t is not None]
        live_tick = live_ticks[0] if live_ticks and live_ticks[0]["symbol"] == self._config.candle_symbols[0] else None

        payload = build_snapshot_payload(
            account_id=self._config.collector_account_id,
            account=account,
            positions=positions,
            mt5_connected=mt5_connected,
            last_error=last_error,
            collector_version=COLLECTOR_VERSION,
            # Read fresh each cycle: an operator can disable algorithmic
            # trading at any moment, so a cached value would let the backend
            # act on a permission that no longer holds.
            terminal_info=self._client.get_terminal_info(),
            live_tick=live_tick,
            live_ticks=live_ticks,
        )
        try:
            self._api.post_snapshot(payload)
            push_ok = True
        except ApiClientError as exc:
            logger.warning("snapshot push failed, will retry next tick", extra={"error": str(exc)})
            push_ok = False

        separator = "=" * 72
        print(separator)
        print(format_connection_status(True, mt5_connected, account.get("server") if account else None))
        print(format_account_summary(account))
        print(format_positions_table(positions))
        print(f"BACKEND PUSH: {'ok' if push_ok else 'FAILED — see logs'}")
        print(separator, flush=True)

        logger.info("snapshot cycle complete", extra={
            "mt5_connected": mt5_connected,
            "open_positions": len(positions),
            "push_ok": push_ok,
        })

    def _poll_and_execute_pending_order(self) -> None:
        """Autonomous demo trading (v2), Phase 6 — the collector asking the
        backend "is there anything approved for me to execute," and, if so,
        actually placing it. Only ever reached when
        autonomous_execution_enabled is explicitly true (an existing
        deployment's behavior is otherwise unchanged). Every failure mode
        here is caught and logged, never left to crash the main loop — the
        SAME posture collector-ingress.controller.ts's own rule-evaluation
        step already takes on the backend side ("one component's failure
        must never take down another").
        """
        try:
            response = self._api.get_pending_order(self._config.collector_account_id)
        except ApiClientError as exc:
            logger.warning("pending-order poll failed, will retry next tick", extra={"error": str(exc)})
            return

        order = response.get("order")
        if not order:
            return

        logger.info("pending order claimed, attempting execution", extra={
            "decision_id": order["decisionId"], "side": order["side"], "volume": order["volume"],
        })

        try:
            result = self._executor.send_bracket_order(
                side=order["side"],
                volume=order["volume"],
                stop_loss_points=order["stopLossPoints"],
                take_profit_points=order["takeProfitPoints"],
                magic=order["magic"],
                comment=order["comment"],
            )
        except DemoAccountRequiredError as exc:
            # The single most severe event this process can encounter — logged
            # at CRITICAL specifically so it stands out from ordinary warnings,
            # and still reported back (never left stuck as SENT forever), but
            # never silently swallowed like an ordinary execution failure.
            logger.critical("DEMO ACCOUNT CHECK FAILED — refusing to trade", extra={"error": str(exc)})
            self._report_execution_result(order["decisionId"], ok=False, error_message=str(exc))
            return
        except Exception as exc:  # noqa: BLE001 — must never crash the main loop over this
            logger.error("order execution raised an unexpected error", extra={"error": str(exc)})
            self._report_execution_result(order["decisionId"], ok=False, error_message=str(exc))
            return

        logger.info("order execution result", extra={
            "decision_id": order["decisionId"], "ok": result.ok, "ticket": result.ticket,
            "retcode": result.retcode, "error": result.error_message,
        })
        self._report_execution_result(
            order["decisionId"], ok=result.ok, ticket=result.ticket,
            filled_price=result.price, error_message=result.error_message,
        )

    def _report_execution_result(
        self, decision_id: str, *, ok: bool, ticket: int | None = None,
        filled_price: float | None = None, error_message: str | None = None,
    ) -> None:
        payload: dict = {"ok": ok}
        if ticket is not None:
            payload["ticket"] = ticket
        if filled_price is not None:
            payload["filledPrice"] = filled_price
        if error_message is not None:
            payload["errorMessage"] = error_message
        try:
            self._api.post_execution_result(self._config.collector_account_id, decision_id, payload)
        except ApiClientError as exc:
            # The order itself already happened (or definitively failed) on
            # MT5's side by this point — a failure to REPORT that back is a
            # visibility problem, not a trading-safety one, but it does mean
            # the decision row stays stuck as SENT until this is noticed.
            logger.error("failed to report execution result back to backend", extra={"decision_id": decision_id, "error": str(exc)})

    def _tick_stream_wanted(self) -> bool:
        """Whether the one-second XAUUSD tick stream should run.

        Named for the strategy that first needed it, but the stream itself is
        strategy-neutral: it reads the terminal's ordered XAUUSD ticks and
        posts them to the generic `/collector/ticks` endpoint, and touches no
        strategy-specific route.

        xauusd-m1-m5-rsi-threshold-v2 needs it too. Its spec requires a
        ONE-SECOND observation cadence (§10), and without this stream the only
        fresh price it got was the live tick riding on the account snapshot,
        every ~10 seconds -- so an RSI move that crossed a threshold and came
        back inside those ten seconds was never seen.

        xauusd-sar-v1 needs it for the same reason M1M5 does: its trailing
        reversal must be evaluated on every fresh tick, not once per
        MAIN-loop cycle, which tick-sync/candle-sync work can stall for well
        over a minute -- the confirmed cause of a live incident where a
        reversal sat queued for 112 seconds before the collector got to it.
        """
        return bool(
            self._config.rsi_execution_enabled
            or self._config.m1m5_execution_enabled
            or getattr(self._config, "sar_execution_enabled", False)
        )

    def _start_rsi_observation_loop(self) -> None:
        """Launches the one-second XAUUSD observation thread."""
        if self._rsi_observation_thread is not None and self._rsi_observation_thread.is_alive():
            return
        self._rsi_observation_thread = threading.Thread(
            target=self._rsi_observation_loop, daemon=True, name="rsi-observation"
        )
        self._rsi_observation_thread.start()
        logger.info("rsi observation loop started", extra={
            "symbol": RSI_TICK_SYMBOL, "interval_seconds": RSI_OBSERVATION_INTERVAL_SECONDS,
        })

    def _rsi_observation_loop(self) -> None:
        """Observes XAUUSD once per second until shutdown.

        Paced against a fixed schedule rather than by sleeping a whole
        interval after each pass, so the time an observation itself takes does
        not accumulate into drift.
        """
        next_at = time.monotonic()
        while not self._stop_event.is_set():
            next_at += RSI_OBSERVATION_INTERVAL_SECONDS
            try:
                self._observe_rsi_once()
            except Exception as exc:  # noqa: BLE001 - never let this thread die
                logger.warning("rsi observation failed, continuing", extra={"error": str(exc)})
            # V2's one-second execution evaluation, in its OWN try: a failure in
            # the tick stream must not stop orders being placed, nor the reverse.
            if self._config.m1m5_execution_enabled:
                try:
                    self._m1m5_fast_execution_pass()
                except Exception as exc:  # noqa: BLE001 - never let this thread die
                    logger.warning("xauusd-m1m5 execution pass failed, continuing", extra={"error": str(exc)})
            if getattr(self._config, "sar_execution_enabled", False):
                try:
                    self._sar_fast_execution_pass()
                except Exception as exc:  # noqa: BLE001 - never let this thread die
                    logger.warning("xauusd-sar execution pass failed, continuing", extra={"error": str(exc)})
            delay = next_at - time.monotonic()
            if delay <= 0:
                # Fell behind: resynchronise instead of trying to catch up with
                # a burst of back-to-back observations.
                next_at = time.monotonic()
                delay = 0
            if self._stop_event.wait(timeout=delay):
                break
        logger.info("rsi observation loop stopped")

    def _observe_rsi_once(self) -> None:
        """One observation: read what has happened since the cursor and push it.

        Prefers INCREMENTAL ticks (`copy_ticks_from`), which capture movement
        between polls rather than only the instant each poll happened to land
        on. The current quote is read as well, and is used only when the
        incremental call yields nothing new — it is never treated as a fresh
        market event in its own right, because a quote that has not changed
        is not new information.
        """
        if not self._mt5_call_lock.acquire(timeout=RSI_OBSERVATION_LOCK_TIMEOUT_SECONDS):
            # Another MT5 call is in flight. Skipping is correct: the next
            # observation is one second away and will pick up everything since
            # the cursor anyway, so nothing is lost.
            return
        try:
            if not self._client.is_connected():
                return

            now = datetime.now(tz=timezone.utc)
            self._record_rsi_cadence(now)

            cursor = self._rsi_cursor_msc
            date_from = (
                datetime.fromtimestamp(cursor / 1000, tz=timezone.utc)
                if cursor is not None
                else now - timedelta(seconds=RSI_OBSERVATION_COLD_START_SECONDS)
            )

            try:
                ticks = self._client.get_ticks_from(RSI_TICK_SYMBOL, date_from, RSI_OBSERVATION_TICK_COUNT)
            except Exception as exc:  # noqa: BLE001 - MT5 boundary
                logger.warning("rsi observation: incremental tick call failed", extra={"error": str(exc)})
                return

            # Drop anything at or before the cursor: copy_ticks_from is
            # inclusive of its start, so the boundary tick would otherwise be
            # re-sent every single second.
            fresh = [t for t in ticks if cursor is None or int(t.get("time_msc", 0)) > cursor]
            self._rsi_duplicate_skips += len(ticks) - len(fresh)

            if not fresh:
                # Nothing new. Deliberately no synthetic observation is
                # manufactured merely because a poll occurred.
                return

            newest = max(int(t["time_msc"]) for t in fresh)
            payload_ticks = [{k: v for k, v in t.items() if k != "time_msc"} for t in fresh]
            # batch_seq must be contiguous within the pushed batch.
            for i, t in enumerate(payload_ticks):
                t["batch_seq"] = i

            try:
                payload = build_ticks_payload(RSI_TICK_SYMBOL, None, None, None, payload_ticks)
                result = self._api.post_ticks(payload)
            except Exception as exc:  # noqa: BLE001 - see below
                # Deliberately broader than ApiClientError: payload
                # construction sits inside this block too, so one malformed
                # tick must not kill the observation thread. The cursor is NOT
                # advanced on failure, so the same ticks are retried next
                # second.
                logger.warning("rsi observation: push failed, will retry", extra={"error": str(exc)})
                return

            self._rsi_cursor_msc = newest
            self._rsi_last_pushed_msc = newest
            self._rsi_ticks_pushed += len(fresh)
            logger.debug("rsi observation pushed", extra={
                "symbol": RSI_TICK_SYMBOL, "count": len(fresh), "inserted": result.get("inserted"),
            })
        finally:
            self._mt5_call_lock.release()

    def _record_rsi_cadence(self, now: datetime) -> None:
        """Measures the ACTUAL interval between observations.

        Reported rather than assumed: the requirement is a one-second cadence,
        and the only honest way to state whether it is met is to measure it.
        """
        if self._rsi_last_observation_at is not None:
            gap = (now - self._rsi_last_observation_at).total_seconds()
            self._rsi_cadence_samples.append(gap)
            if len(self._rsi_cadence_samples) > 300:
                self._rsi_cadence_samples.pop(0)
        self._rsi_last_observation_at = now
        self._rsi_observations += 1
        if self._rsi_observations % 60 == 0 and self._rsi_cadence_samples:
            samples = sorted(self._rsi_cadence_samples)
            logger.info("rsi observation cadence", extra={
                "observations": self._rsi_observations,
                "ticks_pushed": self._rsi_ticks_pushed,
                "duplicates_skipped": self._rsi_duplicate_skips,
                "median_interval_s": round(samples[len(samples) // 2], 3),
                "max_interval_s": round(samples[-1], 3),
            })

    # ---- xauusd-m1-m5-rsi-threshold-v2 --------------------------------

    def _push_m1m5_mt5_snapshot(self) -> None:
        """Reports what the terminal says about its own permission to trade.

        This exists because fresh quotes are not permission to trade. A
        terminal with algorithmic trading switched off, logged into the wrong
        account, or disconnected from the trade server streams perfectly good
        prices right up to the moment an order is rejected. The backend
        therefore refuses to submit without a recent report of these values,
        and treats an unreadable one as a blocker rather than as a grant.

        Pushed on the ordinary poll cadence rather than on demand: a permission
        that is only read when an order is imminent cannot reveal that trading
        was switched off while nothing was happening.
        """
        account = self._client.get_account_info()
        terminal = self._client.get_terminal_info()
        payload = build_permissions_payload(account, terminal, self._client.is_connected())
        payload["capturedAt"] = datetime.now(timezone.utc).isoformat()
        payload["leverage"] = (account or {}).get("leverage")
        payload["sessionOpen"] = self._m1m5_session_open()

        try:
            self._api.post_m1m5_mt5_snapshot(self._config.collector_account_id, payload)
        except ApiClientError as exc:
            # Never fatal. A failed push leaves the previous snapshot in place,
            # which ages out and blocks on its own -- the safe direction.
            logger.warning("xauusd-m1m5 mt5 snapshot push failed, will retry next tick", extra={"error": str(exc)})

    def _m1m5_session_open(self) -> bool | None:
        """Whether the broker session for this symbol is actually open.

        Returns None when it cannot be established, and None blocks entries
        exactly as False does. That matters most after a weekend: the spec
        requires reopening to be CONFIRMED rather than inferred from a clock,
        and "we could not tell" must never read as "the market is open".

        Two things must both hold: the symbol is tradable at all, and a tick
        has arrived recently. The first without the second is the weekend
        state -- a tradable symbol nobody is quoting.
        """
        info = self._client.get_symbol_info(M1M5_SYMBOL)
        if not info:
            return None
        trade_mode = info.get("trade_mode")
        if trade_mode is None:
            return None
        if int(trade_mode) == 0:  # SYMBOL_TRADE_MODE_DISABLED
            return False

        tick = self._client.get_live_tick(M1M5_SYMBOL)
        if not tick:
            return None
        if not tick.get("bid") or not tick.get("ask"):
            return False

        # get_live_tick normalises the broker timestamp to true UTC, so this
        # compares against our own clock. The RAW MT5 tick time is in SERVER
        # time, and subtracting that here would be wrong by the broker offset
        # -- exactly the mistake that made a live feed look stale by 3 hours.
        #
        # It arrives as an ISO-8601 STRING (`_mt5_time_to_utc` returns str),
        # not a datetime. This check first subtracted it directly, which
        # raises TypeError; that never fired only because a missing
        # `trade_mode` returned early above. Anything unparseable is
        # "unknown", which blocks -- never an exception out of the main loop.
        tick_at = _as_utc_datetime(tick.get("time"))
        if tick_at is None:
            return None
        age = (datetime.now(timezone.utc) - tick_at).total_seconds()
        return 0 <= age <= M1M5_SESSION_TICK_MAX_AGE_SECONDS

    def _m1m5_fast_execution_pass(self) -> None:
        """One execution evaluation, run every second by the observation loop.

        Before this, a queued V2 order was picked up only once per MAIN-loop
        cycle -- every POLL_INTERVAL_SECONDS (10) or longer -- and the first
        real trade waited 22.5s between being queued and being sent. This
        removes that avoidable scheduling delay. It does not, and cannot, make
        the broker fill in a second: submission-to-fill is the broker's and the
        network's, and is measured separately so it is never mistaken for ours.

        The MT5 lock is taken BEFORE polling, never after. The poll CLAIMS the
        order (PENDING -> SENT) on the backend, so polling without the lock
        could claim an order this pass is then unable to place. Holding it also
        means no two passes -- this one and the main loop's fallback poll --
        can ever execute at the same moment. If the lock is busy this pass
        simply does not poll; the order stays PENDING, unclaimed, for the next
        second.

        One crossing still produces at most one order attempt however often
        this runs: the claim is an atomic guarded update on the backend, and a
        claimed order is no longer offered.
        """
        if not self._mt5_call_lock.acquire(timeout=M1M5_EXECUTION_LOCK_TIMEOUT_SECONDS):
            return
        try:
            self._poll_and_execute_pending_m1m5_order()
        finally:
            self._mt5_call_lock.release()

    def _sar_fast_execution_pass(self) -> None:
        """One xauusd-sar-v1 execution evaluation, run every second by the
        observation loop -- the SAME fix M1M5 got, applied to the strategy
        that was shipped without it.

        Before this, a queued SAR order (a triggered reversal included) was
        only picked up once per MAIN-loop cycle, which tick-sync/candle-sync
        work can stall well past a minute. A live incident measured one
        reversal sitting queued for 112 seconds before this ran -- price had
        room to move far more than the strategy's own $0.50 reversal
        distance in that window, which is the actual cause of losses larger
        than the strategy's design should allow. This does not change how
        much the position can lose once reversed; it only removes the
        collector's own avoidable delay in getting there.
        """
        if not self._mt5_call_lock.acquire(timeout=SAR_EXECUTION_LOCK_TIMEOUT_SECONDS):
            return
        try:
            self._push_sar_reconciliation()
            self._poll_and_execute_pending_sar_order()
        finally:
            self._mt5_call_lock.release()

    def _m1m5_final_check(self, order: dict[str, Any], now: datetime) -> str | None:
        """The last check before order_send. A reason to refuse, or None.

        The backend already ran the full pre-send check when it queued the
        order, and re-checked the schedule, controls and signal age when this
        collector claimed it. This repeats the two that move with every tick --
        signal age and entry drift -- against the terminal's own live price,
        because that is the price the order would actually be sent at.

        The limits come WITH the order, from the backend, so there is one
        definition of each rather than a copy here that could drift from it.
        Missing a limit refuses rather than skipping the check.
        """
        observed_at = _as_utc_datetime(order.get("observedAt"))
        max_age = order.get("maxSignalAgeSeconds")
        signal_price = order.get("signalPrice")
        max_drift = order.get("maxEntryDeviationPoints")
        point = order.get("pointSize")
        if observed_at is None or max_age is None or signal_price is None or max_drift is None or not point:
            return "the order is missing the signal time, signal price or limits needed for the final check"

        age = (now - observed_at).total_seconds()
        if age > float(max_age):
            return f"signal is {age:.1f}s old at send, beyond the {max_age}s limit; dropped rather than sent late"

        tick = self._client.get_live_tick(order.get("symbol", M1M5_SYMBOL))
        if not tick or not tick.get("bid") or not tick.get("ask"):
            return "no live quote from the terminal at send time"
        executable = float(tick["ask"]) if order["side"] == "BUY" else float(tick["bid"])
        drift = abs(executable - float(signal_price)) / float(point)
        if drift > float(max_drift):
            return (
                f"price has moved {drift:.0f} points from the {signal_price} the signal formed at, "
                f"beyond the {max_drift}-point limit; the entry is skipped, never chased"
            )
        return None

    def _poll_and_execute_pending_m1m5_order(self) -> None:
        """Claims one approved entry and places it. Caller holds the MT5 lock.

        Every outcome is reported back so nothing is left silently in flight,
        and the three are never collapsed:

          not sent   refused BEFORE the broker was called (final check, DEMO
                     check, missing volume). Provably opened nothing, so the
                     backend cancels it and frees the slot.
          uncertain  the broker call happened, or may have, and its answer was
                     lost -- including an exception partway through. It MAY be
                     a live position, so the backend records UNKNOWN and KEEPS
                     the slot until reconciliation sees broker state. Freeing it
                     would permit a second position on a timeframe that may
                     already hold one.
          ok / not   the broker answered.
        """
        try:
            response = self._api.get_pending_m1m5_order(self._config.collector_account_id)
        except ApiClientError as exc:
            logger.warning("xauusd-m1m5 pending-order poll failed, will retry", extra={"error": str(exc)})
            return

        order = response.get("order")
        if not order:
            return
        decision_id = order["decisionId"]
        evaluated_at = datetime.now(timezone.utc)

        def not_sent(reason: str) -> None:
            logger.warning("xauusd-m1m5 order NOT sent at the final check", extra={"decision_id": decision_id, "reason": reason})
            self._report_m1m5_execution_result(
                decision_id, ok=False, not_sent=True, error_message=reason, evaluated_at=evaluated_at,
            )

        if not order.get("volume"):
            # The backend sizes every order before queueing it. A row without a
            # volume is one whose risk approval cannot be reconstructed.
            not_sent("queued order carried no volume; refusing to substitute a default")
            return

        refusal = self._m1m5_final_check(order, evaluated_at)
        if refusal:
            not_sent(refusal)
            return

        logger.info("xauusd-m1m5 pending order claimed, sending", extra={
            "decision_id": decision_id, "timeframe": order.get("timeframe"),
            "side": order["side"], "volume": order["volume"], "magic": order["magic"],
        })

        submitted_at = datetime.now(timezone.utc)
        try:
            result = self._executor.send_bracket_order(
                side=order["side"],
                volume=order["volume"],
                stop_loss_points=order["stopLossPoints"],
                take_profit_points=order["takeProfitPoints"],
                magic=order["magic"],
                comment=order["comment"],
                symbol=order["symbol"],
                point_size=order["pointSize"],
            )
        except DemoAccountRequiredError as exc:
            # Raised by the executor's own DEMO check, BEFORE order_send.
            logger.critical("XAUUSD-M1M5: DEMO ACCOUNT CHECK FAILED - refusing to trade", extra={"error": str(exc)})
            not_sent(str(exc))
            return
        except Exception as exc:  # noqa: BLE001 - must never crash the loop
            # Anything else may have happened DURING the broker call. We do not
            # know whether the order reached the broker, so it is UNCERTAIN --
            # never a plain failure, which would free the slot.
            logger.error("xauusd-m1m5 order execution raised; outcome UNKNOWN", extra={"error": str(exc)})
            self._report_m1m5_execution_result(
                decision_id, ok=False, uncertain=True, error_message=f"broker call raised: {exc}",
                evaluated_at=evaluated_at, submitted_at=submitted_at,
                acknowledged_at=datetime.now(timezone.utc),
            )
            return
        acknowledged_at = datetime.now(timezone.utc)

        # Neither a ticket nor a broker retcode means the executor could not
        # establish what happened -- genuinely uncertain, as distinct from a
        # broker that clearly refused.
        uncertain = (not result.ok) and result.ticket is None and result.retcode is None

        logger.info("xauusd-m1m5 order execution result", extra={
            "decision_id": decision_id, "ok": result.ok, "ticket": result.ticket,
            "retcode": result.retcode, "uncertain": uncertain, "error": result.error_message,
            # Our part and the broker's part, separately. See execution-latency.ts.
            "evaluate_to_submit_ms": round((submitted_at - evaluated_at).total_seconds() * 1000),
            "submit_to_ack_ms": round((acknowledged_at - submitted_at).total_seconds() * 1000),
        })

        broker_sl, broker_tp = self._read_position_protection(result.ticket, order["symbol"])
        self._report_m1m5_execution_result(
            decision_id, ok=result.ok, ticket=result.ticket,
            filled_price=result.price, error_message=result.error_message,
            uncertain=uncertain, broker_stop_loss=broker_sl, broker_take_profit=broker_tp,
            evaluated_at=evaluated_at, submitted_at=submitted_at, acknowledged_at=acknowledged_at,
        )

    def _report_m1m5_execution_result(
        self, decision_id: str, *, ok: bool, ticket: int | None = None,
        filled_price: float | None = None, error_message: str | None = None,
        uncertain: bool = False, not_sent: bool = False,
        broker_stop_loss: float | None = None, broker_take_profit: float | None = None,
        evaluated_at: datetime | None = None, submitted_at: datetime | None = None,
        acknowledged_at: datetime | None = None,
    ) -> None:
        payload: dict[str, Any] = {"ok": ok, "uncertain": uncertain}
        if not_sent:
            payload["notSent"] = True
        if ticket is not None:
            payload["ticket"] = int(ticket)
        if filled_price is not None:
            payload["filledPrice"] = float(filled_price)
        if broker_stop_loss is not None:
            payload["brokerStopLoss"] = float(broker_stop_loss)
        if broker_take_profit is not None:
            payload["brokerTakeProfit"] = float(broker_take_profit)
        if error_message:
            payload["errorMessage"] = error_message
        # The execution timeline, true UTC.
        if evaluated_at is not None:
            payload["executionEvaluatedAt"] = evaluated_at.isoformat()
        if submitted_at is not None:
            payload["submittedAt"] = submitted_at.isoformat()
        if acknowledged_at is not None:
            payload["acknowledgedAt"] = acknowledged_at.isoformat()
        try:
            self._api.post_m1m5_execution_result(self._config.collector_account_id, decision_id, payload)
        except ApiClientError as exc:
            # The order may be live and the backend may not know. Loud, because
            # reconciliation is now the only thing that can resolve it.
            logger.error(
                "xauusd-m1m5 execution result report FAILED; the backend does not know this outcome",
                extra={"decision_id": decision_id, "error": str(exc)},
            )


    # =====================================================================
    # ENGINE A REPLACEMENT — xauusd-sar-v1, the $0.50 continuous trailing
    # stop-and-reverse strategy.
    #
    # Two shapes of order, both handled here:
    #   INITIAL   the first direction of a session — a plain open, no
    #             existing position to close.
    #   REVERSAL  closingTicket is set. The existing position is closed
    #             FIRST (close_position), and only once that is confirmed
    #             is the new direction opened (send_bracket_order). Both
    #             calls happen inside this poll, itself inside the shared
    #             MT5 lock, so nothing else can interleave between them.
    #
    # Every order — INITIAL or REVERSAL — carries a wide CATASTROPHIC
    # backstop stop-loss and take-profit, never the strategy's real exit:
    # the reversal itself is what actually manages risk and takes profit.
    # This backstop exists because send_bracket_order enforces this
    # codebase's own audited rule that no order is ever sent without an
    # attached stop-loss (AUTONOMOUS_DEMO_TRADING_PLAN.md §1) — a rule
    # this strategy's design does not get to silently bypass. It only
    # matters if this process is down or disconnected long enough that the
    # reversal logic itself cannot run — see the final report for the
    # explicit tradeoff.
    # =====================================================================

    def _poll_and_execute_pending_sar_order(self) -> None:
        try:
            response = self._api.get_pending_sar_order(self._config.collector_account_id)
        except ApiClientError as exc:
            logger.warning("xauusd-sar pending-order poll failed, will retry", extra={"error": str(exc)})
            return

        order = response.get("order")
        if not order:
            return

        tag = order["idempotencyTag"]
        side = order["side"]
        volume = order["volume"]
        magic = order["magic"]
        symbol = order.get("symbol") or "XAUUSD"
        point_size = order.get("pointSize") or 0.01
        catastrophic_points = order.get("catastrophicStopPoints", 100000)
        closing_ticket = order.get("closingTicket")

        # Once the close step has actually happened, ANY non-success of the
        # open step that follows — clean broker refusal or ambiguous — is
        # reported UNCERTAIN, never a clean ok=False: the account is known to
        # be flat, but whether the new cycle opened is not, and this codebase
        # never guesses a state back into shape from a partial multi-step
        # result. A full success is NOT affected by this — only reported as
        # uncertain when the open itself does not cleanly succeed.
        reversal_in_progress = False
        close_fill_price: float | None = None

        if closing_ticket:
            close_side = "SELL" if side == "BUY" else "BUY"  # the side the EXISTING position is on

            # The LIVE position's own volume, not the queued order's --
            # confirmed live incident, 2026-09-24: the operator changed the
            # configured SAR volume (0.02 -> 0.01) between a cycle's entry
            # and its reversal. `volume` here is the NEW order's queued
            # volume; the OPEN position being reversed out of was still
            # holding the OLD volume. Closing with the wrong (smaller)
            # volume is a PARTIAL close that leaves the remainder open
            # under the same ticket and magic -- which is exactly what
            # `send_bracket_order`'s own duplicate-position guard then
            # correctly refused to open a second position on top of,
            # immediately afterward, in that incident. Same lesson
            # `_poll_and_execute_m1m5_close_request` already learned: the
            # terminal is the authority on what is actually open, never a
            # value queued earlier under conditions that may since have
            # changed.
            try:
                live_position = self._executor.find_open_position(magic, symbol=symbol)
            except Exception as exc:  # noqa: BLE001 - must never crash the loop
                logger.error("xauusd-sar could not verify the live position before reversing; outcome UNKNOWN", extra={"error": str(exc)})
                self._report_sar_execution_result(tag, ok=False, uncertain=True, error_message=f"live position lookup failed: {exc}")
                return
            if live_position is None or str(getattr(live_position, "ticket", None)) != str(closing_ticket):
                live_ticket = getattr(live_position, "ticket", None) if live_position is not None else None
                logger.error("xauusd-sar reversal ticket mismatch or already gone", extra={
                    "expected_ticket": closing_ticket, "live_ticket": live_ticket, "tag": tag,
                })
                self._report_sar_execution_result(
                    tag, ok=False, uncertain=True,
                    error_message=f"ticket mismatch before reversing: expected {closing_ticket}, live position is {live_ticket}",
                )
                return
            close_volume = float(getattr(live_position, "volume", volume))

            logger.info("xauusd-sar closing existing position before reversal", extra={
                "ticket": closing_ticket, "close_side": close_side, "close_volume": close_volume, "tag": tag,
            })
            try:
                close_result = self._executor.close_position(
                    ticket=int(closing_ticket), side=close_side, volume=close_volume, symbol=symbol,
                )
            except Exception as exc:  # noqa: BLE001 - must never crash the loop
                logger.error("xauusd-sar close-before-reverse raised; outcome UNKNOWN", extra={"error": str(exc)})
                self._report_sar_execution_result(tag, ok=False, uncertain=True, error_message=f"close raised: {exc}")
                return
            if not close_result.ok:
                logger.error("xauusd-sar failed to close existing position before reversing", extra={
                    "ticket": closing_ticket, "error": close_result.error_message,
                })
                self._report_sar_execution_result(
                    tag, ok=False, uncertain=True,
                    error_message=f"could not close {closing_ticket} before reversing: {close_result.error_message}",
                )
                return
            reversal_in_progress = True  # from here on, any open failure leaves the account FLAT, not in the old state.
            close_fill_price = close_result.price

        logger.info("xauusd-sar opening position", extra={
            "tag": tag, "kind": order["kind"], "side": side, "volume": volume, "magic": magic,
        })
        try:
            result = self._executor.send_bracket_order(
                side=side, volume=volume,
                stop_loss_points=catastrophic_points, take_profit_points=catastrophic_points,
                magic=magic, comment=order["comment"], symbol=symbol, point_size=point_size,
            )
        except DemoAccountRequiredError as exc:
            logger.critical("XAUUSD-SAR: DEMO ACCOUNT CHECK FAILED - refusing to trade", extra={"error": str(exc)})
            self._report_sar_execution_result(tag, ok=False, uncertain=reversal_in_progress, error_message=str(exc))
            return
        except Exception as exc:  # noqa: BLE001
            logger.error("xauusd-sar order execution raised; outcome UNKNOWN", extra={"error": str(exc)})
            self._report_sar_execution_result(tag, ok=False, uncertain=True, error_message=f"open raised: {exc}")
            return

        ambiguous_open = (not result.ok) and result.ticket is None and result.retcode is None
        uncertain = ambiguous_open or (reversal_in_progress and not result.ok)
        logger.info("xauusd-sar order execution result", extra={
            "tag": tag, "ok": result.ok, "ticket": result.ticket, "price": result.price,
            "close_fill_price": close_fill_price, "retcode": result.retcode, "uncertain": uncertain,
        })
        self._report_sar_execution_result(
            tag, ok=result.ok, ticket=result.ticket, filled_price=result.price,
            close_fill_price=close_fill_price, error_message=result.error_message, uncertain=uncertain,
        )

    def _report_sar_execution_result(
        self, idempotency_tag: str, *, ok: bool, ticket: int | None = None,
        filled_price: float | None = None, close_fill_price: float | None = None,
        error_message: str | None = None, uncertain: bool = False,
    ) -> None:
        payload: dict[str, Any] = {"ok": ok, "uncertain": uncertain}
        if ticket is not None:
            payload["ticket"] = int(ticket)
        if filled_price is not None:
            payload["filledPrice"] = float(filled_price)
        if close_fill_price is not None:
            payload["closeFillPrice"] = float(close_fill_price)
        if error_message:
            payload["errorMessage"] = error_message
        try:
            self._api.post_sar_execution_result(self._config.collector_account_id, idempotency_tag, payload)
        except ApiClientError as exc:
            logger.error(
                "xauusd-sar execution result report FAILED; the backend does not know this outcome",
                extra={"tag": idempotency_tag, "error": str(exc)},
            )

    def _push_sar_reconciliation(self) -> None:
        """Sends the broker's own view of xauusd-sar-v1's exposure to the backend.

        Filtered to SAR's own magic only -- see safety-constants.ts's
        disjoint magic-number list. Never reads or reasons about any other
        strategy's position; the backend-side ownership check
        (`isOwnedBySar`) is the second, independent gate on top of this one.

        Both `positionId` (the POSITION a deal belongs to) and `ticket` (the
        deal's OWN id) are sent for every deal -- conflating the two was a
        latent bug in the original, never-wired version of this payload: an
        OUT deal's own ticket is a different number from the position it
        closed, and matching a closing ticket by the wrong one would just
        never match.

        `mt5Connected` and `snapshotAt` both matter as much as the position
        list itself: the backend refuses to resolve anything from a
        snapshot that is stale or was taken while disconnected, exactly the
        same discipline `snapshotComplete` already gets.
        """
        snapshot_at = datetime.now(timezone.utc)
        mt5_connected = self._client.is_connected()
        try:
            positions = self._client.get_open_positions()
            complete = True
        except PositionsUnavailable as exc:
            logger.warning("sar reconciliation: positions unavailable", extra={"error": str(exc)})
            positions, complete = [], False
        except Exception as exc:  # noqa: BLE001
            logger.warning("sar reconciliation: position query failed", extra={"error": str(exc)})
            positions, complete = [], False

        deals: list[dict[str, Any]] = []
        if complete and mt5_connected:
            try:
                for deal in self._client.get_recent_deals(SAR_RECONCILE_DEAL_DAYS):
                    if deal.get("entry") not in ("IN", "OUT", "OUT_BY", "INOUT"):
                        continue
                    if _position_magic(deal) != SAR_MAGIC:
                        continue
                    deals.append({
                        "ticket": str(deal.get("ticket")),
                        "positionId": str(deal["position_id"]) if deal.get("position_id") else None,
                        "magic": _position_magic(deal),
                        "comment": deal.get("comment") or "",
                        "entry": deal.get("entry"),
                        "price": deal.get("price"),
                    })
            except Exception as exc:  # noqa: BLE001
                logger.warning("sar reconciliation: deal query failed", extra={"error": str(exc)})
                complete = False

        payload = {
            "snapshotComplete": complete,
            "mt5Connected": mt5_connected,
            "snapshotAt": snapshot_at.isoformat(),
            "positions": [
                {
                    "ticket": str(p.get("ticket")),
                    "magic": _position_magic(p),
                    "comment": p.get("comment"),
                }
                for p in positions
                if _position_magic(p) == SAR_MAGIC
            ],
            "deals": deals,
        }
        try:
            self._api.post_sar_reconcile(self._config.collector_account_id, payload)
        except ApiClientError as exc:
            logger.warning("xauusd-sar reconciliation push failed, will retry", extra={"error": str(exc)})

    # =====================================================================
    # ENGINE B - the Telegram copy engine.
    #
    # Entirely separate from the xauusd-m1m5 methods above: its own endpoints,
    # its own magic number, its own final check and its own reconciliation.
    # Nothing here reads or writes Engine A's state, and a failure here is
    # caught so that Engine A's monitoring and execution continue regardless.
    # =====================================================================

    def _telegram_final_check(self, leg: dict[str, Any], now: datetime) -> str | None:
        """The last check before order_send for a Telegram leg.

        Repeats, against the terminal's own live price, the two things that
        move with every tick and can have changed since the backend claimed
        this leg: the hard 60-second lifetime, and whether the first target
        has already been reached.

        The limits arrive WITH the leg so there is one definition of each
        rather than a copy here that could drift. A missing limit refuses
        rather than skipping the check.
        """
        published_at = _as_utc_datetime(leg.get("publishedAt"))
        max_age = leg.get("maxSignalAgeSeconds")
        tp1 = leg.get("tp1")
        if published_at is None or max_age is None or tp1 is None:
            return "the leg is missing the publication time, lifetime or first target needed for the final check"

        # The 60-second rule, measured from ORIGINAL PUBLICATION, at the last
        # possible moment. Never from receipt, never from the claim.
        age = (now - published_at).total_seconds()
        if age > float(max_age):
            return (
                f"telegram signal is {age:.1f}s old at send, beyond the {max_age}s lifetime; "
                "the leg is dropped, never sent late and never queued"
            )

        tick = self._client.get_live_tick(leg.get("symbol", M1M5_SYMBOL))
        if not tick or not tick.get("bid") or not tick.get("ask"):
            return "no live quote from the terminal at send time"

        # A SELL is closed by buying (at the ask), a BUY by selling (at the
        # bid). Using the wrong side declares the target reached a spread
        # early and cancels legs that were still live.
        closing_price = float(tick["ask"]) if leg["side"] == "SELL" else float(tick["bid"])
        reached = closing_price <= float(tp1) if leg["side"] == "SELL" else closing_price >= float(tp1)
        if reached:
            return (
                f"price {closing_price} has already reached the first target {tp1}; the signal is finished and "
                "this leg is not opened"
            )
        return None

    def _poll_and_execute_pending_telegram_leg(self) -> None:
        """Claims one Telegram leg and places it. Caller holds the MT5 lock.

        Outcomes are reported with the same three-way distinction Engine A
        uses, for the same reason: a leg whose broker answer was lost MAY be
        a live position, and calling that a plain failure would release a
        signal group that should stay held.
        """
        try:
            response = self._api.get_pending_telegram_leg(self._config.collector_account_id)
        except ApiClientError as exc:
            logger.warning("telegram pending-leg poll failed, will retry", extra={"error": str(exc)})
            return

        leg = response.get("leg")
        if not leg:
            return
        leg_id = leg["legId"]
        evaluated_at = datetime.now(timezone.utc)

        def not_sent(reason: str) -> None:
            logger.warning("telegram leg NOT sent at the final check", extra={"leg_id": leg_id, "reason": reason})
            self._report_telegram_leg_result(leg_id, ok=False, not_sent=True, error_message=reason)

        if not leg.get("volume"):
            not_sent("queued leg carried no volume; refusing to substitute a default")
            return

        refusal = self._telegram_final_check(leg, evaluated_at)
        if refusal:
            not_sent(refusal)
            return

        logger.info("telegram leg claimed, sending", extra={
            "leg_id": leg_id, "leg_index": leg.get("legIndex"), "side": leg["side"],
            "volume": leg["volume"], "sl": leg["stopLoss"], "tp": leg["takeProfit"], "magic": leg["magic"],
        })

        submitted_at = datetime.now(timezone.utc)
        try:
            result = self._executor.send_telegram_leg(
                side=leg["side"],
                volume=leg["volume"],
                # The SOURCE levels, sent as absolute prices. Never widened,
                # never re-derived from the fill.
                stop_loss=float(leg["stopLoss"]),
                take_profit=float(leg["takeProfit"]),
                magic=leg["magic"],
                comment=leg["comment"],
                idempotency_tag=leg["idempotencyTag"],
                symbol=leg.get("symbol", M1M5_SYMBOL),
            )
        except DemoAccountRequiredError as exc:
            logger.critical("TELEGRAM: DEMO ACCOUNT CHECK FAILED - refusing to trade", extra={"error": str(exc)})
            not_sent(str(exc))
            return
        except Exception as exc:  # noqa: BLE001 - must never crash the loop
            # The broker call may have happened. UNCERTAIN, never FAILED.
            logger.error("telegram leg execution raised; outcome UNKNOWN", extra={"error": str(exc)})
            self._report_telegram_leg_result(
                leg_id, ok=False, uncertain=True, error_message=f"broker call raised: {exc}",
                submitted_at=submitted_at, acknowledged_at=datetime.now(timezone.utc),
            )
            return
        acknowledged_at = datetime.now(timezone.utc)

        uncertain = (not result.ok) and result.ticket is None and result.retcode is None
        logger.info("telegram leg execution result", extra={
            "leg_id": leg_id, "ok": result.ok, "ticket": result.ticket, "retcode": result.retcode,
            "uncertain": uncertain, "error": result.error_message,
            "submit_to_ack_ms": round((acknowledged_at - submitted_at).total_seconds() * 1000),
        })

        broker_sl, broker_tp = self._read_position_protection(result.ticket, leg.get("symbol", M1M5_SYMBOL))
        self._report_telegram_leg_result(
            leg_id, ok=result.ok, ticket=result.ticket, filled_price=result.price,
            error_message=result.error_message, uncertain=uncertain,
            broker_stop_loss=broker_sl, broker_take_profit=broker_tp,
            submitted_at=submitted_at, acknowledged_at=acknowledged_at,
        )

    def _report_telegram_leg_result(
        self, leg_id: str, *, ok: bool, ticket: int | None = None,
        filled_price: float | None = None, error_message: str | None = None,
        uncertain: bool = False, not_sent: bool = False,
        broker_stop_loss: float | None = None, broker_take_profit: float | None = None,
        submitted_at: datetime | None = None, acknowledged_at: datetime | None = None,
    ) -> None:
        payload: dict[str, Any] = {"ok": ok, "uncertain": uncertain}
        if not_sent:
            payload["notSent"] = True
        if ticket is not None:
            payload["ticket"] = int(ticket)
        if filled_price is not None:
            payload["filledPrice"] = float(filled_price)
        if broker_stop_loss is not None:
            payload["brokerStopLoss"] = float(broker_stop_loss)
        if broker_take_profit is not None:
            payload["brokerTakeProfit"] = float(broker_take_profit)
        if error_message:
            payload["errorMessage"] = error_message
        if submitted_at is not None:
            payload["submittedAt"] = submitted_at.isoformat()
        if acknowledged_at is not None:
            payload["acknowledgedAt"] = acknowledged_at.isoformat()
        try:
            self._api.post_telegram_leg_result(self._config.collector_account_id, leg_id, payload)
        except ApiClientError as exc:
            logger.error(
                "telegram leg result report FAILED; the backend does not know this outcome",
                extra={"leg_id": leg_id, "error": str(exc)},
            )

    def _push_telegram_reconciliation(self) -> None:
        """Sends the broker's own view of the account to the backend.

        The single most consequential field is `snapshotComplete`. A query
        that failed and an account with no positions look identical in the
        payload, and only this flag tells them apart - so it is set from
        whether the enumeration actually succeeded, never assumed true.
        """
        snapshot_at = datetime.now(timezone.utc)
        try:
            positions = self._client.get_open_positions()
            complete = True
        except PositionsUnavailable as exc:
            # Cannot enumerate. Report the failure rather than an empty list:
            # an empty list would be read as "everything closed".
            logger.warning("telegram reconciliation: positions unavailable", extra={"error": str(exc)})
            positions, complete = [], False
        except Exception as exc:  # noqa: BLE001
            logger.warning("telegram reconciliation: position query failed", extra={"error": str(exc)})
            positions, complete = [], False

        deals: list[dict[str, Any]] = []
        if complete:
            try:
                for deal in self._client.get_recent_deals(TELEGRAM_RECONCILE_DEAL_DAYS):
                    # Only closing deals, and only ones this engine's magic
                    # number owns.
                    #
                    # This used to filter on "TG" appearing in the deal's own
                    # comment, and that was a real bug, not a stricter check:
                    # a broker's own auto-close on hitting TP/SL commonly does
                    # NOT carry the original order's comment forward onto the
                    # closing deal, so a completely legitimate closure was
                    # silently dropped here before it ever reached the
                    # backend. The backend's reconciliation then correctly
                    # detected the leg was gone from a complete snapshot,
                    # marked it closed - and had no deal to attach a realised
                    # P/L to, because this loop had thrown the deal away.
                    # First observed 2026-09-23: signal 77302 (BUY 4306 -> TP
                    # 4315) filled, hit its target, and closed with
                    # closureComplete=true but realizedPl=null.
                    #
                    # Magic survives an auto-close the way a comment does not
                    # - it is set once on the order and every deal that order
                    # produces inherits it, exactly as it does for positions.
                    # The comment/tag is still SENT below and is still what
                    # the backend uses to attribute a deal to one LEG among
                    # several that share this magic; it is no longer what
                    # decides whether the deal is examined at all.
                    if deal.get("entry") not in ("OUT", "OUT_BY", "INOUT"):
                        continue
                    if _position_magic(deal) != TELEGRAM_MAGIC:
                        continue
                    comment = deal.get("comment") or ""
                    deals.append({
                        "ticket": str(deal.get("ticket")),
                        "positionId": str(deal["position_id"]) if deal.get("position_id") else None,
                        "comment": comment,
                        "profit": float(deal.get("profit") or 0.0),
                        "closedAt": deal.get("closed_at"),
                    })
            except Exception as exc:  # noqa: BLE001
                # Deals are how a realised result is established. Without them
                # the snapshot is not complete enough to conclude closure.
                logger.warning("telegram reconciliation: deal query failed", extra={"error": str(exc)})
                complete = False

        payload = {
            "snapshotComplete": complete,
            "snapshotAt": snapshot_at.isoformat(),
            "positions": [
                {
                    "ticket": str(p.get("ticket")),
                    "magic": _position_magic(p),
                    "symbol": p.get("symbol"),
                    "comment": p.get("comment"),
                    "volume": float(p.get("volume") or 0.0),
                    "openPrice": p.get("price_open"),
                    # MT5 reports an absent protective level as 0.0, not null.
                    # Passing the zero through would make an UNPROTECTED
                    # position look like one with a stop at zero, so it is
                    # normalised to null and the backend treats it as the
                    # protection incident it is.
                    "stopLoss": _level_or_none(p.get("sl")),
                    "takeProfit": _level_or_none(p.get("tp")),
                    "profit": p.get("profit"),
                }
                for p in positions
                if _position_magic(p) == TELEGRAM_MAGIC
            ],
            "deals": deals,
        }
        try:
            self._api.post_telegram_reconcile(self._config.collector_account_id, payload)
        except ApiClientError as exc:
            logger.warning("telegram reconciliation push failed, will retry", extra={"error": str(exc)})

    def _poll_and_execute_m1m5_close_request(self) -> None:
        """Closes one position this strategy owns, on the backend request.

        The ticket is verified against the LIVE position carrying that magic
        number before anything is closed. The backend's request was built from
        stored broker state that is by definition a little old; the terminal is
        the authority on what is actually open, and on a host where another bot
        trades the same symbol, closing a ticket that has moved on is the
        mistake worth engineering against.

        Accepting is not closing, and this reports only acceptance. The backend
        establishes closure by re-querying the broker and finding zero owned
        exposure, never by counting accepted requests.
        """
        try:
            response = self._api.get_m1m5_close_request(self._config.collector_account_id)
        except ApiClientError as exc:
            logger.warning("xauusd-m1m5 close-request poll failed, will retry next tick", extra={"error": str(exc)})
            return

        request = response.get("request")
        if not request:
            return

        request_id = request["requestId"]
        symbol = request.get("symbol", M1M5_SYMBOL)
        logger.warning("xauusd-m1m5 close requested", extra={
            "request_id": request_id, "ticket": request["ticket"],
            "magic": request["magic"], "reason": request.get("reason"),
        })

        try:
            position = self._executor.find_open_position(request["magic"], symbol)
        except Exception as exc:  # noqa: BLE001 - must never crash the main loop
            self._report_m1m5_close_result(request_id, accepted=False, error_message=f"position lookup failed: {exc}")
            return

        if position is None:
            # Already gone, or never ours. Either way there is nothing to close
            # and reporting a failure is the honest answer -- the backend
            # decides closure from broker state, not from this.
            self._report_m1m5_close_result(
                request_id, accepted=False,
                error_message=f"no open position with magic {request['magic']} on {symbol}",
            )
            return

        live_ticket = getattr(position, "ticket", None)
        if live_ticket is None or str(live_ticket) != str(request["ticket"]):
            self._report_m1m5_close_result(
                request_id, accepted=False,
                error_message=(
                    f"ticket mismatch: request names {request['ticket']}, "
                    f"the live position with magic {request['magic']} is {live_ticket}"
                ),
            )
            return

        # The LIVE side and volume, not the request's. A partial close since
        # the request was written would make the stored volume wrong, and
        # closing the wrong volume on a hedging account opens an opposing
        # position rather than doing nothing.
        side = "BUY" if int(getattr(position, "type", 0)) == 0 else "SELL"
        volume = float(getattr(position, "volume", request["volume"]))

        try:
            result = self._executor.close_position(
                ticket=int(live_ticket), side=side, volume=volume, symbol=symbol,
            )
        except Exception as exc:  # noqa: BLE001 - must never crash the main loop
            logger.error("xauusd-m1m5 close raised an unexpected error", extra={"error": str(exc)})
            self._report_m1m5_close_result(request_id, accepted=False, error_message=str(exc))
            return

        logger.warning("xauusd-m1m5 close result", extra={
            "request_id": request_id, "ticket": live_ticket,
            "ok": result.ok, "retcode": result.retcode, "error": result.error_message,
        })
        self._report_m1m5_close_result(
            request_id, accepted=bool(result.ok), error_message=result.error_message,
        )

    def _report_m1m5_close_result(self, request_id: str, *, accepted: bool, error_message: str | None = None) -> None:
        payload: dict[str, Any] = {"accepted": accepted}
        if error_message:
            payload["errorMessage"] = error_message
        try:
            self._api.post_m1m5_close_result(self._config.collector_account_id, request_id, payload)
        except ApiClientError as exc:
            logger.error(
                "xauusd-m1m5 close result report FAILED; the backend will retry this close",
                extra={"request_id": request_id, "error": str(exc)},
            )

    def _poll_and_execute_m1m5_protection_request(self) -> None:
        """Re-attaches a stop loss or take profit the broker did not keep.

        A filled order is not proof that protection is attached: the broker can
        confirm a fill and still report the position with no SL. An
        unprotected gold position is the most expensive state this application
        can be in, and one that looks entirely normal from the fill alone.

        The levels come from the backend, which took them from the decision
        that OPENED the position -- never recomputed here from the current
        price, which would silently move the stop and change the risk the trade
        was sized for.

        Acceptance is not verification. This reports only what the broker said;
        the backend re-reads the position on its next reconciliation pass and
        queues another repair if the levels still are not there.
        """
        try:
            response = self._api.get_m1m5_protection_request(self._config.collector_account_id)
        except ApiClientError as exc:
            logger.warning("xauusd-m1m5 protection-request poll failed, will retry next tick", extra={"error": str(exc)})
            return

        request = response.get("request")
        if not request:
            return

        request_id = request["requestId"]
        symbol = request.get("symbol", M1M5_SYMBOL)
        logger.error("xauusd-m1m5 PROTECTION REMEDIATION requested", extra={
            "request_id": request_id, "ticket": request["ticket"],
            "missing": request.get("missing"), "magic": request["magic"],
        })

        try:
            position = self._executor.find_open_position(request["magic"], symbol)
        except Exception as exc:  # noqa: BLE001 - must never crash the main loop
            self._report_m1m5_protection_result(request_id, accepted=False, error_message=f"position lookup failed: {exc}")
            return

        if position is None:
            # Gone since the request was written. Nothing to protect, and
            # nothing to conclude -- the backend decides from broker state.
            self._report_m1m5_protection_result(
                request_id, accepted=False,
                error_message=f"no open position with magic {request['magic']} on {symbol}",
            )
            return

        live_ticket = getattr(position, "ticket", None)
        if live_ticket is None or str(live_ticket) != str(request["ticket"]):
            self._report_m1m5_protection_result(
                request_id, accepted=False,
                error_message=(
                    f"ticket mismatch: request names {request['ticket']}, "
                    f"the live position with magic {request['magic']} is {live_ticket}"
                ),
            )
            return

        try:
            result = self._executor.modify_protection(
                ticket=int(live_ticket),
                stop_loss=float(request["stopLoss"]),
                take_profit=float(request["takeProfit"]),
                symbol=symbol,
            )
        except Exception as exc:  # noqa: BLE001 - must never crash the main loop
            logger.error("xauusd-m1m5 protection repair raised an unexpected error", extra={"error": str(exc)})
            self._report_m1m5_protection_result(request_id, accepted=False, error_message=str(exc))
            return

        logger.warning("xauusd-m1m5 protection repair result", extra={
            "request_id": request_id, "ticket": live_ticket,
            "ok": result.ok, "retcode": result.retcode, "error": result.error_message,
        })
        self._report_m1m5_protection_result(
            request_id, accepted=bool(result.ok), error_message=result.error_message,
        )

    def _report_m1m5_protection_result(self, request_id: str, *, accepted: bool, error_message: str | None = None) -> None:
        payload: dict[str, Any] = {"accepted": accepted}
        if error_message:
            payload["errorMessage"] = error_message
        try:
            self._api.post_m1m5_protection_result(self._config.collector_account_id, request_id, payload)
        except ApiClientError as exc:
            logger.error(
                "xauusd-m1m5 protection result report FAILED; the backend will queue this repair again",
                extra={"request_id": request_id, "error": str(exc)},
            )

    def _poll_and_execute_pending_rsi_order(self) -> None:
        """Polls the active strategy's own route and executes an approved
        entry. Same failure posture as every other execution poll here: never
        crashes the main loop, and every outcome is reported back so nothing
        is left silently in flight.

        One deliberate behavioural difference from the retired strategies'
        polls: when the broker's response is ambiguous (the executor reports
        neither a confirmed fill nor a definite rejection), this reports
        `uncertain=True` rather than `ok=False`. The backend records that as
        UNKNOWN and keeps the position slot occupied, because a lost response
        does not mean the order never reached the broker.
        """
        try:
            response = self._api.get_pending_rsi_order(self._config.collector_account_id)
        except ApiClientError as exc:
            logger.warning("xauusd-rsi pending-order poll failed, will retry next tick", extra={"error": str(exc)})
            return

        order = response.get("order")
        if not order:
            return

        logger.info("xauusd-rsi pending order claimed, attempting execution", extra={
            "decision_id": order["decisionId"], "side": order["side"],
            "volume": order["volume"], "symbol": order["symbol"],
        })

        try:
            result = self._executor.send_bracket_order(
                side=order["side"],
                volume=order["volume"],
                stop_loss_points=order["stopLossPoints"],
                take_profit_points=order["takeProfitPoints"],
                magic=order["magic"],
                comment=order["comment"],
                symbol=order["symbol"],
                point_size=order["pointSize"],
            )
        except DemoAccountRequiredError as exc:
            logger.critical("XAUUSD-RSI: DEMO ACCOUNT CHECK FAILED - refusing to trade", extra={"error": str(exc)})
            self._report_rsi_execution_result(order["decisionId"], ok=False, error_message=str(exc))
            return
        except Exception as exc:  # noqa: BLE001 - must never crash the main loop
            logger.error("xauusd-rsi order execution raised an unexpected error", extra={"error": str(exc)})
            self._report_rsi_execution_result(order["decisionId"], ok=False, error_message=str(exc))
            return

        # A non-ok result with neither a ticket nor a broker retcode means the
        # executor could not establish what happened (executor._unknown_result)
        # - genuinely uncertain, as opposed to a broker that clearly refused.
        uncertain = (not result.ok) and result.ticket is None and result.retcode is None

        logger.info("xauusd-rsi order execution result", extra={
            "decision_id": order["decisionId"], "ok": result.ok, "ticket": result.ticket,
            "retcode": result.retcode, "uncertain": uncertain, "error": result.error_message,
        })

        broker_sl, broker_tp = self._read_position_protection(result.ticket, order["symbol"])
        self._report_rsi_execution_result(
            order["decisionId"], ok=result.ok, ticket=result.ticket,
            filled_price=result.price, error_message=result.error_message,
            uncertain=uncertain, broker_stop_loss=broker_sl, broker_take_profit=broker_tp,
        )

    def _read_position_protection(self, ticket, symbol: str):
        """Reads the SL/TP the broker ACTUALLY attached to the freshly opened
        position, so the backend can reconcile them against what was requested
        instead of assuming the request was honoured verbatim.

        Best-effort by design: a failure returns (None, None), which the
        backend records as "not verified" rather than as a match.
        """
        if ticket is None:
            return (None, None)
        try:
            position = self._executor.find_any_position(symbol)
            if position is None or getattr(position, "ticket", None) != ticket:
                return (None, None)
            sl = getattr(position, "sl", None)
            tp = getattr(position, "tp", None)
            # MT5 reports 0 for "no level set" - surfaced as None, never as a
            # real price of zero.
            return (sl if sl else None, tp if tp else None)
        except Exception as exc:  # noqa: BLE001 - diagnostic only
            logger.warning("xauusd-rsi: could not read broker protection after fill", extra={
                "ticket": ticket, "error": str(exc),
            })
            return (None, None)

    def _report_rsi_execution_result(
        self, decision_id: str, *, ok: bool, ticket=None,
        filled_price=None, error_message=None,
        uncertain: bool = False, broker_stop_loss=None,
        broker_take_profit=None,
    ) -> None:
        payload = {"ok": ok, "uncertain": uncertain}
        if ticket is not None:
            payload["ticket"] = ticket
        if filled_price is not None:
            payload["filledPrice"] = filled_price
        if broker_stop_loss is not None:
            payload["brokerStopLoss"] = broker_stop_loss
        if broker_take_profit is not None:
            payload["brokerTakeProfit"] = broker_take_profit
        if error_message is not None:
            payload["errorMessage"] = error_message
        try:
            self._api.post_rsi_execution_result(self._config.collector_account_id, decision_id, payload)
        except ApiClientError as exc:
            # The backend's own startup reconciliation is the backstop: an
            # unreported result stays SENT and is resolved against real broker
            # state later, never assumed either way.
            logger.error("xauusd-rsi: failed to report execution result to backend", extra={
                "decision_id": decision_id, "error": str(exc),
            })

    def _poll_and_execute_pending_gold_order(self) -> None:
        """Gold (XAUUSD) analog of `_poll_and_execute_pending_order` — its
        OWN backend route (`get_pending_gold_order`), only ever reached
        when `gold_execution_enabled` is explicitly true, fully independent
        of the EURUSD flag above. Same failure posture: never crashes the
        main loop, every outcome (including DemoAccountRequiredError) is
        reported back, never left stuck. Passes the order's own
        `symbol`/`pointSize` through to `send_bracket_order` — executor.py
        already supports this per-call, no executor.py change was needed.
        """
        try:
            response = self._api.get_pending_gold_order(self._config.collector_account_id)
        except ApiClientError as exc:
            logger.warning("gold pending-order poll failed, will retry next tick", extra={"error": str(exc)})
            return

        order = response.get("order")
        if not order:
            return

        logger.info("gold pending order claimed, attempting execution", extra={
            "decision_id": order["decisionId"], "side": order["side"], "volume": order["volume"], "symbol": order["symbol"],
        })

        try:
            result = self._executor.send_bracket_order(
                side=order["side"],
                volume=order["volume"],
                stop_loss_points=order["stopLossPoints"],
                take_profit_points=order["takeProfitPoints"],
                magic=order["magic"],
                comment=order["comment"],
                symbol=order["symbol"],
                point_size=order["pointSize"],
            )
        except DemoAccountRequiredError as exc:
            logger.critical("GOLD: DEMO ACCOUNT CHECK FAILED — refusing to trade", extra={"error": str(exc)})
            self._report_gold_execution_result(order["decisionId"], ok=False, error_message=str(exc))
            return
        except Exception as exc:  # noqa: BLE001 — must never crash the main loop over this
            logger.error("gold order execution raised an unexpected error", extra={"error": str(exc)})
            self._report_gold_execution_result(order["decisionId"], ok=False, error_message=str(exc))
            return

        logger.info("gold order execution result", extra={
            "decision_id": order["decisionId"], "ok": result.ok, "ticket": result.ticket,
            "retcode": result.retcode, "error": result.error_message,
        })
        self._report_gold_execution_result(
            order["decisionId"], ok=result.ok, ticket=result.ticket,
            filled_price=result.price, error_message=result.error_message,
        )

    def _report_gold_execution_result(
        self, decision_id: str, *, ok: bool, ticket: int | None = None,
        filled_price: float | None = None, error_message: str | None = None,
    ) -> None:
        payload: dict = {"ok": ok}
        if ticket is not None:
            payload["ticket"] = ticket
        if filled_price is not None:
            payload["filledPrice"] = filled_price
        if error_message is not None:
            payload["errorMessage"] = error_message
        try:
            self._api.post_gold_execution_result(self._config.collector_account_id, decision_id, payload)
        except ApiClientError as exc:
            logger.error("failed to report gold execution result back to backend", extra={"decision_id": decision_id, "error": str(exc)})

    def _poll_and_execute_gold_close_request(self) -> None:
        """Gold close-request — symmetric to `_poll_and_execute_pending_gold_order`,
        for the dashboard's "request close" action (gold-controls.controller.ts).
        Same failure posture: never crashes the main loop, every outcome is
        reported back so the backend row never sits stuck. Reports `ok=True`
        (which the backend records as CLOSED) ONLY when `executor.close_position`
        itself returns a broker-confirmed success (order_send() succeeded) —
        never merely because this poll ran.
        """
        try:
            response = self._api.get_gold_close_request(self._config.collector_account_id)
        except ApiClientError as exc:
            logger.warning("gold close-request poll failed, will retry next tick", extra={"error": str(exc)})
            return

        request = response.get("request")
        if not request:
            return

        logger.info("gold close-request claimed, attempting execution", extra={
            "request_id": request["requestId"], "ticket": request["ticket"], "side": request["side"], "volume": request["volume"],
        })

        try:
            result = self._executor.close_position(
                ticket=request["ticket"], side=request["side"], volume=request["volume"], symbol=request["symbol"],
            )
        except Exception as exc:  # noqa: BLE001 — must never crash the main loop over this
            logger.error("gold close-position execution raised an unexpected error", extra={"error": str(exc)})
            self._report_gold_close_result(request["requestId"], ok=False, error_message=str(exc))
            return

        logger.info("gold close-position execution result", extra={
            "request_id": request["requestId"], "ok": result.ok, "ticket": result.ticket,
            "retcode": result.retcode, "error": result.error_message,
        })
        self._report_gold_close_result(
            request["requestId"], ok=result.ok, deal_ticket=result.ticket,
            closed_price=result.price, error_message=result.error_message,
        )

    def _report_gold_close_result(
        self, request_id: str, *, ok: bool, deal_ticket: int | None = None,
        closed_price: float | None = None, error_message: str | None = None,
    ) -> None:
        payload: dict = {"ok": ok}
        if deal_ticket is not None:
            payload["dealTicket"] = deal_ticket
        if closed_price is not None:
            payload["closedPrice"] = closed_price
        if error_message is not None:
            payload["errorMessage"] = error_message
        try:
            self._api.post_gold_close_result(self._config.collector_account_id, request_id, payload)
        except ApiClientError as exc:
            # The close attempt already happened (or definitively failed) at
            # the broker by this point — a failure to REPORT that back is a
            # visibility problem, not a trading-safety one, but it does mean
            # the request row stays stuck as SENT until this is noticed.
            logger.error("failed to report gold close result back to backend", extra={"request_id": request_id, "error": str(exc)})

    def _poll_and_execute_gold_restore_protection_request(self) -> None:
        """Gold protection-restore — task item 3 ("restore-then-close"), the
        RESTORE half, symmetric to `_poll_and_execute_gold_close_request`.
        Calls `executor.modify_protection` (TRADE_ACTION_SLTP) to re-attach
        SL/TP at the exact price the backend already computed (frozen
        distance from the position's own entry price — never recomputed
        here). Reports `ok=True` ONLY on a broker-confirmed success; the
        backend (not this collector) decides whether a failure means "queue
        another attempt" or "fall back to close" — this method's only job is
        to attempt exactly the one claimed request and report what happened.
        """
        try:
            response = self._api.get_gold_restore_protection_request(self._config.collector_account_id)
        except ApiClientError as exc:
            logger.warning("gold restore-protection-request poll failed, will retry next tick", extra={"error": str(exc)})
            return

        request = response.get("request")
        if not request:
            return

        logger.info("gold restore-protection-request claimed, attempting execution", extra={
            "request_id": request["requestId"], "ticket": request["ticket"],
            "attempt": request.get("attemptNumber"), "max_attempts": request.get("maxAttempts"),
        })

        try:
            result = self._executor.modify_protection(
                ticket=request["ticket"], stop_loss=request["stopLoss"], take_profit=request["takeProfit"], symbol=request["symbol"],
            )
        except Exception as exc:  # noqa: BLE001 — must never crash the main loop over this
            logger.error("gold protection-restore execution raised an unexpected error", extra={"error": str(exc)})
            self._report_gold_restore_protection_result(request["requestId"], ok=False, error_message=str(exc))
            return

        logger.info("gold protection-restore execution result", extra={
            "request_id": request["requestId"], "ok": result.ok, "retcode": result.retcode, "error": result.error_message,
        })
        self._report_gold_restore_protection_result(request["requestId"], ok=result.ok, error_message=result.error_message)

    def _report_gold_restore_protection_result(self, request_id: str, *, ok: bool, error_message: str | None = None) -> None:
        payload: dict = {"ok": ok}
        if error_message is not None:
            payload["errorMessage"] = error_message
        try:
            self._api.post_gold_restore_protection_result(self._config.collector_account_id, request_id, payload)
        except ApiClientError as exc:
            logger.error("failed to report gold restore-protection result back to backend", extra={"request_id": request_id, "error": str(exc)})

    def _poll_and_execute_pending_trend_breakout_order(self, instrument: str) -> None:
        """Trend-breakout (EURUSD/XAUUSD) analog of `_poll_and_execute_pending_gold_order`
        — its OWN backend route (`get_pending_trend_breakout_order`), instrument-
        parameterized, only ever reached when `trend_breakout_execution_enabled`
        is explicitly true, fully independent of the EURUSD-legacy and gold
        flags above. Same failure posture: never crashes the main loop, every
        outcome (including DemoAccountRequiredError) is reported back, never
        left stuck. Passes the order's own `symbol`/`pointSize` through to
        `send_bracket_order` — executor.py already supports this per-call, no
        executor.py change was needed (same as gold's own note).
        """
        try:
            response = self._api.get_pending_trend_breakout_order(self._config.collector_account_id, instrument)
        except ApiClientError as exc:
            logger.warning("trend-breakout pending-order poll failed, will retry next tick", extra={"instrument": instrument, "error": str(exc)})
            return

        order = response.get("order")
        if not order:
            return

        logger.info("trend-breakout pending order claimed, attempting execution", extra={
            "instrument": instrument, "decision_id": order["decisionId"], "side": order["side"], "volume": order["volume"], "symbol": order["symbol"],
        })

        try:
            result = self._executor.send_bracket_order(
                side=order["side"],
                volume=order["volume"],
                stop_loss_points=order["stopLossPoints"],
                take_profit_points=order["takeProfitPoints"],
                magic=order["magic"],
                comment=order["comment"],
                symbol=order["symbol"],
                point_size=order["pointSize"],
            )
        except DemoAccountRequiredError as exc:
            logger.critical("TREND-BREAKOUT: DEMO ACCOUNT CHECK FAILED — refusing to trade", extra={"instrument": instrument, "error": str(exc)})
            self._report_trend_breakout_execution_result(instrument, order["decisionId"], ok=False, error_message=str(exc))
            return
        except Exception as exc:  # noqa: BLE001 — must never crash the main loop over this
            logger.error("trend-breakout order execution raised an unexpected error", extra={"instrument": instrument, "error": str(exc)})
            self._report_trend_breakout_execution_result(instrument, order["decisionId"], ok=False, error_message=str(exc))
            return

        logger.info("trend-breakout order execution result", extra={
            "instrument": instrument, "decision_id": order["decisionId"], "ok": result.ok, "ticket": result.ticket,
            "retcode": result.retcode, "error": result.error_message,
        })
        self._report_trend_breakout_execution_result(
            instrument, order["decisionId"], ok=result.ok, ticket=result.ticket,
            filled_price=result.price, error_message=result.error_message,
        )

    def _report_trend_breakout_execution_result(
        self, instrument: str, decision_id: str, *, ok: bool, ticket: int | None = None,
        filled_price: float | None = None, error_message: str | None = None,
    ) -> None:
        payload: dict = {"ok": ok}
        if ticket is not None:
            payload["ticket"] = ticket
        if filled_price is not None:
            payload["filledPrice"] = filled_price
        if error_message is not None:
            payload["errorMessage"] = error_message
        try:
            self._api.post_trend_breakout_execution_result(self._config.collector_account_id, instrument, decision_id, payload)
        except ApiClientError as exc:
            logger.error("failed to report trend-breakout execution result back to backend", extra={"instrument": instrument, "decision_id": decision_id, "error": str(exc)})

    def _poll_and_execute_trend_breakout_close_request(self, instrument: str) -> None:
        """Trend-breakout close-request — symmetric to
        `_poll_and_execute_pending_trend_breakout_order`, for the dashboard's
        "request close" action (`TrendBreakoutController.requestClose`).
        Same failure posture: never crashes the main loop, every outcome is
        reported back so the backend row never sits stuck. Reports `ok=True`
        (which the backend records as CLOSED) ONLY when `executor.close_position`
        itself returns a broker-confirmed success (order_send() succeeded).
        """
        try:
            response = self._api.get_trend_breakout_close_request(self._config.collector_account_id, instrument)
        except ApiClientError as exc:
            logger.warning("trend-breakout close-request poll failed, will retry next tick", extra={"instrument": instrument, "error": str(exc)})
            return

        request = response.get("request")
        if not request:
            return

        logger.info("trend-breakout close-request claimed, attempting execution", extra={
            "instrument": instrument, "request_id": request["requestId"], "ticket": request["ticket"], "side": request["side"], "volume": request["volume"],
        })

        try:
            result = self._executor.close_position(
                ticket=request["ticket"], side=request["side"], volume=request["volume"], symbol=request["symbol"],
            )
        except Exception as exc:  # noqa: BLE001 — must never crash the main loop over this
            logger.error("trend-breakout close-position execution raised an unexpected error", extra={"instrument": instrument, "error": str(exc)})
            self._report_trend_breakout_close_result(instrument, request["requestId"], ok=False, error_message=str(exc))
            return

        logger.info("trend-breakout close-position execution result", extra={
            "instrument": instrument, "request_id": request["requestId"], "ok": result.ok, "ticket": result.ticket,
            "retcode": result.retcode, "error": result.error_message,
        })
        self._report_trend_breakout_close_result(
            instrument, request["requestId"], ok=result.ok, deal_ticket=result.ticket,
            closed_price=result.price, error_message=result.error_message,
        )

    def _report_trend_breakout_close_result(
        self, instrument: str, request_id: str, *, ok: bool, deal_ticket: int | None = None,
        closed_price: float | None = None, error_message: str | None = None,
    ) -> None:
        payload: dict = {"ok": ok}
        if deal_ticket is not None:
            payload["dealTicket"] = deal_ticket
        if closed_price is not None:
            payload["closedPrice"] = closed_price
        if error_message is not None:
            payload["errorMessage"] = error_message
        try:
            self._api.post_trend_breakout_close_result(self._config.collector_account_id, instrument, request_id, payload)
        except ApiClientError as exc:
            # The close attempt already happened (or definitively failed) at
            # the broker by this point — a failure to REPORT that back is a
            # visibility problem, not a trading-safety one, but it does mean
            # the request row stays stuck as SENT until this is noticed.
            logger.error("failed to report trend-breakout close result back to backend", extra={"instrument": instrument, "request_id": request_id, "error": str(exc)})

    def _trade_sync_due(self) -> bool:
        if self._last_trade_sync_at is None:
            return True
        elapsed = (datetime.now(tz=timezone.utc) - self._last_trade_sync_at).total_seconds()
        return elapsed >= TRADE_SYNC_INTERVAL_SECONDS

    def _sync_trades(self) -> None:
        try:
            cursor = self._api.get_cursor(self._config.collector_account_id)
        except ApiClientError as exc:
            logger.warning("could not fetch sync cursor, skipping this trade-sync tick",
                            extra={"error": str(exc)})
            return

        last_synced_at = cursor.get("lastSyncedAt")
        if last_synced_at:
            date_from = _parse_iso(last_synced_at) - timedelta(
                minutes=self._config.history_sync_overlap_minutes
            )
        else:
            date_from = datetime.now(tz=timezone.utc) - timedelta(days=self._config.initial_sync_days)

        deals = self._client.get_deals_since(date_from)
        payload = build_trades_payload(self._config.collector_account_id, deals)

        try:
            result = self._api.post_trades(payload)
            logger.info("trade sync pushed", extra={
                "date_from": date_from.isoformat(), "deals_sent": len(deals),
                "trades_created": result.get("created"), "trades_updated": result.get("updated"),
            })
        except ApiClientError as exc:
            logger.warning("trade sync push failed, cursor unchanged, will retry next tick",
                            extra={"error": str(exc)})
            return

        print(format_deals_table(deals, days=self._config.initial_sync_days))
        self._last_trade_sync_at = datetime.now(tz=timezone.utc)

    def _candle_sync_due(self) -> bool:
        if not self._config.candle_symbols:
            return False  # off by default — CANDLE_SYMBOLS unset
        if self._last_candle_sync_at is None:
            return True
        elapsed = (datetime.now(tz=timezone.utc) - self._last_candle_sync_at).total_seconds()
        return elapsed >= self._config.candle_sync_interval_seconds

    def _sync_candles(self) -> None:
        """Historical chart reconstruction phase — one (symbol, timeframe)
        pair at a time: ask the backend for its own latest stored candle
        (server cursor, same "never local state" reasoning _sync_trades
        already uses), backfill from there (or from CANDLE_INITIAL_SYNC_DAYS
        ago if nothing stored yet) to now, and push in bounded batches.
        A slow first-ever backfill for one pair must never stop the others
        from being attempted this tick.
        """
        for symbol in self._config.candle_symbols:
            for timeframe in _timeframes_for(self._config, symbol):
                try:
                    self._sync_one_candle_series(symbol, timeframe)
                except ApiClientError as exc:
                    logger.warning("candle sync push failed, will retry next tick", extra={
                        "symbol": symbol, "timeframe": timeframe, "error": str(exc),
                    })
        self._last_candle_sync_at = datetime.now(tz=timezone.utc)

    def _sync_one_candle_series(self, symbol: str, timeframe: str) -> None:
        cursor = self._api.get_latest_candle_time(symbol, timeframe)
        latest = cursor.get("latestOpenTime")

        now = datetime.now(tz=timezone.utc)
        if latest:
            # `latest` (from `historical_candles.open_time`) is the STORED,
            # broker-wall-clock-mislabeled-as-UTC value (see get_candles()'s
            # own docstring) — NOT true UTC. Found live: computing date_from
            # directly from it (as this line used to) produced a date_from
            # roughly this broker's own UTC offset AHEAD of true `now`, an
            # inverted (from > to) range that copy_rates_range answers with
            # zero rows every cycle, silently stalling incremental sync for
            # every symbol/timeframe using this path. Converted to true UTC
            # first, the same way confirmed-retest-v2/time.ts's
            # wallClockToUtc already does on the read side.
            true_utc_latest = stored_candle_time_to_true_utc(_parse_iso(latest), self._config.mt5_broker_timezone)
            bar_duration = CANDLE_DURATION_BY_TIMEFRAME[timeframe]
            date_from = true_utc_latest - (bar_duration * CANDLE_SYNC_OVERLAP_BARS)
            logger.info("candle sync (incremental)", extra={"symbol": symbol, "timeframe": timeframe, "date_from": date_from.isoformat()})
        else:
            initial_sync_days = max(
                self._config.candle_initial_sync_days,
                _MIN_INITIAL_SYNC_DAYS_BY_TIMEFRAME.get(timeframe, 0),
            )
            initial_sync_days = min(initial_sync_days, _MAX_INITIAL_SYNC_DAYS_BY_TIMEFRAME.get(timeframe, initial_sync_days))
            date_from = now - timedelta(days=initial_sync_days)
            logger.info("candle sync (initial backfill — this may take a while)", extra={
                "symbol": symbol, "timeframe": timeframe, "date_from": date_from.isoformat(),
            })

        candles = self._fetch_candles_chunked(symbol, timeframe, date_from, now)
        if not candles:
            return

        for i in range(0, len(candles), CANDLE_PUSH_BATCH_SIZE):
            batch = candles[i : i + CANDLE_PUSH_BATCH_SIZE]
            payload = build_candles_payload(symbol, timeframe, batch)
            result = self._api.post_candles(payload)
            logger.info("candle batch pushed", extra={
                "symbol": symbol, "timeframe": timeframe,
                "batch_size": len(batch), "upserted": result.get("upserted"),
            })

    def _symbol_metadata_sync_due(self) -> bool:
        if not self._config.candle_symbols:
            return False  # off by default — same posture as _candle_sync_due
        if self._last_symbol_metadata_sync_at is None:
            return True
        elapsed = (datetime.now(tz=timezone.utc) - self._last_symbol_metadata_sync_at).total_seconds()
        return elapsed >= SYMBOL_METADATA_SYNC_INTERVAL_SECONDS

    def _sync_symbol_metadata(self) -> None:
        """Gold historical-data-collection project — pushes broker-reported
        instrument specs for every configured candle symbol. Called once
        per successful connect (see _attempt_connect) and once per
        SYMBOL_METADATA_SYNC_INTERVAL_SECONDS thereafter via the main loop's
        own due-check, same two-trigger shape. A no-op when CANDLE_SYMBOLS
        is empty (existing deployments completely unaffected). One symbol
        failing (an MT5-side read error, or a push rejected by the backend)
        never stops the others from being attempted this cycle — same
        "one component's failure must never take down another" posture as
        the rest of this class.
        """
        for symbol in self._config.candle_symbols:
            try:
                info = self._client.get_instrument_verification(symbol)
            except Exception as exc:  # noqa: BLE001 — MT5-boundary call, must never crash the main loop
                logger.warning("instrument verification failed, skipping symbol-metadata push", extra={
                    "symbol": symbol, "error": str(exc),
                })
                continue

            # get_instrument_verification() degrades to None fields (rather
            # than raising) when symbol_info() itself returned None (e.g.
            # the symbol isn't in Market Watch yet) — the DTO's required
            # fields would be null in that case, so skip the push entirely
            # rather than send a payload the backend will reject anyway.
            if info.get("volume_min") is None or info.get("point") is None:
                logger.warning("symbol_info unavailable, skipping symbol-metadata push this cycle", extra={
                    "symbol": symbol,
                })
                continue

            payload = build_symbol_metadata_payload(info)
            try:
                self._api.post_symbol_metadata(payload)
                logger.info("symbol metadata pushed", extra={"symbol": symbol})
            except ApiClientError as exc:
                logger.warning("symbol-metadata push failed, will retry next sync", extra={
                    "symbol": symbol, "error": str(exc),
                })

        self._last_symbol_metadata_sync_at = datetime.now(tz=timezone.utc)

    def _tick_sync_due(self) -> bool:
        if not getattr(self._config, "tick_sync_enabled", False):
            return False  # off by default, and independent of candle_symbols -- see Config.tick_sync_enabled
        if not self._config.candle_symbols:
            return False  # off by default — same posture as _candle_sync_due
        if self._tick_sync_thread is not None and self._tick_sync_thread.is_alive():
            return False  # previous cycle's sync is still running on its own thread — never overlap two
        if self._last_tick_sync_at is None:
            return True
        effective_interval = TICK_SYNC_INTERVAL_SECONDS
        if self._tick_sync_consecutive_failures > 0:
            # Bounded failure cooldown — see TICK_SYNC_MAX_BACKOFF_SECONDS'
            # own comment. Doubles per consecutive failure, capped.
            effective_interval = min(
                TICK_SYNC_INTERVAL_SECONDS * (2 ** self._tick_sync_consecutive_failures),
                TICK_SYNC_MAX_BACKOFF_SECONDS,
            )
        elapsed = (datetime.now(tz=timezone.utc) - self._last_tick_sync_at).total_seconds()
        return elapsed >= effective_interval

    def _maybe_start_tick_sync(self) -> None:
        """Launches _sync_ticks() on its own daemon thread when due — see
        TICK_SYNC_INTERVAL_SECONDS' own comment for why this must not run
        inline in the main loop. Never starts a second thread while one is
        still running (_tick_sync_due already checks this).
        """
        if not self._tick_sync_due():
            return
        self._tick_sync_thread = threading.Thread(target=self._sync_ticks_isolated, daemon=True)
        self._tick_sync_thread.start()

    def _sync_ticks_isolated(self) -> None:
        """Thread entry point: serializes the actual MT5 call(s) against the
        main loop's own MT5 calls via `_mt5_call_lock` (blocking acquire is
        fine here — this is a background thread, not the main loop, so
        waiting briefly for a fast main-loop cycle to finish costs nothing
        the main loop's own liveness cares about), then updates the
        consecutive-failure counter that `_tick_sync_due` uses for backoff.
        """
        with self._mt5_call_lock:
            any_failure = self._sync_ticks()
        self._tick_sync_consecutive_failures = self._tick_sync_consecutive_failures + 1 if any_failure else 0

    def _sync_ticks(self) -> bool:
        """Gold historical-data-collection project — ongoing tick sync, one
        small recent window per configured symbol per cycle. See
        TICK_SYNC_INTERVAL_SECONDS' own comment for the latency trade-off
        this accepts, and for why this runs regardless of whether historical
        backfilling has succeeded (they are independent — see that same
        comment). Records every attempt into the same BackfillInterval
        ledger `backfill_gold_history.py` uses (a different `source`, see
        TICK_SYNC_SOURCE), so a genuine failure here is visible as FAILED/
        EMPTY_UNCONFIRMED evidence — never indistinguishable from
        never-having-tried.

        Returns True if any symbol's attempt this cycle ended FAILED (used
        by `_sync_ticks_isolated` to drive the bounded backoff cooldown —
        EMPTY_UNCONFIRMED is a legitimate answer, not a failure, and does
        not count).
        """
        now = datetime.now(tz=timezone.utc)
        window_start = (
            now - timedelta(seconds=TICK_SYNC_INTERVAL_SECONDS + TICK_SYNC_OVERLAP_SECONDS)
            if self._last_tick_sync_at is None
            else self._last_tick_sync_at - timedelta(seconds=TICK_SYNC_OVERLAP_SECONDS)
        )
        any_failure = False

        for symbol in self._config.candle_symbols:
            range_payload = {
                "source": TICK_SYNC_SOURCE, "symbol": symbol, "dataType": "TICK",
                "rangeStart": window_start.isoformat(), "rangeEnd": now.isoformat(),
            }
            try:
                ticks = self._client.get_ticks(symbol, window_start, now)
            except Exception as exc:  # noqa: BLE001 — MT5-boundary call, must never crash the main loop
                logger.warning("ongoing tick sync: MT5 call raised, will retry next cycle", extra={
                    "symbol": symbol, "error": str(exc),
                })
                any_failure = True
                try:
                    self._api.upsert_backfill_interval({
                        **range_payload, "status": "FAILED", "evidence": f"live sync MT5 error: {exc}",
                    })
                except ApiClientError:
                    pass  # ledger visibility is best-effort; never block the main loop over it
                continue

            if not ticks:
                try:
                    self._api.upsert_backfill_interval({
                        **range_payload, "status": "EMPTY_UNCONFIRMED", "recordCount": 0,
                        "evidence": "live sync: 0 rows, no MT5 error",
                    })
                except ApiClientError:
                    pass
                continue

            try:
                payload = build_ticks_payload(symbol, None, None, None, ticks)
                result = self._api.post_ticks(payload)
                logger.info("ongoing tick sync pushed", extra={
                    "symbol": symbol, "row_count": len(ticks), "inserted": result.get("inserted"),
                })
                self._api.upsert_backfill_interval({
                    **range_payload, "status": "COMPLETED", "recordCount": len(ticks),
                })
            except ApiClientError as exc:
                any_failure = True
                logger.warning("ongoing tick sync push failed, will retry next cycle", extra={
                    "symbol": symbol, "error": str(exc),
                })
                try:
                    self._api.upsert_backfill_interval({
                        **range_payload, "status": "FAILED", "evidence": f"live sync push failed: {exc}",
                    })
                except ApiClientError:
                    pass

        self._last_tick_sync_at = now
        return any_failure

    def _fetch_candles_chunked(self, symbol: str, timeframe: str, date_from: datetime, date_to: datetime) -> list[dict]:
        """Splits [date_from, date_to) into CANDLE_FETCH_CHUNK_DAYS-sized
        windows and fetches each separately — see CANDLE_FETCH_CHUNK_DAYS'
        own comment for why one giant request isn't safe to assume MT5 will
        honor. A single chunk failing (mt5_client.get_candles already
        degrades to an empty list on any MT5-side error) never stops the
        remaining chunks from being tried.
        """
        chunk = timedelta(days=CANDLE_FETCH_CHUNK_DAYS)
        all_candles: list[dict] = []
        chunk_start = date_from
        while chunk_start < date_to:
            chunk_end = min(chunk_start + chunk, date_to)
            all_candles.extend(self._client.get_candles(symbol, timeframe, chunk_start, chunk_end))
            chunk_start = chunk_end
        return all_candles


def _timeframes_for(config: Config, symbol: str) -> tuple[str, ...]:
    """Per-symbol CANDLE_TIMEFRAMES_<SYMBOL> override, else the global list."""
    overrides = getattr(config, "candle_timeframes_by_symbol", None) or {}
    return overrides.get(symbol, config.candle_timeframes)


def _parse_iso(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt
