"""Environment-driven configuration for the MT5 collector.

No credential ever has a default value baked into code — every field here
either comes from the environment or is a non-secret operational default
(interval, timeout, log level).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


class ConfigError(Exception):
    """Raised when the environment is missing or contains invalid configuration."""


_LOG_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
_LOG_FORMATS = {"json", "text"}
# Historical chart reconstruction phase — the timeframes mt5_client.py knows
# how to map to MetaTrader5's own TIMEFRAME_* constants. Kept small and
# explicit rather than accepting anything MT5 supports: M5/M15/H1 cover the
# "context before, all of, and context after" window a trade chart needs
# (Phase 3 of the historical-chart spec) without inviting an unbounded tick-
# level backfill by accident. M30/H4/D1 added for the technical-analysis
# phase (support/resistance, Ichimoku, Fibonacci) — real MT5-native
# candles, not resampled from finer timeframes, same reasoning as the
# original three. W1/MN1 added for Ichimoku breakout alerts on the weekly
# and monthly timeframes, same reasoning again.
# Gold historical-data-collection project — M1 added for the tick/candle
# backfill's finest granularity (backfill_gold_history.py). Nothing in this
# project's own indicators/warm-up requirements uses M1 (see that script's
# own comment); it exists purely as raw stored history.
_VALID_CANDLE_TIMEFRAMES = {"M5", "M15", "H1", "M30", "H4", "D1", "W1", "MN1", "M1"}
# Single source of truth for "how long does one bar of this timeframe
# span" — mt5_client.py (filtering out a still-forming bar) and runner.py
# (the candle-sync overlap window) both need this and must never disagree.
# MN1 uses 31 days (the longest possible calendar month) rather than a
# calendar-aware duration: erring long only means a just-closed 28/29/30-day
# monthly bar is treated as "still forming" for a few extra days (picked up
# on the next poll instead), which is safe; erring short would risk
# including a bar that hasn't actually closed yet, which is not.
CANDLE_DURATION_BY_TIMEFRAME = {
    "M5": timedelta(minutes=5),
    "M15": timedelta(minutes=15),
    "H1": timedelta(hours=1),
    "M30": timedelta(minutes=30),
    "H4": timedelta(hours=4),
    "D1": timedelta(days=1),
    "W1": timedelta(weeks=1),
    "MN1": timedelta(days=31),
    "M1": timedelta(minutes=1),
}


@dataclass(frozen=True)
class Config:
    # Optional explicit login. If none of the three are set, the collector
    # attaches to whatever account is already logged into the running
    # terminal. If any one is set, all three are required (see _require_all).
    mt5_login: int | None
    mt5_password: str | None
    mt5_server: str | None

    # Optional explicit path to terminal64.exe; if unset, the package
    # searches the default install locations itself.
    mt5_terminal_path: str | None
    mt5_timeout_ms: int

    # FAIL-CLOSED TERMINAL BINDING.
    #
    # When true, MT5_TERMINAL_PATH must be set AND must exist on disk, or the
    # collector refuses to start. This exists because MetaTrader5's
    # initialize() auto-discovers a terminal when given no path, and on a host
    # that runs more than one trading bot the terminal it discovers may belong
    # to a DIFFERENT bot -- which would silently attach this collector to
    # another system's account and let it act on positions it does not own.
    #
    # Failing to start is strictly better than starting against the wrong
    # terminal: the first is obvious and recoverable, the second is neither.
    mt5_require_explicit_terminal: bool

    # When set, the account the terminal reports after connecting MUST equal
    # this value, or the collector disconnects and refuses to run. Belt and
    # braces alongside the terminal path: a correct path to a terminal that
    # happens to be logged into the wrong account is still the wrong account.
    mt5_expected_login: int | None

    # Reliability pass — found live this session: MT5's position/deal `time`
    # fields are the broker/trade-server's own wall-clock components,
    # reported as a raw epoch integer AS IF they were already UTC — not true
    # UTC (candle OHLC bar times are unaffected; this is specific to
    # position/deal execution timestamps, a well-documented MT5 quirk).
    # MetaQuotes' own demo servers (this deployment's real server,
    # "MetaQuotes-Demo") run on the EU's own DST convention (EET winter /
    # EEST summer) — confirmed live: a real open position's raw MT5 time,
    # naively decoded as UTC, was ~2h44m ahead of true UTC; decoding it as
    # EET/EEST and converting properly landed within a plausible ~15 minutes
    # of true UTC (ordinary collector-clock/processing slop, not something
    # further correction should chase). Configurable because this is
    # genuinely broker-specific, not a universal constant — a different
    # broker (e.g. once a real, non-demo account connects) may use a
    # different server-time convention.
    mt5_broker_timezone: str

    poll_interval_seconds: int
    history_days: int

    reconnect_initial_backoff_seconds: float
    reconnect_max_backoff_seconds: float

    log_level: str
    log_format: str

    # Backend push (Phase 2) — all three required; this collector's job is
    # now to deliver data, not just print it.
    collector_api_base_url: str
    collector_api_key: str
    collector_account_id: str
    collector_api_timeout_seconds: int

    initial_sync_days: int
    history_sync_overlap_minutes: int

    # Historical chart reconstruction phase — candles are symbol/timeframe
    # data (no account concept), backfilled once from CANDLE_INITIAL_SYNC_DAYS
    # ago and then kept current on CANDLE_SYNC_INTERVAL_SECONDS. Off by
    # default in the sense that CANDLE_SYMBOLS is empty unless set — no
    # existing deployment is affected until a trader opts in.
    candle_symbols: tuple[str, ...]
    candle_timeframes: tuple[str, ...]
    candle_sync_interval_seconds: int
    candle_initial_sync_days: int

    # Autonomous demo trading (v2), Phase 6 — off by default, same posture
    # as CANDLE_SYMBOLS above and this codebase's TypeScript side's
    # AI_ENABLED/MARKET_EVENTS_ENABLED: an existing, already-running
    # collector's behavior is completely unchanged unless a trader
    # explicitly opts in. When true, the collector's own normal poll loop
    # additionally checks the backend for an approved pending order (for
    # THIS collector's own collector_account_id) and, if there is one,
    # executes it via executor.py — see runner.py's own comment on this.
    autonomous_execution_enabled: bool

    # Gold collection alongside EURUSD: optional per-symbol override of
    # CANDLE_TIMEFRAMES via CANDLE_TIMEFRAMES_<SYMBOL> (e.g.
    # CANDLE_TIMEFRAMES_XAUUSD=M1,M5,M15,M30,H1,H4,D1). A symbol with no
    # override keeps the global list, so an existing EURUSD deployment's
    # collection is unchanged.
    candle_timeframes_by_symbol: dict[str, tuple[str, ...]] | None = None

    # Gold (XAUUSD) execution poll — deliberately a SEPARATE flag from
    # autonomous_execution_enabled (EURUSD), off by default, so the two
    # strategies' activation can never be coupled by one env var. When
    # true, the collector's poll loop additionally checks the backend's
    # gold-execution route for an approved pending gold order and executes
    # it via executor.py (same module, gold's own magic number/symbol/point
    # size passed through — no gold-specific order code in executor.py).
    gold_execution_enabled: bool = False

    # Trend-breakout (EURUSD + XAUUSD) execution poll — its OWN flag,
    # deliberately separate from both autonomous_execution_enabled (legacy
    # EURUSD) and gold_execution_enabled, off by default, so this strategy's
    # activation can never be coupled to either other one. When true, the
    # collector's poll loop additionally checks the backend's
    # trend-breakout route for an approved pending order, looped over BOTH
    # instruments (EURUSD, XAUUSD) each cycle — see
    # golden-singing-pearl.md's confirmed "both instruments go live
    # together" decision.
    trend_breakout_execution_enabled: bool = False

    # xauusd-m1-rsi-retest-extremes-v1 — the active strategy. Its OWN flag,
    # off by default like every other execution flag here, so enabling it is
    # always a deliberate act. When true the collector does two extra things
    # each cycle: it streams recent XAUUSD ticks to the backend at the main
    # poll cadence (so the strategy observes ordered broker ticks within
    # seconds rather than waiting for the 5-minute archival tick sync), and
    # it polls the strategy's own pending-order route.
    rsi_execution_enabled: bool = False

    # xauusd-m1-m5-rsi-threshold-v2 -- THIS project's strategy. Its own flag,
    # off by default, and deliberately separate from every flag above: those
    # belong to strategies this deployment does not run, and a shared flag
    # would make enabling one of them enable this too.
    #
    # When true the collector does two extra things each cycle: it reports the
    # terminal's own trading permissions to the backend (which refuses to
    # submit without a recent report), and it polls this strategy's own
    # pending-order route.
    m1m5_execution_enabled: bool = False
    # Engine B. Separate from m1m5_execution_enabled on purpose: an
    # operator turning one engine's execution off must not silently
    # turn the other's off, or on.
    telegram_engine_execution_enabled: bool = False
    # Engine A REPLACEMENT: xauusd-sar-v1. Separate from m1m5_execution_enabled
    # for the same reason — m1m5_execution_enabled now governs only the frozen
    # RSI strategy's residual close/protection polling, never a new entry.
    sar_execution_enabled: bool = False

    def timeframes_for(self, symbol: str) -> tuple[str, ...]:
        return (self.candle_timeframes_by_symbol or {}).get(symbol, self.candle_timeframes)

    @staticmethod
    def from_env(env: dict[str, str] | None = None) -> "Config":
        e = os.environ if env is None else env

        login_raw = e.get("MT5_LOGIN", "").strip()
        password = e.get("MT5_PASSWORD", "").strip() or None
        server = e.get("MT5_SERVER", "").strip() or None

        mt5_login: int | None = None
        if login_raw:
            try:
                mt5_login = int(login_raw)
            except ValueError as exc:
                raise ConfigError(
                    f"MT5_LOGIN must be an integer account number, got {login_raw!r}"
                ) from exc

        provided = [name for name, val in
                    (("MT5_LOGIN", mt5_login), ("MT5_PASSWORD", password), ("MT5_SERVER", server))
                    if val is not None]
        if provided and len(provided) != 3:
            missing = {"MT5_LOGIN", "MT5_PASSWORD", "MT5_SERVER"} - set(provided)
            raise ConfigError(
                "Partial MT5 credentials supplied. Either set MT5_LOGIN, MT5_PASSWORD "
                f"and MT5_SERVER together, or set none of them to attach to an "
                f"already-logged-in terminal. Missing: {', '.join(sorted(missing))}"
            )

        poll_interval = _read_positive_int(e, "POLL_INTERVAL_SECONDS", default=10)
        history_days = _read_positive_int(e, "HISTORY_DAYS", default=7)
        timeout_ms = _read_positive_int(e, "MT5_TIMEOUT_MS", default=60_000)

        mt5_broker_timezone = e.get("MT5_BROKER_TIMEZONE", "").strip() or "EET"
        try:
            ZoneInfo(mt5_broker_timezone)
        except ZoneInfoNotFoundError as exc:
            raise ConfigError(
                f"MT5_BROKER_TIMEZONE {mt5_broker_timezone!r} is not a valid IANA timezone name"
            ) from exc

        initial_backoff = _read_positive_float(e, "RECONNECT_INITIAL_BACKOFF_SECONDS", default=2.0)
        max_backoff = _read_positive_float(e, "RECONNECT_MAX_BACKOFF_SECONDS", default=60.0)
        if max_backoff < initial_backoff:
            raise ConfigError(
                "RECONNECT_MAX_BACKOFF_SECONDS must be >= RECONNECT_INITIAL_BACKOFF_SECONDS "
                f"(got max={max_backoff}, initial={initial_backoff})"
            )

        log_level = e.get("LOG_LEVEL", "INFO").strip().upper()
        if log_level not in _LOG_LEVELS:
            raise ConfigError(f"LOG_LEVEL must be one of {sorted(_LOG_LEVELS)}, got {log_level!r}")

        log_format = e.get("LOG_FORMAT", "json").strip().lower()
        if log_format not in _LOG_FORMATS:
            raise ConfigError(f"LOG_FORMAT must be one of {sorted(_LOG_FORMATS)}, got {log_format!r}")

        api_base_url = e.get("COLLECTOR_API_BASE_URL", "").strip()
        api_key = e.get("COLLECTOR_API_KEY", "").strip()
        account_id = e.get("COLLECTOR_ACCOUNT_ID", "").strip()
        missing = [name for name, val in (
            ("COLLECTOR_API_BASE_URL", api_base_url),
            ("COLLECTOR_API_KEY", api_key),
            ("COLLECTOR_ACCOUNT_ID", account_id),
        ) if not val]
        if missing:
            raise ConfigError(
                "Missing required backend-push configuration: " + ", ".join(missing) +
                ". Run `npm run bootstrap` in backend/ to obtain these values."
            )

        api_timeout = _read_positive_int(e, "COLLECTOR_API_TIMEOUT_SECONDS", default=10)
        initial_sync_days = _read_positive_int(e, "INITIAL_SYNC_DAYS", default=90)
        overlap_minutes = _read_positive_int(e, "HISTORY_SYNC_OVERLAP_MINUTES", default=5)

        candle_symbols = tuple(
            s.strip().upper() for s in e.get("CANDLE_SYMBOLS", "").split(",") if s.strip()
        )
        candle_timeframes_raw = e.get("CANDLE_TIMEFRAMES", "M5,M15,H1")
        candle_timeframes = tuple(t.strip().upper() for t in candle_timeframes_raw.split(",") if t.strip())
        invalid_timeframes = [t for t in candle_timeframes if t not in _VALID_CANDLE_TIMEFRAMES]
        if invalid_timeframes:
            raise ConfigError(
                f"CANDLE_TIMEFRAMES contains unsupported value(s) {invalid_timeframes}; "
                f"must be one of {sorted(_VALID_CANDLE_TIMEFRAMES)}"
            )
        candle_timeframes_by_symbol: dict[str, tuple[str, ...]] = {}
        for symbol in candle_symbols:
            override_raw = e.get(f"CANDLE_TIMEFRAMES_{symbol}", "").strip()
            if not override_raw:
                continue
            override = tuple(t.strip().upper() for t in override_raw.split(",") if t.strip())
            invalid_override = [t for t in override if t not in _VALID_CANDLE_TIMEFRAMES]
            if invalid_override or not override:
                raise ConfigError(
                    f"CANDLE_TIMEFRAMES_{symbol} contains unsupported value(s) {invalid_override or override_raw!r}; "
                    f"must be one of {sorted(_VALID_CANDLE_TIMEFRAMES)}"
                )
            candle_timeframes_by_symbol[symbol] = override
        candle_sync_interval = _read_positive_int(e, "CANDLE_SYNC_INTERVAL_SECONDS", default=300)
        candle_initial_sync_days = _read_positive_int(e, "CANDLE_INITIAL_SYNC_DAYS", default=730)

        autonomous_execution_enabled = e.get("AUTONOMOUS_EXECUTION_ENABLED", "false").strip().lower() == "true"
        gold_execution_enabled = e.get("GOLD_EXECUTION_ENABLED", "false").strip().lower() == "true"
        trend_breakout_execution_enabled = e.get("TREND_BREAKOUT_EXECUTION_ENABLED", "false").strip().lower() == "true"
        rsi_execution_enabled = e.get("XAUUSD_RSI_EXECUTION_ENABLED", "false").strip().lower() == "true"
        m1m5_execution_enabled = e.get("XAUUSD_M1M5_EXECUTION_ENABLED", "false").strip().lower() == "true"
        telegram_engine_execution_enabled = e.get("TELEGRAM_ENGINE_EXECUTION_ENABLED", "false").strip().lower() == "true"
        sar_execution_enabled = e.get("XAUUSD_SAR_EXECUTION_ENABLED", "false").strip().lower() == "true"

        require_explicit_terminal = (
            e.get("MT5_REQUIRE_EXPLICIT_TERMINAL", "false").strip().lower() == "true"
        )
        terminal_path = e.get("MT5_TERMINAL_PATH", "").strip() or None

        if require_explicit_terminal:
            if terminal_path is None:
                raise ConfigError(
                    "MT5_REQUIRE_EXPLICIT_TERMINAL=true but MT5_TERMINAL_PATH is empty. Refusing to start: "
                    "without an explicit path the MetaTrader5 package auto-discovers a terminal, and on a host "
                    "running more than one trading bot that may be another bot's terminal and another bot's "
                    "account."
                )
            if not os.path.isfile(terminal_path):
                raise ConfigError(
                    f"MT5_TERMINAL_PATH does not exist: {terminal_path!r}. Refusing to start rather than "
                    "falling back to auto-discovery, which could attach this collector to a different bot's "
                    "MT5 terminal."
                )

        expected_login_raw = e.get("MT5_EXPECTED_LOGIN", "").strip()
        expected_login: int | None = None
        if expected_login_raw:
            try:
                expected_login = int(expected_login_raw)
            except ValueError as exc:
                raise ConfigError(
                    f"MT5_EXPECTED_LOGIN must be an integer, got {expected_login_raw!r}"
                ) from exc
            if mt5_login is not None and mt5_login != expected_login:
                raise ConfigError(
                    f"MT5_LOGIN ({mt5_login}) does not match MT5_EXPECTED_LOGIN ({expected_login}). "
                    "Refusing to start: these must name the same account, and a mismatch means the "
                    "configuration is describing two different accounts."
                )

        return Config(
            mt5_require_explicit_terminal=require_explicit_terminal,
            mt5_expected_login=expected_login,
            mt5_login=mt5_login,
            mt5_password=password,
            mt5_server=server,
            mt5_terminal_path=terminal_path,
            mt5_timeout_ms=timeout_ms,
            mt5_broker_timezone=mt5_broker_timezone,
            poll_interval_seconds=poll_interval,
            history_days=history_days,
            reconnect_initial_backoff_seconds=initial_backoff,
            reconnect_max_backoff_seconds=max_backoff,
            log_level=log_level,
            log_format=log_format,
            collector_api_base_url=api_base_url,
            collector_api_key=api_key,
            collector_account_id=account_id,
            collector_api_timeout_seconds=api_timeout,
            initial_sync_days=initial_sync_days,
            history_sync_overlap_minutes=overlap_minutes,
            candle_symbols=candle_symbols,
            candle_timeframes=candle_timeframes,
            candle_sync_interval_seconds=candle_sync_interval,
            candle_initial_sync_days=candle_initial_sync_days,
            autonomous_execution_enabled=autonomous_execution_enabled,
            candle_timeframes_by_symbol=candle_timeframes_by_symbol,
            gold_execution_enabled=gold_execution_enabled,
            trend_breakout_execution_enabled=trend_breakout_execution_enabled,
            rsi_execution_enabled=rsi_execution_enabled,
            m1m5_execution_enabled=m1m5_execution_enabled,
            telegram_engine_execution_enabled=telegram_engine_execution_enabled,
            sar_execution_enabled=sar_execution_enabled,
        )

    @property
    def has_explicit_credentials(self) -> bool:
        return self.mt5_login is not None


def _read_positive_int(env: dict[str, str], key: str, default: int) -> int:
    raw = env.get(key, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{key} must be an integer, got {raw!r}") from exc
    if value <= 0:
        raise ConfigError(f"{key} must be a positive integer, got {value}")
    return value


def _read_positive_float(env: dict[str, str], key: str, default: float) -> float:
    raw = env.get(key, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ConfigError(f"{key} must be a number, got {raw!r}") from exc
    if value <= 0:
        raise ConfigError(f"{key} must be positive, got {value}")
    return value
