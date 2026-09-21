import pytest

from app.config import Config, ConfigError

BACKEND_ENV = {
    "COLLECTOR_API_BASE_URL": "http://localhost:3000",
    "COLLECTOR_API_KEY": "tm_col_test_token",
    "COLLECTOR_ACCOUNT_ID": "11111111-1111-1111-1111-111111111111",
}


def test_defaults_with_no_credentials():
    cfg = Config.from_env({**BACKEND_ENV})
    assert cfg.has_explicit_credentials is False
    assert cfg.mt5_login is None
    assert cfg.poll_interval_seconds == 10
    assert cfg.history_days == 7
    assert cfg.mt5_timeout_ms == 60_000
    assert cfg.log_level == "INFO"
    assert cfg.log_format == "json"
    assert cfg.collector_api_base_url == "http://localhost:3000"
    assert cfg.collector_account_id == "11111111-1111-1111-1111-111111111111"
    assert cfg.initial_sync_days == 90
    assert cfg.history_sync_overlap_minutes == 5
    assert cfg.mt5_broker_timezone == "EET"
    assert cfg.autonomous_execution_enabled is False


def test_autonomous_execution_enabled_is_parsed_from_env():
    cfg = Config.from_env({**BACKEND_ENV, "AUTONOMOUS_EXECUTION_ENABLED": "true"})
    assert cfg.autonomous_execution_enabled is True
    cfg_off = Config.from_env({**BACKEND_ENV, "AUTONOMOUS_EXECUTION_ENABLED": "false"})
    assert cfg_off.autonomous_execution_enabled is False


def test_mt5_broker_timezone_is_configurable():
    cfg = Config.from_env({**BACKEND_ENV, "MT5_BROKER_TIMEZONE": "America/New_York"})
    assert cfg.mt5_broker_timezone == "America/New_York"


def test_invalid_mt5_broker_timezone_raises():
    with pytest.raises(ConfigError, match="MT5_BROKER_TIMEZONE"):
        Config.from_env({**BACKEND_ENV, "MT5_BROKER_TIMEZONE": "Not/A_Real_Zone"})


def test_explicit_credentials_all_present():
    cfg = Config.from_env({
        **BACKEND_ENV,
        "MT5_LOGIN": "12345678",
        "MT5_PASSWORD": "hunter2",
        "MT5_SERVER": "Broker-Demo",
    })
    assert cfg.has_explicit_credentials is True
    assert cfg.mt5_login == 12345678
    assert cfg.mt5_password == "hunter2"
    assert cfg.mt5_server == "Broker-Demo"


def test_partial_credentials_raise():
    with pytest.raises(ConfigError, match="Partial MT5 credentials"):
        Config.from_env({**BACKEND_ENV, "MT5_LOGIN": "12345678"})


def test_non_integer_login_raises():
    with pytest.raises(ConfigError, match="MT5_LOGIN must be an integer"):
        Config.from_env({
            **BACKEND_ENV,
            "MT5_LOGIN": "not-a-number",
            "MT5_PASSWORD": "x",
            "MT5_SERVER": "y",
        })


def test_invalid_log_level_raises():
    with pytest.raises(ConfigError, match="LOG_LEVEL"):
        Config.from_env({**BACKEND_ENV, "LOG_LEVEL": "VERBOSE"})


def test_invalid_log_format_raises():
    with pytest.raises(ConfigError, match="LOG_FORMAT"):
        Config.from_env({**BACKEND_ENV, "LOG_FORMAT": "xml"})


def test_non_positive_poll_interval_raises():
    with pytest.raises(ConfigError, match="POLL_INTERVAL_SECONDS"):
        Config.from_env({**BACKEND_ENV, "POLL_INTERVAL_SECONDS": "0"})


