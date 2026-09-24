"""HTTP client for the backend's /collector/* endpoints.

Every call is a single attempt — no internal retry loop. The runner's own
poll cycle is the retry mechanism: a failed push this cycle is superseded
by a fresh, idempotent push next cycle, so a second retry layer here would
just add complexity without adding safety.
"""
from __future__ import annotations

import logging
from typing import Any

import requests

from app.config import Config

logger = logging.getLogger("collector.api_client")


class ApiClientError(Exception):
    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class ApiClient:
    def __init__(self, config: Config) -> None:
        self._base_url = config.collector_api_base_url.rstrip("/")
        self._timeout = config.collector_api_timeout_seconds
        self._session = requests.Session()
        self._session.headers.update({
            "Authorization": f"Bearer {config.collector_api_key}",
            "Content-Type": "application/json",
        })

    def post_snapshot(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/collector/snapshot", payload)

    def post_trades(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/collector/trades", payload)

    def get_cursor(self, account_id: str) -> dict[str, Any]:
        return self._get(f"/collector/cursor/{account_id}")

    def get_heartbeat(self, account_id: str) -> dict[str, Any]:
        return self._get(f"/collector/heartbeat/{account_id}")

    # Historical chart reconstruction phase — candles carry no account_id
    # (backend's HistoricalCandle model: symbol/timeframe data, shared
    # across every account/collector).
    def post_candles(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/collector/candles", payload)

    def get_latest_candle_time(self, symbol: str, timeframe: str) -> dict[str, Any]:
        return self._get(f"/collector/candles/latest?symbol={symbol}&timeframe={timeframe}")

    # Gold historical-data-collection project — ticks carry no account_id,
    # same "shared market data" posture as candles above.
    def post_ticks(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/collector/ticks", payload)

    def get_ticks_coverage(self, symbol: str) -> dict[str, Any]:
        return self._get(f"/collector/ticks/coverage?symbol={symbol}")

    # The backfill-intervals ledger — upsert is keyed server-side on
    # source+symbol+dataType+timeframe+rangeStart+rangeEnd (this client
    # sends whichever of those fields the caller supplies; it never
    # computes or guesses the key itself).
    def upsert_backfill_interval(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/collector/backfill-intervals", payload)

    def get_backfill_intervals(
        self,
        symbol: str,
        data_type: str,
        timeframe: str | None = None,
        statuses: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        query = f"symbol={symbol}&dataType={data_type}"
        if timeframe is not None:
            query += f"&timeframe={timeframe}"
        if statuses:
            query += f"&status={','.join(statuses)}"
        # _get's own return type is whatever the endpoint actually returns
        # (a dict for most routes, an array here) — see its own body.
        return self._get(f"/collector/backfill-intervals?{query}")  # type: ignore[return-value]

    def get_storage_health(self) -> dict[str, Any]:
        return self._get("/collector/storage-health")

    # trend-breakout strategy (v3) — EXISTING route; the DTO now also
    # accepts the new, fully-optional instrument-verification fields (see
    # api_mapper.py's build_symbol_metadata_payload) but this wrapper's own
    # shape (a single-attempt POST, same as every other push here) is
    # unchanged.
    def post_symbol_metadata(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/collector/symbol-metadata", payload)

    # Autonomous demo trading (v2), Phase 6 — the ONE reverse-direction pair
    # in this client: every other method here pushes data the collector
    # already has; these two are the collector asking the backend "is there
    # anything approved for me to execute" and then reporting back what
    # happened. Still the collector acting as an HTTP CLIENT of the backend
    # (a GET/POST it initiates on its own poll cycle) — the backend never
    # calls out to the collector.
    def get_pending_order(self, account_id: str) -> dict[str, Any]:
        return self._get(f"/collector/{account_id}/autonomous/pending-order")

    def post_execution_result(self, account_id: str, decision_id: str, result: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/collector/{account_id}/autonomous/pending-order/{decision_id}/result", result)

    # Gold (XAUUSD) execution — its OWN route, deliberately separate from
    # the EURUSD pair above (backend's GoldExecutionController), never the
    # same URL with a symbol parameter, so the two strategies' wire
    # contracts can never be confused at the HTTP layer either.
    def get_pending_gold_order(self, account_id: str) -> dict[str, Any]:
        return self._get(f"/collector/{account_id}/gold-execution/pending-order")

    def post_gold_execution_result(self, account_id: str, decision_id: str, result: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/collector/{account_id}/gold-execution/pending-order/{decision_id}/result", result)

    # Gold close-request — symmetric to the open pair above: the backend
    # queues a confirmed dashboard close request, this collector polls for
    # it on its own cycle and reports back the REAL broker result. "closed"
    # is only ever reported when order_send() (inside executor.close_position)
    # itself returned success — never just because the request was sent.
    def get_gold_close_request(self, account_id: str) -> dict[str, Any]:
        return self._get(f"/collector/{account_id}/gold-execution/close-request")

    def post_gold_close_result(self, account_id: str, request_id: str, result: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/collector/{account_id}/gold-execution/close-request/{request_id}/result", result)

    # Gold protection-restore — task item 3 ("restore-then-close"): the
    # RESTORE half, symmetric to the close-request pair above.
    def get_gold_restore_protection_request(self, account_id: str) -> dict[str, Any]:
        return self._get(f"/collector/{account_id}/gold-execution/restore-protection-request")

    def post_gold_restore_protection_result(self, account_id: str, request_id: str, result: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/collector/{account_id}/gold-execution/restore-protection-request/{request_id}/result", result)

    # xauusd-m1-rsi-retest-extremes-v1 — the active strategy's OWN route.
    # Deliberately separate from every pair above so a retired strategy's
    # wire contract and this one can never be confused, and so disabling one
    # can never disable the other.
    # ---- xauusd-m1-m5-rsi-threshold-v2 -------------------------------
    # This project's OWN routes. Never a shared path with a strategy
    # parameter: two bots on this host trade the same symbol on the same
    # broker, and a wire contract that CAN be confused eventually will be.

    def post_m1m5_mt5_snapshot(self, account_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/collector/{account_id}/xauusd-m1m5/mt5-snapshot", payload)

    def get_pending_m1m5_order(self, account_id: str) -> dict[str, Any]:
        return self._get(f"/collector/{account_id}/xauusd-m1m5/pending-order")

    def post_m1m5_execution_result(self, account_id: str, decision_id: str, result: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/collector/{account_id}/xauusd-m1m5/pending-order/{decision_id}/result", result)

    def get_m1m5_close_request(self, account_id: str) -> dict[str, Any]:
        return self._get(f"/collector/{account_id}/xauusd-m1m5/close-request")

    def post_m1m5_close_result(self, account_id: str, request_id: str, result: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/collector/{account_id}/xauusd-m1m5/close-request/{request_id}/result", result)

    # --- Engine B, the Telegram copy engine. Its OWN route prefix, never a
    # parameter on Engine A's: two engines place orders on the same account
    # from this same process, and a wire contract that can be confused at the
    # HTTP layer eventually is.

    def get_pending_telegram_leg(self, account_id: str) -> dict[str, Any]:
        return self._get(f"/collector/{account_id}/telegram-engine/pending-leg")

    def post_telegram_leg_result(self, account_id: str, leg_id: str, result: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/collector/{account_id}/telegram-engine/pending-leg/{leg_id}/result", result)

    def post_telegram_reconcile(self, account_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/collector/{account_id}/telegram-engine/reconcile", payload)

    def get_m1m5_protection_request(self, account_id: str) -> dict[str, Any]:
        return self._get(f"/collector/{account_id}/xauusd-m1m5/protection-request")

    def post_m1m5_protection_result(self, account_id: str, request_id: str, result: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/collector/{account_id}/xauusd-m1m5/protection-request/{request_id}/result", result)

    # --- Engine A REPLACEMENT: xauusd-sar-v1, the $0.50 continuous trailing
    # stop-and-reverse strategy. Its OWN route prefix, never xauusd-m1m5's:
    # that one now serves only the frozen RSI strategy's residual reconciliation.

    def get_pending_sar_order(self, account_id: str) -> dict[str, Any]:
        return self._get(f"/collector/{account_id}/xauusd-sar/pending-order")

    def post_sar_execution_result(self, account_id: str, idempotency_tag: str, result: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/collector/{account_id}/xauusd-sar/pending-order/{idempotency_tag}/result", result)

    def post_sar_reconcile(self, account_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/collector/{account_id}/xauusd-sar/reconcile", payload)

    def get_pending_rsi_order(self, account_id: str) -> dict[str, Any]:
        return self._get(f"/collector/{account_id}/xauusd-rsi/pending-order")

    def post_rsi_execution_result(self, account_id: str, decision_id: str, result: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/collector/{account_id}/xauusd-rsi/pending-order/{decision_id}/result", result)

    # Trend-breakout (EURUSD + XAUUSD) execution — its OWN route, deliberately
    # separate from both the EURUSD pair and the gold pair above
    # (backend's TrendBreakoutExecutionController), instrument-parameterized
    # via a path segment (not a query param) so each instrument's poll is a
    # fully distinct URL, matching the backend's own canonical instrument
    # identity (never the raw broker symbol string).
    def get_pending_trend_breakout_order(self, account_id: str, instrument: str) -> dict[str, Any]:
        return self._get(f"/collector/{account_id}/trend-breakout/{instrument}/pending-order")

    def post_trend_breakout_execution_result(self, account_id: str, instrument: str, decision_id: str, result: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/collector/{account_id}/trend-breakout/{instrument}/pending-order/{decision_id}/result", result)

    # Trend-breakout close-request — symmetric to the open pair above:
    # the backend queues a confirmed dashboard close request, this collector
    # polls for it (per instrument) on its own cycle and reports back the
    # REAL broker result. "closed" is only ever reported when order_send()
    # (inside executor.close_position) itself returned success.
    def get_trend_breakout_close_request(self, account_id: str, instrument: str) -> dict[str, Any]:
        return self._get(f"/collector/{account_id}/trend-breakout/{instrument}/close-request")

    def post_trend_breakout_close_result(self, account_id: str, instrument: str, request_id: str, result: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/collector/{account_id}/trend-breakout/{instrument}/close-request/{request_id}/result", result)

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        try:
            resp = self._session.post(url, json=payload, timeout=self._timeout)
        except requests.RequestException as exc:
            raise ApiClientError(f"POST {path} failed: {exc}") from None

        if resp.status_code >= 400:
            raise ApiClientError(
                f"POST {path} returned {resp.status_code}: {_safe_body(resp)}",
                status_code=resp.status_code,
            )
        return resp.json()

    def _get(self, path: str) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        try:
            resp = self._session.get(url, timeout=self._timeout)
        except requests.RequestException as exc:
            raise ApiClientError(f"GET {path} failed: {exc}") from None

        if resp.status_code >= 400:
            raise ApiClientError(
                f"GET {path} returned {resp.status_code}: {_safe_body(resp)}",
                status_code=resp.status_code,
            )
        return resp.json()


def _safe_body(resp: requests.Response) -> str:
    # Never let a response body containing an echoed Authorization header
    # or similar reach a log line untruncated.
    text = resp.text[:500]
    return text
