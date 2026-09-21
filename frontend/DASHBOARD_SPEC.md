# Web dashboard — Phase 9
> See `../PROJECT_STATUS.md` at the repo root for the authoritative build order, phase-numbering crosswalk, and current status of every component.

Status: **Implemented and verified against the real backend and real MT5 account data**, built
autonomously while you were away — please review, especially §4's assumptions. Lower risk than
Phases 4–6 (nothing here decides anything about trading, or writes anything except the CSV
import you already had), but it's the largest surface area of any phase so far.

## 1. What this is

Phase 0 §17: "read-only views first, rule-editing UI last." This ships every route from §17
except `/settings` (see §4) as read-only, plus the CSV import upload the backend already
supported (Phase 8) — nothing here can create, edit, or delete a rule, an account, or trading
data. A Next.js App Router app, Server Components throughout, that reads the backend's REST API.

## 2. Architecture

```
Next.js (port 3001, Server Components)
  → every page fetches BACKEND_API_URL (default http://localhost:3000) SERVER-SIDE
  → no browser → backend calls at all, so no CORS is actually load-bearing
  → the one write path (CSV upload) is a Next.js Server Action, also server-side
```

This was a deliberate simplification over the originally-planned browser-fetches-the-API shape:
routing every read through the Next.js server means the backend's CORS policy (added anyway, in
`main.ts`, for anyone who later adds client-side fetches) is defense-in-depth rather than
something the app depends on, and it means account switching, pagination, and the health page all
work as plain server-rendered navigations — no client-side data-fetching library needed.

Backend additions this phase required (§15): five new read-only controllers, since almost nothing
had an HTTP read surface before this — `rules`, `alerts`, and `trading-data` previously had
services only, driven by tests and `manage-rules.ts`.

| Route | New backend endpoint(s) |
|---|---|
| `GET /accounts` | `AccountsController` (new) |
| `GET /accounts/:id` | `AccountsController` (new) |
| `GET /accounts/:id/snapshots/latest`, `/positions`, `/trades` | `TradingDataController` (new) |
| `GET /accounts/:id/alerts` | `AlertsController` (new) |
| `GET /accounts/:id/rules` | `RulesController` (new, still no POST/PATCH — see §1) |
| `GET /health`, `/health/incidents` | already existed (Phase 7) |
| `POST /xtb-import`, `GET /xtb-import/batches/:id` | already existed (Phase 8) |

## 3. Pages

- `/` — redirects to `/dashboard/<first account>`, or `/setup` if zero accounts exist yet.
- `/dashboard/[accountId]` — balance/equity/margin/free-margin/floating-P&L tiles from the latest
  snapshot, the 7-component health tile row (links to `/health`), open positions, last 5 alerts.
- `/health` — full component table + incident history. Same content Phase 7 already served over
  HTTP; this is its first UI.
- `/alerts/[accountId]` — full, paginated alert history with rule name, delivery status, and
  AI-narrative status joined in.
- `/history/[accountId]` — paginated trade history (both platforms).
- `/rules/[accountId]` — read-only rule list with live run state (ACTIVE/INACTIVE) and raw
  parameters. Points to `manage-rules.ts` for anyone looking to change something.
- `/imports/[accountId]` — CSV upload (XTB accounts only) + batch history table. The one page
  with a real write action, using a Next.js Server Action, not a new backend endpoint.

Account switching is a `<select>` that navigates to the same route with a different `:accountId`
— no client-side account "context" or global state.

## 4. Assumptions made without asking (flag these on review)

- **`/settings` (§17) was not built.** There is nothing to configure yet without a real auth/user
  model — every setting that exists today (Telegram chat ids, AI provider, rule params) is a
  `.env` value or a CLI flag, not a per-user preference. Building a settings page with nothing
  real behind it seemed worse than not building it; revisit once auth exists.
- **No auth on any of these endpoints**, same posture as `/health` and `/xtb-import` already had.
  The dashboard has zero privileged access the API doesn't also grant any other consumer (Phase 0
  §"three invariants," unchanged) — it's a thin read layer, not a new trust boundary.
- **Pagination is offset-based**, capped at 200/page server-side (`common/pagination.ts`) — simple
  Previous/Next links, no infinite scroll or cursor pagination. Fine at this data volume (one
  trader, a handful of accounts); would need revisiting at real scale.
- **`AccountSnapshot.id` is a BigInt** and Fastify's default JSON serializer can't stringify one —
  found via the new e2e test suite, fixed by stringifying it in `TradingDataController`. Worth
  knowing about if another BigInt-keyed table ever gets a read endpoint.
- **No frontend automated test suite.** Verified instead by a real `next build` (typecheck +
  route generation) and live curl checks against the running backend with real MT5 account data
  (dashboard, health, alerts, rules, history, imports all returned 200 with correct content — see
  the session's own verification, not repeated here). A Playwright suite would be the natural next
  step if the dashboard grows real interactivity beyond navigation and one upload form.

## 5. Config

```
# frontend/.env.local
BACKEND_API_URL=http://localhost:3000   # server-only, no NEXT_PUBLIC_ prefix

# backend/.env
DASHBOARD_ORIGIN=http://localhost:3001   # CORS allowlist — defense-in-depth, not load-bearing (§2)
```

## 6. Running it

```
cd backend  && npm run dev     # port 3000
cd frontend && npm run dev     # port 3001, http://localhost:3001
```
