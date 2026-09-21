"""Fail-closed terminal binding and account identity (v2 sections 4, 5, 6, 7).

The logins here are deliberately fictitious. The real account number lives
only in the gitignored environment files: section 5 forbids copying account
details into test fixtures, and these tests exercise logic that does not
depend on which account it is.

The behaviour under test is entirely negative: this collector must refuse to
run rather than attach to a terminal or an account that is not its own.

That matters because the host these bots run on has more than one MT5
terminal. MetaTrader5's ``initialize()`` auto-discovers a terminal when given
no path, and the one it finds may belong to another bot. Attaching to it would
let this collector read another system's account and act on positions it does
not own -- a failure that is silent, which is what makes it dangerous.
"""
from __future__ import annotations

import pytest

from app.config import Config, ConfigError

BACKEND_ENV = {
    "COLLECTOR_API_BASE_URL": "http://localhost:8430",
    "COLLECTOR_API_KEY": "tm_col_test_token",
    "COLLECTOR_ACCOUNT_ID": "11111111-1111-1111-1111-111111111111",
}


class TestExplicitTerminalRequired:
    def test_off_by_default_so_existing_deployments_are_unaffected(self):
        cfg = Config.from_env({**BACKEND_ENV})
        assert cfg.mt5_require_explicit_terminal is False
        assert cfg.mt5_terminal_path is None

    def test_refuses_to_start_when_required_but_unset(self):
        with pytest.raises(ConfigError) as exc:
            Config.from_env({**BACKEND_ENV, "MT5_REQUIRE_EXPLICIT_TERMINAL": "true"})
        assert "MT5_TERMINAL_PATH is empty" in str(exc.value)
        assert "auto-discovers" in str(exc.value)

    def test_refuses_to_start_when_the_configured_terminal_does_not_exist(self, tmp_path):
        missing = tmp_path / "nowhere" / "terminal64.exe"
        with pytest.raises(ConfigError) as exc:
            Config.from_env(
                {
                    **BACKEND_ENV,
                    "MT5_REQUIRE_EXPLICIT_TERMINAL": "true",
                    "MT5_TERMINAL_PATH": str(missing),
                }
            )
        # The message must name the fallback it is refusing, so the operator
        # does not "fix" this by clearing the path.
        assert "does not exist" in str(exc.value)
        assert "falling back to auto-discovery" in str(exc.value)

    def test_accepts_a_terminal_that_actually_exists(self, tmp_path):
        terminal = tmp_path / "terminal64.exe"
        terminal.write_bytes(b"")
        cfg = Config.from_env(
            {
                **BACKEND_ENV,
                "MT5_REQUIRE_EXPLICIT_TERMINAL": "true",
                "MT5_TERMINAL_PATH": str(terminal),
            }
        )
        assert cfg.mt5_require_explicit_terminal is True
        assert cfg.mt5_terminal_path == str(terminal)

    def test_a_directory_is_not_a_terminal(self, tmp_path):
        with pytest.raises(ConfigError):
            Config.from_env(
                {
                    **BACKEND_ENV,
                    "MT5_REQUIRE_EXPLICIT_TERMINAL": "true",
                    "MT5_TERMINAL_PATH": str(tmp_path),
                }
            )


