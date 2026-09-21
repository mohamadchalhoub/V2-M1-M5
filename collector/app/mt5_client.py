"""Thin, read-only wrapper around the MetaTrader5 package.

There is no function here, and there must never be one added, that can
place, modify, or close a trade: no order_send, no order_check, no
order_calc_*. That guarantee holds identically in both modes below, since
both ultimately expose the exact same real MetaTrader5 API surface — the
guarantee has always come from this file's own discipline about which
functions it calls, never from the transport lacking them.

Autonomous demo trading (v2), Phase 6: order placement now exists in this
project, but deliberately NOT here — it lives in `executor.py`, the only
other file that imports MetaTrader5 (or a bridge proxy to it) and the only
file anywhere in this project that calls order_send. This file's own
invariant above stays exactly as true as it always was; the small,
separately-reviewable set of functions capable of writing anything to a
live account is now `executor.py` in full, and nowhere else.

Two modes, chosen at runtime by MT5_BRIDGE_HOST:

- **Native (local Windows dev)** — MT5_BRIDGE_HOST unset. Imports the real
  MetaTrader5 package directly, talking to a real MT5 terminal on the same
  Windows machine via its own IPC. This is the original, only mode until
  the VPS deployment — still exactly how local development works.
- **Bridge (Linux production)** — MT5_BRIDGE_HOST set. The MetaTrader5
  PyPI package ships Windows-only wheels and cannot be installed on Linux
  at all, so there is nothing to `import` natively here. Instead this
  connects over RPyC (rpyc.classic.connect) to a separate `mt5-bridge`
  Docker service (the community `lprett/mt5linux` image: Wine + a real MT5
  terminal + a small Windows-Python RPyC server, `mt5server.exe`) running
  elsewhere in the same docker-compose stack. `conn.modules["MetaTrader5"]`
  is a transparent remote proxy to the REAL MetaTrader5 module running
  inside that container — every function/constant this file already uses
  (positions_get(), TIMEFRAME_M5, POSITION_TYPE_BUY, ...) works identically
  to the native import, so no method body below needs to know which mode
  is active.

The connection is resolved lazily, inside `connect()`, not at module import
time — this preserves runner.py's existing reconnect/backoff loop (a bridge
container that isn't ready yet is a retryable connect() failure, exactly
like a not-yet-running terminal is today, not a crash at process startup).
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from app.config import CANDLE_DURATION_BY_TIMEFRAME, Config

logger = logging.getLogger("collector.mt5_client")

MT5_BRIDGE_HOST = os.environ.get("MT5_BRIDGE_HOST", "").strip()

if not MT5_BRIDGE_HOST:
    # Windows-only package; never installed/importable in the Linux bridge
    # deployment (no Linux wheel exists), hence this being conditional.
    import MetaTrader5 as mt5


@dataclass
class ConnectResult:
    ok: bool
    error_code: int | None = None
    error_message: str | None = None


class PositionsUnavailable(RuntimeError):
    """The broker could not be asked for open positions.

    Deliberately NOT a subclass of anything the snapshot loop swallows into
    an empty result: the whole point is that "unknown" must never be
    flattened into "none".
    """


class Mt5Client:
    """Owns the single MT5 terminal connection for this process."""

    def __init__(self, config: Config) -> None:
        self._config = config
        self._connected = False
        # Native mode: the module is already available at import time (see
        # top of file), so it's safe to set here directly — preserves the
        # existing behavior/tests that call get_candles() etc. without
        # calling connect() first. Bridge mode: genuinely can't be resolved
        # until connect() succeeds (that's the whole point of resolving it
        # lazily — a not-yet-ready bridge container must be a retryable
        # connect() failure, not a crash before the first connect attempt).
        self._mt5: Any = mt5 if not MT5_BRIDGE_HOST else None
        self._rpyc_conn: Any = None

    # -- connection lifecycle -------------------------------------------------

    def connect(self) -> ConnectResult:
        if MT5_BRIDGE_HOST:
            try:
                import rpyc  # only ever needed in bridge mode

                bridge_port = int(os.environ.get("MT5_BRIDGE_PORT", "18812"))
                self._rpyc_conn = rpyc.classic.connect(MT5_BRIDGE_HOST, bridge_port)
                self._mt5 = self._rpyc_conn.modules["MetaTrader5"]
            except Exception as exc:
                self._connected = False
                return ConnectResult(ok=False, error_code=None, error_message=f"mt5 bridge connection failed: {exc}")
        else:
            self._mt5 = mt5

        kwargs: dict[str, Any] = {"timeout": self._config.mt5_timeout_ms}
        if self._config.mt5_terminal_path:
            kwargs["path"] = self._config.mt5_terminal_path
        if self._config.has_explicit_credentials:
            kwargs["login"] = self._config.mt5_login
            kwargs["password"] = self._config.mt5_password
            kwargs["server"] = self._config.mt5_server

        ok = self._mt5.initialize(**kwargs)
        if not ok:
            code, message = self._mt5.last_error()
            self._connected = False
            return ConnectResult(ok=False, error_code=code, error_message=message)

        self._connected = True

        # Explicit, not left to a side effect of the candle-sync cycle (which
        # runs on its own, much slower interval) — without this, a fresh
        # connect() followed immediately by the first snapshot cycle's
        # get_live_tick() call could hit an unselected symbol before candle
        # sync has ever run, risking the exact stale-tick failure mode this
        # method exists to avoid. Best-effort: a symbol that fails to select
        # here still gets picked up once candle sync runs, so this never
        # blocks startup.
        for symbol in self._config.candle_symbols:
            self._mt5.symbol_select(symbol, True)

        return ConnectResult(ok=True)

    def disconnect(self) -> None:
        if self._connected and self._mt5 is not None:
            self._mt5.shutdown()
        if self._rpyc_conn is not None:
            self._rpyc_conn.close()
            self._rpyc_conn = None
        self._connected = False

    def is_connected(self) -> bool:
        """True only if we've successfully initialized AND the terminal
        itself currently reports an active broker connection."""
        if not self._connected:
            return False
        info = self._mt5.terminal_info()
        if info is None:
            return False
        return bool(info.connected)

    def last_error(self) -> tuple[int, str]:
        return self._mt5.last_error()

    def get_mt5_module(self) -> Any:
        """Returns the already-connected mt5 module/proxy handle (native
        import or RPyC bridge, whichever connect() resolved) — the ONLY
        reason this exists is so `executor.py`'s `Executor` can share this
        SAME session rather than opening a second one; nothing else should
        call this. Does not itself grant any new capability — `Executor` is
        still the only place that ever calls order_send with whatever
        handle it's given."""
        return self._mt5

    # -- read-only data access --------------------------------------------------

    def get_terminal_info(self) -> dict[str, Any] | None:
        info = self._mt5.terminal_info()
        return info._asdict() if info is not None else None

    def get_account_info(self) -> dict[str, Any] | None:
        info = self._mt5.account_info()
        if info is None:
            return None
        d = info._asdict()
        return {
            "login": d.get("login"),
            "server": d.get("server"),
            "currency": d.get("currency"),
            "balance": d.get("balance"),
            "equity": d.get("equity"),
            "margin": d.get("margin"),
            "margin_free": d.get("margin_free"),
            "margin_level": d.get("margin_level"),
            "profit": d.get("profit"),
            "leverage": d.get("leverage"),
            "trade_allowed": d.get("trade_allowed"),
            # Autonomous demo trading (v2) — promoted to a first-class field
            # alongside the others above (was previously only reachable via
            # "raw") because it's the input to this project's single most
            # safety-critical check (executor.py's verify_demo_account()):
            # MT5's ACCOUNT_TRADE_MODE_REAL/DEMO/CONTEST integer enum.
            "trade_mode": d.get("trade_mode"),
            # ACCOUNT_MARGIN_MODE_* — how the broker accounts for positions.
            # Read alongside trade_mode because the active strategy's two
            # execution slots can only hold independent positions with
            # independent brackets on a HEDGING account.
            "margin_mode": d.get("margin_mode"),
            "raw": d,
        }

    def get_live_tick(self, symbol: str) -> dict[str, Any] | None:
        """A genuine live bid/ask for `symbol`, called from this same
        long-lived, already-connected session — NOT a substitute for a
        separate one-off `mt5.initialize()` from a different process, which
        was verified live to return a stale cached tick instead of a fresh
        one (a real investigation this session: symbol_info_tick() can
        return the last-known tick if the calling session hasn't kept the
        symbol actively selected in Market Watch; this collector's own
        ongoing candle sync already does that for `symbol` continuously, so
        calling it from here is safe in a way a fresh ad-hoc script is not).
        Exists to close the gap between this system's coarsest live number
        (an M5 candle close, up to ~10 minutes stale by the time it's
        synced) and what a trader actually sees on their own terminal.
        """
        tick = self._mt5.symbol_info_tick(symbol)
        if tick is None:
            code, message = self._mt5.last_error()
            if code != 1:
                logger.warning("symbol_info_tick returned None", extra={"mt5_error": message, "symbol": symbol})
            return None
        d = tick._asdict()
        return {
            "symbol": symbol,
            "bid": d.get("bid"),
            "ask": d.get("ask"),
            # Same broker-local-mislabeled-as-UTC quantity deal/position
            # times are (see _mt5_time_to_utc's own docstring) — corrected
            # the same way for consistency, even though callers currently
            # only use bid/ask, not this field.
            "time": _mt5_time_to_utc(d.get("time"), self._config.mt5_broker_timezone),
        }

    def get_symbol_info(self, symbol: str) -> dict[str, Any] | None:
        """trend-breakout strategy (v3) — read-only broker symbol metadata
        (volume min/max/step, price increment, contract size, profit
        currency). Fully in keeping with this file's own read-only
        invariant (see the module docstring): `symbol_info()` never places,
        modifies, or closes anything.

        This is the piece §2/§9/§10 of the new strategy's spec needed and
        this project never had before ("no symbol-metadata fetch exists
        anywhere in this system" — technical-analysis/point-value.ts's own
        comment, from before this phase): the old EURUSD-only strategy got
        away with a single hardcoded point-size constant; a genuinely
        multi-instrument strategy (EURUSD AND gold, with materially
        different point sizes and contract specs) cannot.
        """
        info = self._mt5.symbol_info(symbol)
        if info is None:
            code, message = self._mt5.last_error()
            if code != 1:
                logger.warning("symbol_info returned None", extra={"mt5_error": message, "symbol": symbol})
            return None
        d = info._asdict()
        return {
            "symbol": symbol,
            "volume_min": d.get("volume_min"),
            "volume_max": d.get("volume_max"),
            "volume_step": d.get("volume_step"),
            "digits": d.get("digits"),
            "point": d.get("point"),
            "contract_size": d.get("trade_contract_size"),
            "profit_currency": d.get("currency_profit"),
        }

    def get_open_positions(self) -> list[dict[str, Any]]:
        """Open positions, or PositionsUnavailable when the broker could not
        be asked.

        The distinction is load-bearing and used to be lost here. The backend
        treats a positions list as AUTHORITATIVE: `replaceOpenPositions`
        marks every stored position that is missing from it as CLOSED. So an
        empty list does not mean "nothing came back", it means "the broker
        says you have nothing open".

        `positions_get()` returns None both for a genuine zero and for a
        genuine failure, separated only by `last_error()`. This previously
        returned `[]` for both, so one dropped trade-server connection could
        mark a live position closed - and, since a closed position releases
        its rule-family slot, hand that slot to a new entry while the old
        one was still open at the broker.

        Raising on failure means the snapshot for that cycle is simply not
        sent. Nothing is marked closed on the strength of an answer the
        broker never gave.
        """
        positions = self._mt5.positions_get()
        if positions is None:
            code, message = self._mt5.last_error()
            if code != 1:  # 1 == RES_S_OK; None can also just mean "zero positions"
                logger.error(
                    "positions_get failed - refusing to report an empty position list, "
                    "because the backend would treat it as authoritative and close open positions",
                    extra={"mt5_error": message, "mt5_code": code},
                )
                raise PositionsUnavailable(f"positions_get failed: {message} (code {code})")
            return []

        result = []
        for p in positions:
            d = p._asdict()
            side = "BUY" if d.get("type") == self._mt5.POSITION_TYPE_BUY else (
                "SELL" if d.get("type") == self._mt5.POSITION_TYPE_SELL else f"UNKNOWN({d.get('type')})"
            )
            result.append({
                "ticket": d.get("ticket"),
                "symbol": d.get("symbol"),
                "side": side,
                "volume": d.get("volume"),
                "price_open": d.get("price_open"),
                "price_current": d.get("price_current"),
                "sl": d.get("sl"),
                "tp": d.get("tp"),
                "swap": d.get("swap"),
                "profit": d.get("profit"),
                "opened_at": _mt5_time_to_utc(d.get("time"), self._config.mt5_broker_timezone),
                "comment": d.get("comment"),
                "raw": d,
            })
        return result

    def get_recent_deals(self, days: int) -> list[dict[str, Any]]:
        """Trading deals only (BUY/SELL) from the last `days` days.

        Convenience wrapper over get_deals_since() for the console printout
        (Phase 1); the actual sync loop (Phase 2) calls get_deals_since()
        directly with a server-supplied cursor.
        """
        date_from = datetime.now(tz=timezone.utc) - timedelta(days=days)
        return self.get_deals_since(date_from)

    def get_deals_since(self, date_from: datetime) -> list[dict[str, Any]]:
        """Trading deals only (BUY/SELL) from `date_from` to now.

        Excludes balance/credit/commission/correction bookkeeping entries,
        which share the same history_deals_get() call but are not trades.
        Note: a single closed position produces at least two deals (entry
        and exit) — this is a raw listing, not yet paired into round-trip
        trades. Pairing is deferred to Phase 3 analytics, not solved here
        (see the Phase 1 MT5 verification notes).
        """
        date_to = datetime.now(tz=timezone.utc)

        # Unix timestamps, not datetime objects — verified live against a
        # Wine-hosted terminal (DEPLOYMENT_SINGLE_VPS.md): history_deals_get()
        # silently returns an empty result for a datetime-object range (both
        # tz-aware and naive) covering deals that demonstrably exist, while
        # the exact same window as epoch-second integers returns them
        # correctly. copy_rates_range() (get_candles() below) does NOT share
        # THIS particular bug and keeps taking datetime objects — that part
        # is specific to history_deals_get()'s own argument handling under
        # Wine, not a blanket "MT5 + Wine can't take datetimes" issue.
        # copy_rates_range() DOES share the separate mislabeled-epoch bug
        # described just below, though (fixed 2026-09-15 — see
        # get_candles()'s own docstring).
        #
        # On top of that, history_deals_get() filters against each deal's
        # RAW epoch — broker-local wall-clock digits mislabeled as UTC, same
        # quantity _mt5_time_to_utc() below corrects for on the way out —
        # not true UTC. A precise real-UTC "now" upper bound silently
        # excludes any deal from roughly the last `mt5_broker_timezone` UTC
        # offset (e.g. ~3h for EEST), because that deal's raw timestamp
        # still looks like it's in the future relative to a true-UTC cutoff.
        # _utc_to_mt5_epoch() converts each bound the same "fake UTC" way
        # before comparing, verified live to actually return deals a plain
        # UTC epoch silently dropped.
        deals = self._mt5.history_deals_get(
            _utc_to_mt5_epoch(date_from, self._config.mt5_broker_timezone),
            _utc_to_mt5_epoch(date_to, self._config.mt5_broker_timezone),
        )
        if deals is None:
            code, message = self._mt5.last_error()
            if code != 1:
                logger.warning("history_deals_get returned None", extra={"mt5_error": message})
            return []

        result = []
        for deal in deals:
            d = deal._asdict()
            deal_type_raw = d.get("type")
            if deal_type_raw == self._mt5.DEAL_TYPE_BUY:
                deal_type = "BUY"
            elif deal_type_raw == self._mt5.DEAL_TYPE_SELL:
                deal_type = "SELL"
            else:
                continue  # balance/credit/commission/correction/etc — not a trade

            entry_raw = d.get("entry")
            entry_map = {
                self._mt5.DEAL_ENTRY_IN: "IN",
                self._mt5.DEAL_ENTRY_OUT: "OUT",
                self._mt5.DEAL_ENTRY_INOUT: "INOUT",
                self._mt5.DEAL_ENTRY_OUT_BY: "OUT_BY",
            }
            entry = entry_map.get(entry_raw, "IN")

            result.append({
                "ticket": d.get("ticket"),
                "position_id": d.get("position_id"),
                "order": d.get("order"),
                "symbol": d.get("symbol"),
                "deal_type": deal_type,
                "entry": entry,
                "volume": d.get("volume"),
                "price": d.get("price"),
                "commission": d.get("commission"),
                "swap": d.get("swap"),
                "profit": d.get("profit"),
                "closed_at": _mt5_time_to_utc(d.get("time"), self._config.mt5_broker_timezone),
                "comment": d.get("comment"),
                "raw": d,
            })
        return result

    def get_candles(self, symbol: str, timeframe: str, date_from: datetime, date_to: datetime) -> list[dict[str, Any]]:
        """Historical chart reconstruction phase — closed OHLC candles only.

        Uses `copy_rates_range`, which can include the CURRENTLY FORMING bar
        if `date_to` is now or later — that bar is deliberately excluded here
        (its high/low/close will keep changing until it closes), so a caller
        never has to know MT5's own semantics to avoid storing a bar that
        isn't done yet.

        `date_from`/`date_to` are true-UTC datetimes on the way in; MT5's own
        `copy_rates_range` matches them against each bar's RAW epoch — broker
        wall-clock digits mislabeled as UTC (same as `history_deals_get`, see
        `get_deals_since()` above and the 2026-09-15 verification report's
        §1.3/§4, confirmed live this session in
        `verification/candle-sync-fix/`) — so query bounds are converted with
        `_utc_to_mt5_epoch()` the same way, not passed straight through as
        datetimes. Without this, "now" as a true-UTC upper bound silently
        excluded any bar from roughly the last broker-UTC-offset hours, while
        the stored data still looked fresh (the excluded window kept
        shrinking back in, one cycle late, as true time advanced past it).

        `r["time"]` on the way OUT is deliberately left as the same raw
        mislabeled epoch it always was (`open_time` below is still a naive
        UTC-labeled decode, not `_mt5_time_to_utc()`-corrected) — this file's
        stored `open_time` convention, and every consumer of it (the
        confirmed-retest research `data-source.ts`'s `wallClockToUtc`, the
        breakout strategy, existing `historical_candles` rows), already
        expects and re-corrects that same mislabeled value at read time.
        Correcting it here too would double-convert every new bar against
        the millions of old ones already stored the old way — only the query
        *bound* was ever actually broken; the stored representation was not.
        """
        timeframe_by_name = self._timeframe_constants()
        mt5_timeframe = timeframe_by_name.get(timeframe)
        if mt5_timeframe is None:
            raise ValueError(f"Unsupported timeframe {timeframe!r} — must be one of {sorted(timeframe_by_name)}")

        rates = self._mt5.copy_rates_range(
            symbol,
            mt5_timeframe,
            _utc_to_mt5_epoch(date_from, self._config.mt5_broker_timezone),
            _utc_to_mt5_epoch(date_to, self._config.mt5_broker_timezone),
        )
        if rates is None:
            code, message = self._mt5.last_error()
            if code != 1:
                logger.warning("copy_rates_range returned None", extra={
                    "symbol": symbol, "timeframe": timeframe, "mt5_error": message,
                })
            return []

        # "Still forming" must compare like with like: r["time"] stays the
        # raw mislabeled epoch (see above), so "now" is converted into that
        # same mislabeled epoch too, rather than comparing a true-UTC `now`
        # against a mislabeled `open_time` (which would falsely call every
        # recent bar "still forming", since the mislabeled time reads ahead
        # of true UTC by the broker's own offset).
        now = datetime.now(tz=timezone.utc)
        now_mislabeled_epoch = _utc_to_mt5_epoch(now, self._config.mt5_broker_timezone)
        bar_duration = CANDLE_DURATION_BY_TIMEFRAME[timeframe]
        result = []
        for r in rates:
            if int(r["time"]) + bar_duration.total_seconds() > now_mislabeled_epoch:
                continue  # still forming — hasn't reached its own close time yet
            open_time = datetime.fromtimestamp(int(r["time"]), tz=timezone.utc)
            result.append({
                "open_time": open_time.isoformat(),
                "open": float(r["open"]),
                "high": float(r["high"]),
                "low": float(r["low"]),
                "close": float(r["close"]),
                "volume": float(r["tick_volume"]) if r["tick_volume"] is not None else None,
            })
        return result

    def get_ticks(self, symbol: str, date_from: datetime, date_to: datetime) -> list[dict[str, Any]]:
        """Gold historical-data-collection project — tick-level history via
        `copy_ticks_range`.

        Deliberately does NOT mirror `get_candles()`'s "degrade to an empty
        list on any error" shape. Live evidence from the gold tick backfill
        (2026-09-13) showed why that shape is wrong for ticks specifically:
        a genuine hard failure (`last_error()` code -1, "Terminal: Call
        failed") and a genuine confirmed-empty result (code 1 "Success",
        zero rows) both produced `[]` from this method, so the caller could
        not tell "the broker has no ticks here" from "the call itself
        failed" — they were recorded identically (EMPTY_UNCONFIRMED/
        EMPTY_CONFIRMED) even though only one of those is actually evidence
        about the data. This method now raises on a genuine error (code !=
        1) and only returns `[]` for a real code-1 empty result. All three
        current call sites (`backfill_gold_history.py`'s tick fetch/recheck
        and representative-day probe, and `runner.py`'s `_sync_ticks`
        ongoing-sync cycle) already wrap this call in `try/except` and
        record FAILED on an exception — this fix makes that existing
        handling actually reachable instead of dead code. `get_candles()`
        is intentionally left as-is: its only unguarded caller
        (`runner.py`'s live candle-sync loop) has no try/except around it
        and documents relying on the empty-list degrade to avoid crashing
        that loop — changing it would risk the live trading data collector,
        which is out of scope here.

        `time_msc` (milliseconds since epoch) IS already true UTC — unlike
        the position/deal `time` fields `_mt5_time_to_utc()` exists to
        correct for (see that function's own docstring). Do NOT apply that
        broker-timezone correction here: ticks don't need it, and doing so
        would silently corrupt every tick timestamp by the broker's UTC
        offset. This is a deliberate omission, not a gap to "fix" later.
        """
        ticks = self._mt5.copy_ticks_range(symbol, date_from, date_to, self._mt5.COPY_TICKS_ALL)
        if ticks is None:
            code, message = self._mt5.last_error()
            if code != 1:
                logger.warning("copy_ticks_range returned None", extra={
                    "symbol": symbol, "mt5_error": message,
                })
                raise RuntimeError(f"copy_ticks_range failed: {message} (code={code})")
            return []

        result = []
        for i, t in enumerate(ticks):
            # MT5 uses 0.0, not null/NaN, to mean "no last-trade price on
            # this tick" (common for pure quote ticks on a CFD/FX symbol) —
            # falsy-0.0 check deliberately, not `is not None`.
            last = float(t["last"]) if t["last"] else None
            result.append({
                "timestamp": datetime.fromtimestamp(t["time_msc"] / 1000, tz=timezone.utc).isoformat(),
                "bid": float(t["bid"]),
                "ask": float(t["ask"]),
                "last": last,
                "volume": float(t["volume"]) if t["volume"] is not None else None,
                "volume_real": float(t["volume_real"]) if t["volume_real"] is not None else None,
                "flags": int(t["flags"]),
                "batch_seq": i,  # 0-based index within THIS returned array/call
            })
        return result

    def get_ticks_from(self, symbol: str, date_from: datetime, count: int = 2000) -> list[dict[str, Any]]:
        """Incremental ticks from a cursor, via `copy_ticks_from`.

        Used by the one-second XAUUSD observation loop. `copy_ticks_from` is
        COUNT-based rather than range-based, which is the right shape here:
        the loop knows where it got to and wants whatever has happened since,
        not a window it must guess the end of.

        Same error posture as `get_ticks`: a genuine failure raises, and only
        a real code-1 empty result returns `[]`, so "nothing happened in the
        last second" is never indistinguishable from "the call failed".

        `time_msc` is already true UTC and must NOT be run through the
        broker-timezone correction — see `get_ticks`.
        """
        ticks = self._mt5.copy_ticks_from(symbol, date_from, count, self._mt5.COPY_TICKS_ALL)
        if ticks is None:
            code, message = self._mt5.last_error()
            if code != 1:
                raise RuntimeError(f"copy_ticks_from failed: {message} (code={code})")
            return []

        result = []
        for i, t in enumerate(ticks):
            last = float(t["last"]) if t["last"] else None
            result.append({
                "timestamp": datetime.fromtimestamp(t["time_msc"] / 1000, tz=timezone.utc).isoformat(),
                "time_msc": int(t["time_msc"]),
                "bid": float(t["bid"]),
                "ask": float(t["ask"]),
                "last": last,
                "volume": float(t["volume"]) if t["volume"] is not None else None,
                "volume_real": float(t["volume_real"]) if t["volume_real"] is not None else None,
                "flags": int(t["flags"]),
                "batch_seq": i,
            })
        return result

    def get_ticks_diagnostic(self, symbol: str, date_from: datetime, date_to: datetime) -> dict[str, Any]:
        """Gold historical-data-collection project — a bounded, one-shot
        diagnostic for a failing `copy_ticks_range` (never called from the
        normal collection path; a human/investigation script calls this
        directly, exactly once per invocation, never in a retry loop —
        bounded retries are the CALLER's responsibility, this method makes
        exactly one call per invocation so the caller controls the bound).

        Captures everything needed to distinguish broker-side unavailability
        from a terminal-sync condition, a bridge/IPC timeout, or an
        unresolved cause, without guessing: the raw return value's type,
        `last_error()` CODE and message captured immediately after the call
        (not just the message — the original `get_ticks()` dropped the
        code), wall-clock elapsed time, the request bounds actually sent,
        terminal build, the installed MetaTrader5 package version, and
        whether a bridge is in play. Also makes a SECOND, independent call
        via `copy_ticks_from` (count-based, not range-based) over the same
        window as a cross-check — if one API shape succeeds where the other
        fails, that itself is diagnostic (points at something specific to
        the range-query path rather than tick history in general).
        """
        import MetaTrader5 as _mt5_module  # only for __version__ — self._mt5 may be a bridge proxy

        term = self.get_terminal_info()
        diag: dict[str, Any] = {
            "symbol": symbol,
            "requested_from_utc": date_from.isoformat(),
            "requested_to_utc": date_to.isoformat(),
            "requested_span_seconds": (date_to - date_from).total_seconds(),
            "bridge_involved": bool(os.environ.get("MT5_BRIDGE_HOST")),
            "terminal_build": term.get("build") if term else None,
            "package_version": getattr(_mt5_module, "__version__", "unknown"),
        }

        t0 = time.monotonic()
        range_result = self._mt5.copy_ticks_range(symbol, date_from, date_to, self._mt5.COPY_TICKS_ALL)
        range_elapsed = time.monotonic() - t0
        range_error_code, range_error_message = self._mt5.last_error()
        diag["copy_ticks_range"] = {
            "returned_type": type(range_result).__name__,
            "returned_none": range_result is None,
            "row_count": None if range_result is None else len(range_result),
            "elapsed_seconds": round(range_elapsed, 2),
            "last_error_code": range_error_code,
            "last_error_message": range_error_message,
        }

        # Cross-check: same window, count-based API instead of range-based.
        t0 = time.monotonic()
        from_result = self._mt5.copy_ticks_from(symbol, date_from, 1000, self._mt5.COPY_TICKS_ALL)
        from_elapsed = time.monotonic() - t0
        from_error_code, from_error_message = self._mt5.last_error()
        diag["copy_ticks_from"] = {
            "returned_type": type(from_result).__name__,
            "returned_none": from_result is None,
            "row_count": None if from_result is None else len(from_result),
            "elapsed_seconds": round(from_elapsed, 2),
            "last_error_code": from_error_code,
            "last_error_message": from_error_message,
        }

        # A best-supported (not certain) classification from the pattern of
        # evidence above — stated as a hypothesis with its basis, never as
        # a confirmed root cause MT5's own generic error text doesn't
        # actually assert.
        range_failed = diag["copy_ticks_range"]["returned_none"] or diag["copy_ticks_range"]["row_count"] == 0
        from_failed = diag["copy_ticks_from"]["returned_none"] or diag["copy_ticks_from"]["row_count"] == 0
        if diag["bridge_involved"] and (range_failed or from_failed):
            diag["hypothesis"] = "BRIDGE_IPC_TIMEOUT_POSSIBLE — a bridge is in play; rule this out first."
        elif range_failed and from_failed and range_elapsed > 30 and from_elapsed > 30:
            diag["hypothesis"] = (
                "BROKER_SIDE_UNAVAILABILITY_LIKELY — both APIs failed after a long, consistent delay "
                "(a terminal-sync 'not ready yet' condition normally returns fast/empty, not a long "
                "timeout; no bridge is configured here, ruling out bridge/IPC timeout) — consistent "
                "with the trade server simply not responding to historical tick-data requests for "
                "this demo account/symbol. Not a certainty: MT5's own error text is generic."
            )
        elif range_failed and not from_failed:
            diag["hypothesis"] = (
                "SPECIFIC_TO_RANGE_QUERY — copy_ticks_from succeeded where copy_ticks_range failed on "
                "the identical window; points at something specific to the range-query code path, not "
                "tick history in general."
            )
        elif not range_failed:
            diag["hypothesis"] = "NO_FAILURE — copy_ticks_range returned real data for this window."
        else:
            diag["hypothesis"] = "UNRESOLVED — evidence does not clearly match any of the above patterns."

        return diag

    def get_instrument_verification(self, symbol: str) -> dict[str, Any]:
        """Gold historical-data-collection project — a one-time-per-run
        sanity check (called from `backfill_gold_history.py` before any
        bulk data moves, and periodically from `runner.py`'s own
        symbol-metadata sync) that surfaces exactly which account/broker/
        server/instrument this collector is actually talking to, so a
        wrong-account or wrong-instrument mistake is visible immediately
        rather than silently backfilling the wrong data.

        Combines `get_account_info()` (login/server/account-level
        trade_mode) with a FULLER read of the same `symbol_info()` object
        `get_symbol_info()` already reads — that method's own narrower
        shape is relied on elsewhere (trend-breakout's volume/point/
        contract-size validation, and its own test) and is left completely
        unchanged; this is a separate, additive read of the same
        underlying MT5 object, not a replacement.

        Being a CFD is completely normal for a broker-traded gold/XAUUSD
        product and is NEVER treated as a red flag here — nothing below
        rejects or warns on CFD classification. The two actual red flags
        this method surfaces (as plain informational fields for a caller
        to log/decide on — never a hard rejection here) are a real,
        dated-contract expiration (`expiration_mode`/`expiration_time`
        actually set) and a non-USD `currency_profit`/`currency_margin` —
        either would mean this isn't the intended spot-style gold-vs-USD
        product.
        """
        account = self.get_account_info() or {}

        info = self._mt5.symbol_info(symbol)
        if info is None:
            code, message = self._mt5.last_error()
            if code != 1:
                logger.warning("symbol_info returned None for instrument verification", extra={
                    "symbol": symbol, "mt5_error": message,
                })
            d: dict[str, Any] = {}
        else:
            d = info._asdict()

        def field(*names: str) -> Any:
            # Tries each name in order, returning the first one actually
            # present on THIS installed MetaTrader5 package's symbol_info()
            # object. Different package versions have been observed to
            # split/rename a few fields (trade_tick_value vs
            # trade_tick_value_profit/_loss being the specific case this
            # task flagged) — this reads whichever one this build actually
            # exposes instead of hardcoding one and crashing on the other.
            for name in names:
                if name in d:
                    return d[name]
            return None

        if info is not None:
            # Logged once, not raised — an absent optional field degrades
            # to None (see build below), it never crashes this method.
            expected_optional_fields = (
                "path", "description", "currency_base", "currency_margin",
                "trade_tick_size", "trade_tick_value", "trade_tick_value_profit",
                "trade_stops_level", "trade_freeze_level", "swap_mode",
                "swap_long", "swap_short", "swap_rollover3days",
                "expiration_mode", "expiration_time",
            )
            missing = [name for name in expected_optional_fields if name not in d]
            if missing:
                logger.warning(
                    "symbol_info is missing some expected fields on this MT5 package/version",
                    extra={"symbol": symbol, "missing_fields": missing},
                )

        expiration_time_raw = field("expiration_time")
        # 0 (or the field being entirely absent) means "no expiration"
        # (GTC) per MT5 — never decoded as a real 1970-01-01 timestamp.
        expiration_time = (
            datetime.fromtimestamp(expiration_time_raw, tz=timezone.utc).isoformat()
            if expiration_time_raw else None
        )

        currency_profit = field("currency_profit")
        currency_margin = field("currency_margin")
        non_usd_currencies = [c for c in (currency_profit, currency_margin) if c is not None and c != "USD"]

        return {
            # Account-level — verification/logging only; NOT part of the
            # per-symbol /collector/symbol-metadata payload (that row has
            # no accountId, same posture as candles — see api_mapper.py's
            # build_symbol_metadata_payload).
            "login": account.get("login"),
            "server": account.get("server"),
            "account_trade_mode": account.get("trade_mode"),
            # Symbol-level — the fuller symbol_info() read.
            "symbol": symbol,
            "path": field("path"),
            "description": field("description"),
            "currency_base": field("currency_base"),
            "currency_profit": currency_profit,
            "currency_margin": currency_margin,
            "trade_tick_size": field("trade_tick_size"),
            # Prefer the more precise profit-side variant when this package
            # version splits it out; fall back to the single combined field
            # otherwise (see `field()`'s own comment and this method's
            # docstring).
            "trade_tick_value": field("trade_tick_value_profit", "trade_tick_value"),
            "trade_stops_level": field("trade_stops_level"),
            "trade_freeze_level": field("trade_freeze_level"),
            "trade_mode": field("trade_mode"),  # SYMBOL_TRADE_MODE_* — distinct from account_trade_mode above
            "swap_mode": field("swap_mode"),
            "swap_long": field("swap_long"),
            "swap_short": field("swap_short"),
            "swap_rollover3days": field("swap_rollover3days"),
            "expiration_mode": field("expiration_mode"),
            "expiration_time": expiration_time,
            "volume_min": field("volume_min"),
            "volume_max": field("volume_max"),
            "volume_step": field("volume_step"),
            "digits": field("digits"),
            "point": field("point"),
            "contract_size": field("trade_contract_size"),
            # Informational red flags only — see docstring. Never used to
            # reject/abort anything in this file.
            "has_real_expiration": expiration_time is not None,
            "non_usd_currencies": non_usd_currencies,
        }

    # Historical chart reconstruction phase — maps this project's own
    # timeframe strings (config.py's CANDLE_TIMEFRAMES, also the backend's
    # CandleTimeframe enum) to MetaTrader5's TIMEFRAME_* constants.
    # Deliberately not a 1:1 of every timeframe MT5 supports — see
    # config.py's _VALID_CANDLE_TIMEFRAMES comment for why the set stays
    # small. An instance method, not a module-level constant, because it
    # reads self._mt5 — only resolved once connect() has succeeded (native
    # module or bridge proxy, whichever is active).
    def _timeframe_constants(self) -> dict[str, int]:
        return {
            "M5": self._mt5.TIMEFRAME_M5,
            "M15": self._mt5.TIMEFRAME_M15,
            "H1": self._mt5.TIMEFRAME_H1,
            "M30": self._mt5.TIMEFRAME_M30,
            "H4": self._mt5.TIMEFRAME_H4,
            "D1": self._mt5.TIMEFRAME_D1,
            "W1": self._mt5.TIMEFRAME_W1,
            "MN1": self._mt5.TIMEFRAME_MN1,
            "M1": self._mt5.TIMEFRAME_M1,
        }


