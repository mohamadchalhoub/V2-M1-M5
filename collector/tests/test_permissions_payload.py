"""MT5 permission reporting (v2 sections 7, 8).

The property under test is that "unknown" survives the trip to the backend as
``None``, distinct from ``False``.

That distinction carries the whole safety argument. The backend blocks
execution on an unreadable permission, so collapsing ``None`` into ``True``
would let a permission nobody could read look like one that was granted, and
collapsing it into ``False`` would report a fault that may not exist. Only
three states describe reality.
"""
from __future__ import annotations

from app.api_mapper import build_permissions_payload, build_snapshot_payload

ACCOUNT = {
    "login": 1234500001,
    "server": "MetaQuotes-Demo",
    "trade_allowed": True,
    "trade_expert": True,
    "trade_mode": 0,  # DEMO
    "margin_mode": 2,  # RETAIL_HEDGING
}
TERMINAL = {"trade_allowed": True, "tradeapi_disabled": False, "connected": True}


class TestPermissionsPayload:
    def test_reports_every_permission_the_backend_checks(self):
        p = build_permissions_payload(ACCOUNT, TERMINAL, mt5_connected=True)
        assert p["login"] == 1234500001
        assert p["server"] == "MetaQuotes-Demo"
        assert p["tradeMode"] == "DEMO"
        assert p["marginMode"] == "RETAIL_HEDGING"
        assert p["terminalConnected"] is True
        assert p["terminalTradeAllowed"] is True
        assert p["terminalTradeApiDisabled"] is False
        assert p["accountTradeAllowed"] is True
        assert p["accountTradeExpert"] is True

    def test_missing_account_yields_unknown_not_false(self):
        p = build_permissions_payload(None, TERMINAL, mt5_connected=True)
        assert p["login"] is None
        assert p["accountTradeAllowed"] is None
        assert p["accountTradeExpert"] is None
        # Explicitly NOT False: the backend must be able to tell "could not
        # read" from "the broker said no".
        assert p["accountTradeAllowed"] is not False

    def test_missing_terminal_yields_unknown_not_false(self):
        p = build_permissions_payload(ACCOUNT, None, mt5_connected=True)
        assert p["terminalTradeAllowed"] is None
        assert p["terminalTradeApiDisabled"] is None

    def test_unknown_connection_state_is_none(self):
        p = build_permissions_payload(ACCOUNT, TERMINAL, mt5_connected=None)
        assert p["terminalConnected"] is None

    def test_reports_a_denied_permission_as_false(self):
        p = build_permissions_payload(
            {**ACCOUNT, "trade_allowed": False, "trade_expert": False},
            {**TERMINAL, "trade_allowed": False, "tradeapi_disabled": True},
            mt5_connected=False,
        )
        assert p["accountTradeAllowed"] is False
        assert p["accountTradeExpert"] is False
        assert p["terminalTradeAllowed"] is False
        assert p["terminalTradeApiDisabled"] is True
        assert p["terminalConnected"] is False

    def test_tradeapi_disabled_keeps_its_inverted_sense(self):
        # Reported as MT5 names it, not flipped here, so the backend check
        # reads the same way the MT5 documentation does.
        enabled = build_permissions_payload(ACCOUNT, {**TERMINAL, "tradeapi_disabled": False}, True)
        disabled = build_permissions_payload(ACCOUNT, {**TERMINAL, "tradeapi_disabled": True}, True)
        assert enabled["terminalTradeApiDisabled"] is False
        assert disabled["terminalTradeApiDisabled"] is True

    def test_unmapped_margin_mode_is_unknown_rather_than_a_guess(self):
        p = build_permissions_payload({**ACCOUNT, "margin_mode": 99}, TERMINAL, True)
        assert p["marginMode"] is None

    def test_netting_is_reported_as_netting(self):
        p = build_permissions_payload({**ACCOUNT, "margin_mode": 0}, TERMINAL, True)
        assert p["marginMode"] == "RETAIL_NETTING"

    def test_real_account_is_reported_as_real(self):
        p = build_permissions_payload({**ACCOUNT, "trade_mode": 2}, TERMINAL, True)
        assert p["tradeMode"] == "REAL"


class TestSnapshotCarriesPermissions:
    def test_snapshot_includes_the_permissions_block(self):
        payload = build_snapshot_payload(
            account_id="acct-1",
            account=ACCOUNT,
            positions=[],
            mt5_connected=True,
            last_error=None,
            collector_version="test",
            terminal_info=TERMINAL,
        )
        assert payload["permissions"]["accountTradeExpert"] is True
        assert payload["permissions"]["marginMode"] == "RETAIL_HEDGING"

    def test_snapshot_without_terminal_info_still_reports_unknowns(self):
        # Existing callers that do not pass terminal_info must not crash, and
        # must not silently claim the terminal permits trading.
        payload = build_snapshot_payload(
            account_id="acct-1",
            account=ACCOUNT,
            positions=[],
            mt5_connected=True,
            last_error=None,
            collector_version="test",
        )
        assert payload["permissions"]["terminalTradeAllowed"] is None
        assert payload["permissions"]["terminalTradeApiDisabled"] is None