def test_max_backoff_below_initial_raises():
    with pytest.raises(ConfigError, match="RECONNECT_MAX_BACKOFF_SECONDS"):
        Config.from_env({
            **BACKEND_ENV,
            "RECONNECT_INITIAL_BACKOFF_SECONDS": "30",
            "RECONNECT_MAX_BACKOFF_SECONDS": "5",
        })


def test_custom_values_are_read():
    cfg = Config.from_env({
        **BACKEND_ENV,
        "POLL_INTERVAL_SECONDS": "15",
        "HISTORY_DAYS": "30",
        "MT5_TERMINAL_PATH": "C:\\MT5\\terminal64.exe",
        "LOG_FORMAT": "text",
    })
    assert cfg.poll_interval_seconds == 15
    assert cfg.history_days == 30
    assert cfg.mt5_terminal_path == "C:\\MT5\\terminal64.exe"
    assert cfg.log_format == "text"


def test_missing_backend_config_raises():
    with pytest.raises(ConfigError, match="Missing required backend-push configuration"):
        Config.from_env({})


def test_partial_backend_config_lists_only_missing_keys():
    with pytest.raises(ConfigError) as exc_info:
        Config.from_env({"COLLECTOR_API_BASE_URL": "http://localhost:3000"})
    message = str(exc_info.value)
    assert "COLLECTOR_API_KEY" in message
    assert "COLLECTOR_ACCOUNT_ID" in message
    assert "COLLECTOR_API_BASE_URL" not in message


def test_candle_sync_off_by_default():
    cfg = Config.from_env({**BACKEND_ENV})
    assert cfg.candle_symbols == ()
    assert cfg.candle_timeframes == ("M5", "M15", "H1")
    assert cfg.candle_sync_interval_seconds == 300
    assert cfg.candle_initial_sync_days == 730


def test_candle_symbols_parsed_uppercase_and_trimmed():
    cfg = Config.from_env({**BACKEND_ENV, "CANDLE_SYMBOLS": " eurusd, gbpusd "})
    assert cfg.candle_symbols == ("EURUSD", "GBPUSD")


def test_invalid_candle_timeframe_raises():
    with pytest.raises(ConfigError, match="CANDLE_TIMEFRAMES"):
        Config.from_env({**BACKEND_ENV, "CANDLE_TIMEFRAMES": "M5,W2"})


def test_custom_candle_sync_settings():
    cfg = Config.from_env({
        **BACKEND_ENV,
        "CANDLE_SYMBOLS": "EURUSD",
        "CANDLE_TIMEFRAMES": "M15",
        "CANDLE_SYNC_INTERVAL_SECONDS": "600",
        "CANDLE_INITIAL_SYNC_DAYS": "365",
    })
    assert cfg.candle_symbols == ("EURUSD",)
    assert cfg.candle_timeframes == ("M15",)
    assert cfg.candle_sync_interval_seconds == 600
    assert cfg.candle_initial_sync_days == 365


def test_technical_analysis_timeframes_m30_h4_d1_are_valid():
    # Technical-analysis phase (support/resistance, Ichimoku, Fibonacci) —
    # these three were added alongside the original M5/M15/H1.
    cfg = Config.from_env({**BACKEND_ENV, "CANDLE_TIMEFRAMES": "M30,H4,D1"})
    assert cfg.candle_timeframes == ("M30", "H4", "D1")


def test_w1_mn1_timeframes_are_valid():
    # Ichimoku breakout alerts on the weekly/monthly timeframes.
    cfg = Config.from_env({**BACKEND_ENV, "CANDLE_TIMEFRAMES": "W1,MN1"})
    assert cfg.candle_timeframes == ("W1", "MN1")


def test_m1_timeframe_is_valid():
    # Gold historical-data-collection project — finest granularity, used
    # only by backfill_gold_history.py's tick/candle backfill.
    cfg = Config.from_env({**BACKEND_ENV, "CANDLE_TIMEFRAMES": "M1"})
    assert cfg.candle_timeframes == ("M1",)
