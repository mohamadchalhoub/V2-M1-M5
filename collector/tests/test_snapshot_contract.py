"""Pins the collector's payloads to what the backend will actually accept.

The backend validates with `forbidNonWhitelisted: true`: a single field its
DTO does not declare rejects the WHOLE request with a 400. That makes an
unaccepted field far more dangerous than an ignored one would be, and it is
invisible to any test that only inspects what this side sends.

It happened. A `permissions` block was added to the account snapshot without
the backend's SnapshotDto learning about it, the collector's own tests asserted
the block was present and passed, and from then on every account snapshot --
balance, open positions and the live tick that rides along -- was discarded.
The only symptom was `push_ok: false` in a log line nobody was reading.

So this reads the DTO straight out of the backend's source in this repository
and checks the payload against it. It is deliberately a crude parse rather than
a faithful TypeScript reader: it only needs to find declared property names,
and it fails loudly if it cannot find the class at all, rather than passing
vacuously.
"""
import re
from pathlib import Path

import pytest

from app.api_mapper import build_snapshot_payload

DTO_FILE = Path(__file__).resolve().parents[2] / "backend" / "src" / "collector-ingress" / "dto" / "snapshot.dto.ts"


def _declared_properties(class_name: str) -> set[str]:
    """Property names declared on one class in snapshot.dto.ts."""
    source = DTO_FILE.read_text(encoding="utf-8")
    match = re.search(rf"export class {class_name} \{{(.*?)\n\}}", source, re.DOTALL)
    if match is None:
        pytest.fail(f"could not find `export class {class_name}` in {DTO_FILE}; the contract cannot be checked")
    body = match.group(1)
    # `  name!: Type` or `  name?: Type`, possibly after decorators on the
    # same line, e.g. `@IsNumber() balance!: number;`.
    return set(re.findall(r"(?:^|\)\s+|\s)([a-zA-Z_][a-zA-Z0-9_]*)[!?]:", body, re.MULTILINE))


def _full_payload() -> dict:
    """A payload with every optional section populated, so no field hides."""
    return build_snapshot_payload(
        account_id="00000000-0000-0000-0000-000000000000",
        account={
            "balance": 3000, "equity": 3000, "margin": 0, "margin_free": 3000,
            "margin_level": None, "profit": 0, "trade_mode": 0, "margin_mode": 2,
            "trade_allowed": True, "trade_expert": True, "login": 1, "server": "x",
        },
        positions=[],
        mt5_connected=True,
        last_error="an error, so the optional lastError is present too",
        collector_version="test",
        terminal_info={"trade_allowed": True, "tradeapi_disabled": False},
        # A real time: the mapper drops ticks without one, and a dropped tick
        # would hide its fields from the check.
        live_tick={"symbol": "XAUUSD", "bid": 1.0, "ask": 1.1, "time": "2026-09-22T00:00:00+00:00"},
        live_ticks=[{"symbol": "XAUUSD", "bid": 1.0, "ask": 1.1, "time": "2026-09-22T00:00:00+00:00"}],
    )


def test_the_dto_file_is_where_this_test_expects_it():
    # If this fails, the check below would be skipped for the wrong reason.
    assert DTO_FILE.is_file(), f"{DTO_FILE} not found"


def test_every_top_level_snapshot_field_is_declared_by_the_backend():
    declared = _declared_properties("SnapshotDto")
    sent = set(_full_payload().keys())

    undeclared = sent - declared
    assert not undeclared, (
        f"the collector sends {sorted(undeclared)}, which SnapshotDto does not declare. "
        "With forbidNonWhitelisted the backend rejects the ENTIRE snapshot with a 400, "
        "silently dropping balance, positions and the live tick. Declare them in "
        "backend/src/collector-ingress/dto/snapshot.dto.ts or stop sending them."
    )


def test_every_terminal_field_is_declared_by_the_backend():
    declared = _declared_properties("TerminalStatusDto")
    sent = set(_full_payload()["terminal"].keys())

    assert not (sent - declared), f"terminal carries undeclared {sorted(sent - declared)}"


