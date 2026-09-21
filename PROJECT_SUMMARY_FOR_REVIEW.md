# Trading Behavior Monitor — Project Summary

## What it is
A personal MT5 (MetaTrader 5) trading behavior monitoring system. It watches a live trading
account, computes analytics on trading history, evaluates rule-based checks for risky behavior,
and alerts the trader (via Telegram) with optional AI-generated narration explaining what happened.
It also has a web dashboard for reviewing account health, trades, and alerts.

## Why it exists
The goal is to catch bad trading habits (overleveraging, no stop-loss, revenge trading after
losses, excessive drawdown, over-concentration in one instrument, etc.) close to when they happen,
rather than discovering them after the fact in a monthly review.

## Architecture (4 services)
1. **Collector** (Python) — runs on the Windows machine next to the MT5 terminal. Reads
   account/position/order/deal data read-only via the MT5 API and pushes it to the backend API on
   an interval. Designed to run persistently as a Windows Scheduled Task.
2. **Backend** (NestJS/TypeScript, Postgres via Prisma, Redis/BullMQ for job queues) — ingests
   collector data idempotently, computes analytics (win rate, drawdown, streaks, risk-per-trade,
   etc.), runs a configurable rule engine (drawdown limits, margin utilization, concentration,
   no-stop-loss, consecutive losses, etc.) against live data, queues Telegram alerts when rules
   trigger, optionally calls an LLM (Anthropic) to narrate what triggered and why, exposes a REST
   API for the dashboard, and includes a system-health monitor (8 components: DB, Redis, queues,
   data freshness, integrity checks, etc.).
3. **Frontend** (dashboard, likely Next.js/React based on `frontend/src/app`) — account-authenticated
   web UI to view accounts, trading data, health status, alerts, and rule configuration.
4. **Telegram delivery** — a BullMQ-backed processor sends formatted alert messages to a Telegram
   bot/chat when a rule fires.

There's also an **XTB CSV importer** for pulling in historical trade data from a different broker
(XTB) that doesn't have a live API integration, and a **data integrity audit** job that
periodically scans for anomalies (e.g., negative volumes, empty rule snapshots).

## Current status (self-assessed, see PROJECT_STATUS.md)
Most core pieces (collector→ingestion, analytics, rule engine, Telegram delivery, dashboard,
account-bound dashboard auth, health monitoring, backup/restore) have been **verified against a
real live MT5 demo account** and real Telegram bot — not just unit tested. Known gaps/blockers:
- AI narration wired up but not yet verified end-to-end (blocked on Anthropic account credits).
- XTB importer built but never run against a real XTB export file (mapping is a best guess).
- Docker build / production docker-compose + Caddy + CI config never actually run on real
  infrastructure (no Linux VPS tested yet).
- Windows Scheduled Task persistence script written but registration not yet completed (needs
  elevated permissions).
- Only ever tested against a single real MT5 account, so multi-account isolation is
  tested-only, not verified with a second real account.

## Tech stack
- Backend: NestJS, TypeScript, Prisma ORM, PostgreSQL, Redis, BullMQ
- Collector: Python, MetaTrader5 package
- Frontend: React/Next.js (TypeScript)
- Infra: Docker Compose, Caddy (reverse proxy/TLS)
- AI: Anthropic API for alert narration
- Deployment target: self-hosted VPS

## What I'd like recommendations on
- Architecture/design review — anything that looks fragile, overengineered, or missing given it's
  a single-user (or small number of accounts) personal trading monitor.
- Security review, especially around the collector→backend auth, dashboard auth, and exposing this
  beyond a trusted local network.
- What to prioritize next given the open items above (AI narration verification, XTB importer
  verification, production deployment, multi-account testing).
- Any suggestions for additional rule types / analytics that would be valuable for a discretionary
  MT5 trader trying to fix bad habits.