class TestExpectedLogin:
    def test_unset_by_default(self):
        assert Config.from_env({**BACKEND_ENV}).mt5_expected_login is None

    def test_parsed_when_set(self):
        cfg = Config.from_env({**BACKEND_ENV, "MT5_EXPECTED_LOGIN": "1234500001"})
        assert cfg.mt5_expected_login == 1234500001

    def test_rejects_a_non_integer(self):
        with pytest.raises(ConfigError) as exc:
            Config.from_env({**BACKEND_ENV, "MT5_EXPECTED_LOGIN": "not-a-login"})
        assert "must be an integer" in str(exc.value)

    def test_refuses_when_configured_login_disagrees_with_expected(self):
        # Two different accounts named in one configuration is a mistake, not
        # a preference, and it is caught before any connection is attempted.
        with pytest.raises(ConfigError) as exc:
            Config.from_env(
                {
                    **BACKEND_ENV,
                    "MT5_LOGIN": "1234500001",
                    "MT5_PASSWORD": "irrelevant",
                    "MT5_SERVER": "MetaQuotes-Demo",
                    "MT5_EXPECTED_LOGIN": "9999999999",
                }
            )
        assert "does not match" in str(exc.value)

    def test_accepts_when_they_agree(self):
        cfg = Config.from_env(
            {
                **BACKEND_ENV,
                "MT5_LOGIN": "1234500001",
                "MT5_PASSWORD": "irrelevant",
                "MT5_SERVER": "MetaQuotes-Demo",
                "MT5_EXPECTED_LOGIN": "1234500001",
            }
        )
        assert cfg.mt5_login == cfg.mt5_expected_login == 1234500001


class _FakeAccountInfo:
    def __init__(self, login: int) -> None:
        self.login = login


class _FakeMt5:
    """Minimal stand-in for the MetaTrader5 module."""

    def __init__(self, login: int | None) -> None:
        self._login = login
        self.shutdown_called = False
        self.selected: list[str] = []

    def initialize(self, **_kwargs):
        return True

    def account_info(self):
        return None if self._login is None else _FakeAccountInfo(self._login)

    def symbol_select(self, symbol, _enable):
        self.selected.append(symbol)
        return True

    def shutdown(self):
        self.shutdown_called = True

    def last_error(self):
        return (0, "")


def _client_with(fake: _FakeMt5, expected_login: int | None):
    from app.mt5_client import Mt5Client

    cfg = Config.from_env(
        {
            **BACKEND_ENV,
            "CANDLE_SYMBOLS": "XAUUSD",
            **({"MT5_EXPECTED_LOGIN": str(expected_login)} if expected_login is not None else {}),
        }
    )
    client = Mt5Client(cfg)
    # Inject the fake in place of the real MetaTrader5 module.
    client._mt5 = fake  # noqa: SLF001 - deliberate seam for this test
    return client, cfg


class TestRuntimeAccountIdentityGate:
    def test_connect_refuses_when_the_terminal_holds_a_different_account(self, monkeypatch):
        fake = _FakeMt5(login=9999999999)
        client, _ = _client_with(fake, expected_login=1234500001)
        monkeypatch.setattr("app.mt5_client.mt5", fake, raising=False)

        result = client.connect()

        assert result.ok is False
        assert "9999999999" in result.error_message
        assert "1234500001" in result.error_message
        # Disconnected, and never marked connected: nothing downstream may read
        # a tick or claim ownership against the wrong account.
        assert fake.shutdown_called is True
        assert client.is_connected() is False

    def test_connect_refuses_when_account_info_is_unavailable(self, monkeypatch):
        fake = _FakeMt5(login=None)
        client, _ = _client_with(fake, expected_login=1234500001)
        monkeypatch.setattr("app.mt5_client.mt5", fake, raising=False)

        result = client.connect()

        assert result.ok is False
        assert "could not be verified" in result.error_message
        assert fake.shutdown_called is True

    def test_connect_succeeds_when_the_account_matches(self, monkeypatch):
        fake = _FakeMt5(login=1234500001)
        client, _ = _client_with(fake, expected_login=1234500001)
        monkeypatch.setattr("app.mt5_client.mt5", fake, raising=False)

        result = client.connect()

        assert result.ok is True
        assert fake.shutdown_called is False
        assert "XAUUSD" in fake.selected

    def test_no_identity_check_when_no_expected_login_is_configured(self, monkeypatch):
        # Existing deployments that do not set MT5_EXPECTED_LOGIN keep their
        # current behaviour; this gate is opt-in.
        fake = _FakeMt5(login=1234)
        client, _ = _client_with(fake, expected_login=None)
        monkeypatch.setattr("app.mt5_client.mt5", fake, raising=False)

        assert client.connect().ok is True