def stored_candle_time_to_true_utc(raw_mislabeled_utc: datetime, broker_timezone: str) -> datetime:
    """Converts a STORED `historical_candles.open_time` value (the raw,
    broker-wall-clock-mislabeled-as-UTC epoch `get_candles()` deliberately
    leaves uncorrected on the way in — see that function's own docstring)
    into true UTC, for a CONSUMER that needs a genuine UTC instant to reason
    with (e.g. computing a correct incremental-sync query bound). This is
    the exact same reinterpretation `confirmed-retest-v2/time.ts`'s
    `wallClockToUtc` already performs on the TypeScript side for research
    reads — this is its Python-side counterpart, added specifically because
    `runner.py`'s own incremental candle-sync cursor was found doing the
    naive (wrong) thing: treating the stored cursor as if it were already
    true UTC when computing its next `date_from`, which silently produced a
    `date_from` roughly `broker_timezone`'s own UTC offset AHEAD of the true
    current time — an inverted (from > to) query range that `copy_rates_range`
    answers with zero rows, forever, every cycle, for every timeframe.
    """
    epoch_seconds = int(raw_mislabeled_utc.timestamp())
    true_utc_iso = _mt5_time_to_utc(epoch_seconds, broker_timezone)
    return datetime.fromisoformat(true_utc_iso)


