from app.formatting import (
    format_account_summary,
    format_connection_status,
    format_deals_table,
    format_positions_table,
)


def test_connection_status_down():
    assert "DOWN" in format_connection_status(False, None, None)


def test_connection_status_up_broker_connected():
    text = format_connection_status(True, True, "Broker-Demo")
    assert "UP" in text
    assert "Broker-Demo" in text


def test_connection_status_up_broker_disconnected():
    text = format_connection_status(True, False, "Broker-Demo")
    assert "broker link: DOWN" in text


def test_account_summary_none():
    assert "unavailable" in format_account_summary(None)


def test_account_summary_present():
    text = format_account_summary({
        "login": 12345678, "server": "Broker-Demo", "currency": "USD",
        "balance": 10000.0, "equity": 9800.0, "margin": 200.0,
        "margin_free": 9600.0, "margin_level": 4900.0, "profit": -200.0,
        "leverage": 100, "trade_allowed": True,
    })
    assert "12345678" in text
    assert "Broker-Demo" in text
    assert "9800.0" in text


def test_positions_table_empty():
    assert format_positions_table([]) == "OPEN POSITIONS: none"


def test_positions_table_with_rows():
    text = format_positions_table([{
        "ticket": 1001, "symbol": "XAUUSD", "side": "BUY", "volume": 0.5,
        "price_open": 2400.0, "price_current": 2410.0, "profit": 50.0,
    }])
    assert "XAUUSD" in text
    assert "1001" in text


def test_deals_table_empty():
    assert format_deals_table([], days=7) == "RECENT DEALS (last 7d): none"


def test_deals_table_with_rows():
    text = format_deals_table([{
        "ticket": 555, "closed_at": "2026-08-28T10:00:00+00:00",
        "symbol": "EURUSD", "deal_type": "SELL", "volume": 0.1,
        "price": 1.0950, "profit": -12.5,
    }], days=7)
    assert "EURUSD" in text
    assert "555" in text
