# Deployment runbook — Phase 11
> See `PROJECT_STATUS.md` at the repo root for the authoritative build order, phase-numbering crosswalk, and current status of every component.
>
> This runbook assumes a second (Windows) host for MT5 + the collector. If you only have one Ubuntu VPS available, see `DEPLOYMENT_SINGLE_VPS.md` instead — same backend/frontend/Docker stack, but MT5 + the collector run on the same box via Wine.

Status: **Infrastructure and process built and verified locally** — compose file, CI, and
backup/restore scripts all exist and work; the restore drill has actually been run once (see §6);
`docker compose --env-file ... -f docker-compose.prod.yml config` resolves cleanly, proving the
compose file itself is syntactically and structurally correct. What has **not** happened, and
won't happen without you: provisioning a real server, domain, or any paid cloud resource. This
document is what to do when you're ready for that — nothing in it runs on its own.

**One open item**: `docker build -f backend/Dockerfile backend` was attempted four times in this
session's own Docker Desktop and never completed — each attempt hung for several minutes on a
single package download (npm's registry once, Prisma's engine CDN once, npm's registry again) and
then failed with `ETIMEDOUT`, on three different hosts across three attempts. The same hosts
answered instantly both from this machine directly (`curl`) and from inside a plain `docker run
node:20-alpine` container — so this looks like flakiness specific to this sandbox's BuildKit build
network, not a real connectivity problem or (based on how each attempt behaved differently) a
Dockerfile defect. One real bug WAS found and fixed in the process: the `build` stage was missing
`apk add openssl`, which made Prisma guess the wrong engine target
(`openssl-1.1.x` instead of the Alpine base image's actual `openssl-3.0.x`) — that's fixed in the
committed Dockerfile. Before relying on this in production: run `docker compose --env-file
.env.production -f docker-compose.prod.yml up -d --build` yourself once, on real infrastructure —
its network is almost certainly more stable than this sandbox's, and image builds nearly always
succeed there. If it hangs on a download the same way, add `--network=host` to the build (or to
`DOCKER_BUILDKIT` config) as a first thing to try.

## 1. Topology (Phase 0 §25, unchanged)

```
Windows host (yours, right here)          Linux host (a small VPS — 2 vCPU / 4GB is enough)
─────────────────────────────────         ─────────────────────────────────────────────────
MT5 terminal                               docker-compose.prod.yml:
Python collector (collector/)                postgres · redis · api · web · caddy (TLS)
  outbound HTTPS only, no inbound port ──▶  api.<yourdomain>  (collector pushes here)
                                            app.<yourdomain>  (you visit here)
```

The collector never moves to the Linux host — MT5 only runs on Windows. It keeps running exactly
as it does today (`python main.py` in `collector/`), just pointed at a real domain instead of
`localhost:3000` once the Linux host exists.

## 2. One-time server setup

1. Provision a small Linux VPS (Ubuntu 22.04+ is fine), install Docker + the Compose plugin.
2. Point two DNS A records at the VPS's IP: `api.<yourdomain>` and `app.<yourdomain>`.
3. `git clone` this repo onto the VPS (or copy it over — it's not yet a git repo locally; `git
   init` here first if you want to push it somewhere).
4. Copy and fill in the three env templates — **never commit the filled-in versions**:
   - `.env.production.example` → `.env.production` (repo root — Postgres/Redis passwords, the two domains)
   - `backend/.env.production.example` → `backend/.env.production` (Telegram token, AI key if using it, etc.)
   - `frontend/.env.production.example` → `frontend/.env.production` — leave `DASHBOARD_API_TOKEN`
     blank for now; it's minted in the next step, once the API is up and an account exists (§3).
5. `docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build`
   - `migrate` runs `prisma migrate deploy` once and exits before `api` starts.
   - Caddy requests TLS certificates automatically on first request to each domain — no manual
     certbot/DNS-challenge step, as long as DNS is already pointed at the host.
6. On the Windows collector host, set `COLLECTOR_API_BASE_URL=https://api.<yourdomain>` in
   `collector/.env` (get `COLLECTOR_API_KEY`/`COLLECTOR_ACCOUNT_ID` the same way you did for local
   dev — `npm run bootstrap` / `npm run create-token` against the production API).

## 3. Dashboard & collector authentication (production-readiness review — Option B)

Every dashboard-read route (`GET /accounts`, `GET /accounts/:id`, `GET /accounts/:accountId/{alerts,rules,snapshots/latest,positions,trades}`,
`POST /xtb-import`, `GET /xtb-import/batches/:accountId`, `GET /health`, `GET /health/incidents`)
requires a bearer token, exactly like the collector's own ingestion endpoints (`/collector/*`) already did.
The two token kinds are structurally parallel but never interchangeable — a collector token is
rejected on every dashboard route and vice versa — and both reuse the same `ApiCredential` table
(`scope: 'collector'` vs. `scope: 'dashboard'`, both argon2id-hashed, both account-bound).

- **Minting a dashboard token** (from `backend/`, against a real `accountId`):
  ```
  npm run create-dashboard-token -- <accountId>
  ```
  This revokes any existing dashboard credential for that account and prints the new plaintext
  token once — it is never recoverable afterward; re-run the command to rotate it. The same
  account-binding rule as collector tokens applies: a dashboard token only ever works for the one
  account it was minted against (`GET /accounts` returns just that one account, not every account
  in the system; every other route 403s if the token's account doesn't match the URL/body's).
- **Wiring it into the dashboard**: set `DASHBOARD_API_TOKEN` in `frontend/.env.local` (dev) or
  `frontend/.env.production` (prod) — **never** prefix it `NEXT_PUBLIC_`. Every dashboard page is a
  Server Component, so this value is read server-side only and never reaches the browser bundle
  (verified directly against the built `.next/static` output — the token and the env var's name
  both appear nowhere in it).
- **Docker's own healthcheck carve-out**: `docker-compose.prod.yml`'s `api` service healthcheck
  can't carry a bearer token (it polls from inside the container itself), so `GET /health/live` is
  a deliberately separate, deliberately unauthenticated, deliberately minimal endpoint — it answers
  only `{status:"ok"}` (200) or `{status:"unhealthy"}` (503) based on DATABASE/REDIS reachability,
  never the full per-component detail `GET /health` returns. The real dashboard-facing health
  endpoints (`GET /health`, `GET /health/incidents`) stay behind `DashboardTokenGuard` like every
  other dashboard route.
- **Deliberately not implemented** (out of scope for this pass, left as future hardening): rate
  limiting on either token type, JWT/session/password/OAuth-based login, and user-facing roles —
  the shared-secret-per-account model above is the whole authorization model for now.

## 4. CI/CD

`.github/workflows/ci.yml` runs on every push/PR: backend (typecheck, full test suite against
disposable Postgres+Redis, production build) and frontend (lint, production build) in parallel.
This requires no secrets and needs nothing from you beyond pushing to GitHub.

`.github/workflows/deploy.yml` is manual-trigger-only (`workflow_dispatch`) and, as committed,
**cannot deploy anything** — it SSHes into `secrets.DEPLOY_HOST` with `secrets.DEPLOY_SSH_KEY`,
neither of which exist yet. Once the server from §2 exists, add those as repo secrets (Settings >
Secrets and variables > Actions) and the workflow becomes real. Until then, treat it as a
documented template, not a working pipeline.

## 5. Backups

`backend/scripts/backup.sh` — `pg_dump`s the `postgres` container (via `docker exec`, so it works
identically whether run in dev or in the prod compose stack) into `backend/backups/`, gzip'd,
timestamped, with the retention policy Phase 0 §26 specifies: dumps older than 30 days are
deleted, except roughly one per month is kept longer.

```
cd backend && POSTGRES_CONTAINER=trading-monitor-postgres-prod npm run backup
```

`POSTGRES_CONTAINER` must be set explicitly in production — it defaults to
`trading-monitor-postgres` (the **dev** compose's container name,
`backend/docker-compose.yml`) precisely so dev usage needs no env var at
all; `docker-compose.prod.yml`'s `postgres` service is named
`trading-monitor-postgres-prod` instead (production-readiness review — the
override mechanism already existed in `backup.sh`/`restore.sh`, the compose
file just had no explicit name for it to point at).

Cron it nightly on the production host:
```
0 3 * * * cd /path/to/repo/backend && POSTGRES_CONTAINER=trading-monitor-postgres-prod npm run backup >> /var/log/trading-monitor-backup.log 2>&1
```

Phase 0 §26's own trade-off table: nightly-dump-only means up to 24h of data loss in the worst
case, which it explicitly calls "sufficient" through Phase 1–8. Now that the dashboard exists
(Phase 9) the table names WAL archiving (continuous, seconds-of-loss) as the recommended upgrade
— that needs off-host archive storage and real restore tooling this session had no cloud account
to provision. Nightly `pg_dump` is what's actually running; upgrading to WAL archiving is a
deliberate open item for you, not an oversight.

## 6. Restore drill

Phase 0's own Definition of Done for this phase: *"a restore is exercised at least once before
deployment is considered complete, not assumed to work because the dump completed without
error."* This was done, locally, against the real dev database, during this session:

```
$ npm run backup
Backup written: backups/trading_monitor-20260829T192144Z.sql.gz (28K)

$ bash scripts/restore.sh backups/trading_monitor-20260829T192144Z.sql.gz trading_monitor_restore_drill
Restore complete. Row counts in 'trading_monitor_restore_drill':
 trading_accounts | trades | alerts | rule_definitions | account_snapshots
                 1 |      0 |     13 |                2 |               1964
```

Row counts matched the source exactly. The throwaway `trading_monitor_restore_drill` database was
then dropped — `restore.sh` always restores into a **new** database, never overwrites an existing
one, so running it again (with a real target name) is exactly what a real recovery looks like:

```
bash scripts/restore.sh backups/trading_monitor-<timestamp>.sql.gz trading_monitor
```

Re-run this drill against the production host once it exists — a local drill proves the mechanism
works, not that a specific production backup is good; do it again there before trusting it.

**Re-run against the fixed production container name** (production-readiness review — see §5's
`POSTGRES_CONTAINER` note): brought up just `docker-compose.prod.yml`'s `postgres` service locally,
confirmed it's named `trading-monitor-postgres-prod` as expected, seeded a throwaway table, and
repeated the drill against it:
```
$ POSTGRES_CONTAINER=trading-monitor-postgres-prod npm run backup
Backup written: backups/trading_monitor-20260830T184720Z.sql.gz (4.0K)

$ POSTGRES_CONTAINER=trading-monitor-postgres-prod bash scripts/restore.sh backups/trading_monitor-20260830T184720Z.sql.gz prod_naming_fix_drill
Restore complete. Row counts in 'prod_naming_fix_drill':
ERROR: relation "trading_accounts" does not exist   # expected — no real schema in this isolated test, see below
```
The restore itself succeeded (`CREATE DATABASE` + full data load both completed); `restore.sh`'s
own final diagnostic query failed only because this throwaway test never ran `migrate` (the real
app schema doesn't exist there — that part of the mechanism was already proven separately, above).
Verified the actual restored data directly instead: all 5 seeded rows came back exactly, byte for
byte. The container-naming fix is proven; the throwaway stack was torn down (`down -v`) afterward.

## 7. Rollback

Every image is built from the current `git` checkout, so rolling back is rolling back the
checkout, then rebuilding:

```
git checkout <previous-good-commit>
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

`migrate` re-runs `prisma migrate deploy` on every `up`, which is a no-op if nothing changed and
additive-only if it did — Prisma migrations in this repo have never included a destructive
`DROP COLUMN`/`DROP TABLE` step, so rolling the app back while the schema stays at a newer
version is safe. Rolling the **schema** itself back is not automated — restore from the backup
taken before the migration ran instead (§6).

## 8. What's deliberately not done here

- No real server, domain, or cloud spend — by design (this session was explicitly told not to
  provision infrastructure or spend money while working autonomously).
- WAL archiving / point-in-time recovery — §5's flagged open item, needs off-host storage.
- `deploy.yml` needs your server's secrets before it can run — §4.
- Rate limiting, JWT/session/password/OAuth login, and user roles — §3's flagged open items.