def test_the_parse_actually_finds_the_fields_it_should():
    # Guards the guard: a parse that returned nothing would make the checks
    # above pass vacuously.
    declared = _declared_properties("SnapshotDto")
    assert {"accountId", "capturedAt", "balance", "positions", "terminal"} <= declared


def _position():
    # The NORMALISED shape Mt5Client.get_open_positions returns (not MT5's raw
    # record, which lives under "raw"), with every optional field present --
    # including non-zero sl/tp, which the mapper only emits when set -- so
    # none can hide from the check.
    return {
        "ticket": 58537207521, "symbol": "XAUUSD", "side": "SELL", "volume": 0.5,
        "price_open": 4360.0, "price_current": 4359.0, "sl": 4365.0, "tp": 4355.0,
        "profit": 50.0, "swap": 0.0, "opened_at": "2026-09-22T00:00:00+00:00",
        "raw": {"magic": 262610200, "comment": "m1m5"},
    }


def test_every_position_field_is_declared_by_the_backend():
    """Positions have never actually reached the backend on this deployment:
    the whole snapshot was being rejected for an unrelated field. Fixing that
    field means positions get validated for the first time -- so an
    undeclared one here would just move the 400 rather than remove it."""
    declared = _declared_properties("IncomingPositionDto")
    payload = build_snapshot_payload(
        account_id="00000000-0000-0000-0000-000000000000",
        account={"balance": 1, "equity": 1, "margin": 0, "margin_free": 1, "profit": 0},
        positions=[_position()],
        mt5_connected=True,
        last_error=None,
        collector_version="test",
    )
    sent = set(payload["positions"][0].keys())

    assert not (sent - declared), (
        f"positions carry {sorted(sent - declared)}, which IncomingPositionDto does not declare; "
        "the backend would reject the whole snapshot"
    )


def test_every_live_tick_field_is_declared_by_the_backend():
    declared = _declared_properties("LiveTickDto")
    payload = _full_payload()

    assert "liveTick" in payload and "liveTicks" in payload, "fixture must exercise both tick fields"
    assert not (set(payload["liveTick"].keys()) - declared)
    for tick in payload["liveTicks"]:
        assert not (set(tick.keys()) - declared)



# --- the V2 execution-result route ------------------------------------------

M1M5_CONTROLLER = Path(__file__).resolve().parents[2] / "backend" / "src" / "xauusd-m1m5" / "execution.controller.ts"


def _declared_in(path: Path, class_name: str) -> set[str]:
    source = path.read_text(encoding="utf-8")
    match = re.search(rf"export class {class_name} \{{(.*?)\n\}}", source, re.DOTALL)
    if match is None:
        pytest.fail(f"could not find `export class {class_name}` in {path}")
    return set(re.findall(r"(?:^|\)\s+|\s)([a-zA-Z_][a-zA-Z0-9_]*)[!?]:", match.group(1), re.MULTILINE))


def test_every_execution_result_field_is_declared_by_the_backend():
    """The one-second execution pass added four fields to this payload. Any
    one the DTO did not declare would reject EVERY result with a 400 -- and a
    lost result leaves a live order the backend knows nothing about."""
    from unittest.mock import MagicMock

    from datetime import datetime, timezone

    from app.runner import CollectorApp

    api = MagicMock()
    app = CollectorApp(config=MagicMock(collector_account_id="acct"), client=MagicMock(), api=api, executor=MagicMock())
    now = datetime.now(timezone.utc)
    # Every optional field populated, so none can hide from the check.
    app._report_m1m5_execution_result(
        "dec-1", ok=False, ticket=1, filled_price=1.0, error_message="x", uncertain=True, not_sent=True,
        broker_stop_loss=1.0, broker_take_profit=1.0, evaluated_at=now, submitted_at=now, acknowledged_at=now,
    )
    sent = set(api.post_m1m5_execution_result.call_args[0][2].keys())
    declared = _declared_in(M1M5_CONTROLLER, "M1M5ExecutionResultDto")

    assert {"notSent", "executionEvaluatedAt", "submittedAt", "acknowledgedAt"} <= declared, "parse guard"
    assert not (sent - declared), f"the collector sends {sorted(sent - declared)}, undeclared by M1M5ExecutionResultDto"
