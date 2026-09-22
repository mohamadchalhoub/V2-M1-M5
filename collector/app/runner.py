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

# xauusd-m1-m5-rsi-threshold-v2 -- the only symbol this project's strategy
# trades. Named here rather than read from config so it cannot drift from the
# backend's own frozen SPEC.symbol.
M1M5_SYMBOL = "XAUUSD"

# How recent a tick must be for the broker session to count as OPEN.
#
# Generous on purpose. This is not the quote-freshness gate -- the backend
# applies its own, tighter one before acting on a price. This answers the much
# coarser question "is the market trading at all", where a quiet minute in thin
# conditions must not read as a closed market and trigger a weekend-style
# entry block.
M1M5_SESSION_TICK_MAX_AGE_SECONDS = 120

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
        })

        backoff = self._config.reconnect_initial_backoff_seconds
        if self._config.rsi_execution_enabled:
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
        tick_at = tick.get("time")
        if tick_at is None:
            return None
        age = (datetime.now(timezone.utc) - tick_at).total_seconds()
        return 0 <= age <= M1M5_SESSION_TICK_MAX_AGE_SECONDS

    def _poll_and_execute_pending_m1m5_order(self) -> None:
        """Claims one approved entry and places it.

        Same failure posture as every other execution poll here: it never
        crashes the main loop, and every outcome is reported back so nothing is
        left silently in flight.

        An ambiguous broker response is reported as uncertain=True, never as
        ok=False. The backend records that as UNKNOWN and KEEPS the timeframe
        slot occupied, because a lost response does not mean the order never
        reached the broker -- and freeing the slot would permit a second
        position on a timeframe that may already hold one.
        """
        try:
            response = self._api.get_pending_m1m5_order(self._config.collector_account_id)
        except ApiClientError as exc:
            logger.warning("xauusd-m1m5 pending-order poll failed, will retry next tick", extra={"error": str(exc)})
            return

        order = response.get("order")
        if not order:
            return

        if not order.get("volume"):
            # The backend sizes every order before queueing it. A row without a
            # volume is a row whose risk approval cannot be reconstructed, so
            # it is refused rather than filled in with a default here.
            self._report_m1m5_execution_result(
                order["decisionId"], ok=False,
                error_message="queued order carried no volume; refusing to substitute a default",
            )
            return

        logger.info("xauusd-m1m5 pending order claimed, attempting execution", extra={
            "decision_id": order["decisionId"], "timeframe": order.get("timeframe"),
            "side": order["side"], "volume": order["volume"], "magic": order["magic"],
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
            logger.critical("XAUUSD-M1M5: DEMO ACCOUNT CHECK FAILED - refusing to trade", extra={"error": str(exc)})
            self._report_m1m5_execution_result(order["decisionId"], ok=False, error_message=str(exc))
            return
        except Exception as exc:  # noqa: BLE001 - must never crash the main loop
            logger.error("xauusd-m1m5 order execution raised an unexpected error", extra={"error": str(exc)})
            self._report_m1m5_execution_result(order["decisionId"], ok=False, error_message=str(exc))
            return

        # Neither a ticket nor a broker retcode means the executor could not
        # establish what happened -- genuinely uncertain, as distinct from a
        # broker that clearly refused.
        uncertain = (not result.ok) and result.ticket is None and result.retcode is None

        logger.info("xauusd-m1m5 order execution result", extra={
            "decision_id": order["decisionId"], "ok": result.ok, "ticket": result.ticket,
            "retcode": result.retcode, "uncertain": uncertain, "error": result.error_message,
        })

        broker_sl, broker_tp = self._read_position_protection(result.ticket, order["symbol"])
        self._report_m1m5_execution_result(
            order["decisionId"], ok=result.ok, ticket=result.ticket,
            filled_price=result.price, error_message=result.error_message,
            uncertain=uncertain, broker_stop_loss=broker_sl, broker_take_profit=broker_tp,
        )

    def _report_m1m5_execution_result(
        self, decision_id: str, *, ok: bool, ticket: int | None = None,
        filled_price: float | None = None, error_message: str | None = None,
        uncertain: bool = False, broker_stop_loss: float | None = None,
        broker_take_profit: float | None = None,
    ) -> None:
        payload: dict[str, Any] = {"ok": ok, "uncertain": uncertain}
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
        try:
            self._api.post_m1m5_execution_result(self._config.collector_account_id, decision_id, payload)
        except ApiClientError as exc:
            # The order may be live and the backend may not know. Loud, because
            # reconciliation is now the only thing that can resolve it.
            logger.error(
                "xauusd-m1m5 execution result report FAILED; the backend does not know this outcome",
                extra={"decision_id": decision_id, "error": str(exc)},
            )

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