def _mt5_time_to_utc(epoch_seconds: int | None, broker_timezone: str) -> str | None:
    """Converts a position/deal `time` field to a true UTC ISO timestamp.

    MT5 reports these fields as an epoch integer computed from the broker/
    trade-server's own wall-clock components, not true UTC. Candle OHLC bar
    times share this same mislabeling (verified 2026-09-15, see
    `get_candles()`'s docstring and the verification report's §1.3/§4) —
    but this function is still deliberately NOT called on candle bar times:
    the collector stores their raw mislabeled epoch as-is (unlike positions/
    deals, corrected here on the way in), and the confirmed-retest research
    layer (`data-source.ts`'s `wallClockToUtc`) re-corrects it at read time
    instead, matching millions of already-stored rows. Naively decoding the
    epoch as UTC (`datetime.fromtimestamp(epoch, tz=utc)`) reproduces those
    broker-local wall-clock digits, mislabeled as UTC. The fix: decode the
    epoch the same naive way to recover those wall-clock digits, then
    RE-interpret them as being in `broker_timezone` (resolving whichever of
    that zone's UTC offsets — e.g. EET's EET/EEST — actually applies on that
    date) and convert properly to true UTC.
    """
    if epoch_seconds is None:
        return None
    broker_wall_clock = datetime.fromtimestamp(epoch_seconds, tz=timezone.utc).replace(tzinfo=None)
    broker_aware = broker_wall_clock.replace(tzinfo=ZoneInfo(broker_timezone))
    return broker_aware.astimezone(timezone.utc).isoformat()


def _utc_to_mt5_epoch(dt_utc: datetime, broker_timezone: str) -> int:
    """Inverse of `_mt5_time_to_utc()` — converts a true-UTC datetime into
    the "fake epoch" history_deals_get()'s date_from/date_to expect.

    Verified live (DEPLOYMENT_SINGLE_VPS.md): a precise real-UTC `datetime.now()`
    epoch as date_to silently excludes deals from roughly the last
    broker-UTC-offset hours, because the broker server compares against
    each deal's raw epoch — broker-local wall-clock digits mislabeled as
    UTC, not true UTC (same quantity `_mt5_time_to_utc()` decodes on the
    way out). This produces that same mislabeled quantity for a query
    bound: take the broker-local wall-clock digits for this instant, then
    encode THOSE digits as if they were UTC.
    """
    broker_local = dt_utc.astimezone(ZoneInfo(broker_timezone))
    naive_wall_clock = broker_local.replace(tzinfo=None)
    return int(naive_wall_clock.replace(tzinfo=timezone.utc).timestamp())
