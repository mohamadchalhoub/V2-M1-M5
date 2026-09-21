"""Entrypoint: python main.py

Loads configuration from the environment (optionally via a local .env file
for development), sets up logging, and runs the collector loop until an
interrupt or terminate signal is received.
"""
from __future__ import annotations

import sys

try:
    from dotenv import load_dotenv
    load_dotenv()  # no-op if no .env file is present; never overrides real env vars
except ImportError:
    pass

from app.config import Config, ConfigError
from app.logging_setup import configure_logging


def main() -> int:
    try:
        config = Config.from_env()
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2

    logger = configure_logging(config.log_level, config.log_format)
    logger.info("configuration loaded", extra={
        "explicit_credentials": config.has_explicit_credentials,
        "log_format": config.log_format,
    })

    # Imported here, not at module scope, so `python main.py --help`-style
    # config errors above surface without requiring the MetaTrader5 package
    # (Windows-only) to be importable first.
    from app.api_client import ApiClient
    from app.executor import Executor
    from app.mt5_client import Mt5Client
    from app.runner import CollectorApp

    client = Mt5Client(config)
    api = ApiClient(config)
    # Constructed unconditionally (cheap — holds no connection of its own
    # yet) but only ever USED by CollectorApp when
    # autonomous_execution_enabled is true; see that class's own comment.
    executor = Executor()
    app = CollectorApp(config, client, api, executor)
    app.install_signal_handlers()
    return app.run()


if __name__ == "__main__":
    sys.exit(main())
