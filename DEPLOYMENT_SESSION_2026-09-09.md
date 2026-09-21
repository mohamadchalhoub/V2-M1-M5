# Deployment session — 2026-09-09

Record of what was done to get the Trading Behavior Monitor live on the Hostinger VPS
(`179.198.207.146`, domains `api.jokertrade.tech` / `app.jokertrade.tech`), and the bugs found
and fixed along the way. See `DEPLOYMENT_SINGLE_VPS.md` for the general runbook this followed;
this document is the specific log of this session's work, not a replacement for it.

## 1. Starting state

The VPS already had partial setup from an earlier session (before this conversation's history
was cleared): Xvfb, the MT5 terminal, and Wine-hosted Python were installed and running, the repo
was checked out at `/opt/trading-monitor`, and the three `.env.production` files existed with real
values already filled in. Not yet done: the collector's own `.env`, the `mt5-collector.service`
unit, and the Docker stack hadn't been started.

## 2. Access model

Outbound SSH from the local dev/agent environment to the VPS is not reachable — connectivity
tests to port 22 consistently time out, while HTTPS (443) to the VPS domains works fine. All VPS
work this session went through Hostinger's browser-based web console instead (a root shell,
copy-pasted commands one exchange at a time). This is a constraint of the local tool environment,
not of the VPS itself — its own firewall (`ufw`) already correctly allowed 22/80/443 the whole
time.

## 3. Bringing the stack up

- Brought up `docker-compose.prod.yml` (postgres, redis, api, web, caddy) — all healthy, TLS
  issued automatically by Caddy for both domains.
- Found and fixed: `backend/scripts/backup.sh` and `restore.sh` had CRLF line endings on the VPS
  (introduced by whatever one-off transfer got the code there — the git-tracked source was
  already LF-only), which broke `set -euo pipefail`. Fixed live and confirmed a real backup file
  was produced.
- Bootstrapped the trading account, minted the collector token and dashboard token, wired both
  into `frontend/.env.production` and `collector/.env`.

## 4. MT5 account switch

The account originally intended for the VPS (`10012425443`) turned out to have an unknown
password (only ever logged into interactively, never saved anywhere in a file) — `mt5.initialize()`
failed with "Authorization failed". A **new** MetaQuotes demo account was created instead:
login `10012608757`, server `MetaQuotes-Demo`. The old account's leftover trading_account row on
the VPS was deleted and re-bootstrapped under the new login. This is a different account number
than local dev uses — see §7 for why, and what was done to compensate.

Verified live against the real Wine-hosted terminal (`mt5.initialize()` + `account_info()`) before
building anything else on top of it, per the runbook's own stop-and-verify gate.

## 5. Collector wiring

- Installed Windows Python 3.13 inside the Wine prefix (the runbook's own template assumed
  3.12 — fixed the path when installing `mt5-collector.service`, and fixed it in the repo's
  `deploy/systemd/mt5-collector.service` template too).
- Wrote `collector/.env` with the new account's credentials and the minted collector token.
- Installed and started `mt5-collector.service` — confirmed connected, pushing snapshots every
  10s, backfilling EURUSD candle history across all configured timeframes.

## 6. Verification

- Telegram diagnostic message (`send-account-summary.ts`) delivered successfully.
- Full reboot survival test: `sudo reboot`, waited, reconnected — `xvfb`/`mt5-terminal`/
  `mt5-collector` and all five Docker containers came back automatically, no manual steps.
- Nightly Postgres backup cron installed (`3am`, via the `deploy` user's crontab).

## 7. Local/production parity

The user's standing requirement: production should behave exactly like local dev, not just run
the same code. Checked and matched:

- All AI/rules/news/economic-calendar tuning env vars (`AI_MODEL`, `ICHIMOKU_TIMEFRAMES`,
  `FIBONACCI_LOOKBACK`, `SUPPORT_RESISTANCE_PROXIMITY_POINTS`, etc.) — confirmed identical values
  between `backend/.env` (local) and `backend/.env.production` (VPS).
- The same 3 real rule definitions local dev has (`SUPPORT_RESISTANCE_PROXIMITY`,
  `ICHIMOKU_BREAKOUT`, `DAILY_MARKET_ANALYSIS`) were created on the production account with
  identical parameters/cooldowns, via `backend/scripts/manage-rules.ts`. Four other rules that
  exist locally (`E2E_TEST_DRAWDOWN` and three "Live test: ..." rules) were deliberately **not**
  copied — they're disabled leftover QA scaffolding, not real configuration.
- **The XTB reference account**: local dev has a second, non-MT5 trading account (`XTB 50283640`)
  that exists purely to hold a friend's historical EURUSD trade history (1,730 trades, imported
  once from an `.xlsx` export). It's never "live monitored," but
  `HistoricalPatternSummaryService.build()` (`backend/src/ai/historical-pattern-summary.service.ts`)
  deliberately pulls trades across **every** account via `TradeAlignmentService.getAllRoundTrips()`
  — so this dataset silently feeds every account's AI analysis, not just its own. Recreated this
  same account on production and re-imported the exact same source file (from the user's
  `Downloads` folder) via a direct `POST /xtb-import` call — result matched the local import
  exactly (866 rows total, 865 imported, 1 skipped, same error message).

## 8. GitHub integration

The VPS's git checkout was originally seeded by copying files over directly, not a real clone —
its git history was one disconnected "snapshot" commit, unrelated to GitHub's actual history, and
the repo (`github.com/mohamadchalhoub/AutomationTrade`) is private. Set up so all future changes
go **GitHub first, then pulled onto the VPS** — never hand-edited on the server:

1. Generated an ed25519 keypair as the `deploy` user on the VPS.
2. Added its public half as a read-only Deploy Key on the GitHub repo.
3. Added `git@github.com:mohamadchalhoub/AutomationTrade.git` as `origin`.
4. `git reset --hard origin/master` once, to replace the VPS's disconnected snapshot history with
   the real one (safe: all secrets live in `.gitignore`d `.env*` files that were never tracked in
   the first place — verified against the full commit history, not just current state, before
   trusting this).

Standard update flow from here on: commit + `git push` locally, then on the VPS
`cd /opt/trading-monitor && sudo -u deploy git pull origin master`, then rebuild/restart whichever
service actually changed.

## 9. Bugs found and fixed

- **Dashboard timezone**: `formatDateTime()` and two ad-hoc `toLocaleString()` call sites used the
  rendering server's local timezone (UTC in production) instead of `Asia/Beirut`. Fixed in
  `frontend/src/lib/format.ts` and two page components.
- **No dashboard authentication**: the Next.js app itself had no login — anyone who knew
  `app.jokertrade.tech` could see live account data. Added HTTP Basic Auth at the Caddy layer
  (`DASHBOARD_BASIC_AUTH_USER`/`_HASH` in `.env.production`, wired through
  `docker-compose.prod.yml` into the `Caddyfile`).
  - Follow-on bug: the generated bcrypt hash contains `$` characters, which Docker Compose's
    `--env-file` interpolation tried to parse as variable references, silently truncating the
    hash. Fixed by escaping every `$` as `$$` in the `.env.production` value.
- **MT5 trade-sync returning zero deals** (root cause of empty History/EURUSD-charts pages despite
  real trades existing): two compounding bugs in `collector/app/mt5_client.py`'s
  `get_deals_since()`, both specific to `history_deals_get()` under Wine:
  1. Passing Python `datetime` objects (tz-aware or naive) silently returned zero results, even
     for a window covering deals verified to exist — fixed by passing Unix epoch integers instead
     (`copy_rates_range()`, used for candles, does not share this bug and still takes `datetime`
     objects).
  2. Even with integer timestamps, `history_deals_get()` compares against each deal's **raw**
     epoch — broker-local wall-clock digits mislabeled as UTC (the same quantity
     `_mt5_time_to_utc()` already corrects for on the way out) — not true UTC. A precise real-UTC
     "now" upper bound silently excluded every deal from roughly the last broker-UTC-offset hours
     (~3h for EEST), because those deals' raw timestamps still looked like they were in the
     future relative to a true-UTC cutoff. Fixed by adding `_utc_to_mt5_epoch()`, the inverse of
     the existing `_mt5_time_to_utc()`, and applying it to both query bounds.
  3. One-time cleanup: the sync cursor (`sync_cursors` table) had already advanced past the
     missed trades while the bug was live (it moves forward every tick regardless of whether
     anything was found), so it had to be manually reset backward once, after deploying the fix,
     for the already-placed trades to actually be picked up. Verified: `deals_sent: 12,
     trades_created: 12` on the next cycle, all 12 trade legs landed with correct symbols, sides,
     prices, and true-UTC timestamps.
- **Mobile responsiveness**: the nav bar (brand name + 8 links in one non-wrapping flex row) was
  wider than any phone viewport with no way to reach items past the fold. Changed to a
  horizontally scrollable tab strip. The EURUSD-charts page's fixed `280px` sidebar column also
  broke on narrow screens — now stacks above the chart below the `sm` breakpoint. `PageHeader`
  now wraps instead of clipping when title + right-side content don't fit one row.

## 10. Known remaining items (not urgent, nothing currently broken)

- **Root SSH still allows password auth**, not just keys. Hardening this needs the user's own
  public key added via the console first (outbound SSH from the agent environment can't reach the
  VPS to do this directly), then `PermitRootLogin no` / `PasswordAuthentication no` in
  `/etc/ssh/sshd_config`.
- **Redis password was echoed in plaintext once** in an earlier diagnostic command in this
  session (a masking regex that didn't account for Redis's `redis://:password@host` format,
  which has no username segment). Internal-only (never exposed outside the Docker network), low
  real risk, but worth rotating for hygiene.
- **Intermittent "History → Dashboard gives a 404" report**: reproducing this fresh in a headless
  browser did not show the bug — the most likely explanation is a browser tab left open across
  this session's several `web` container redeploys, serving a stale client-side build reference
  for soft (client-side) navigation while full page loads always fetch the current build. Not
  chased further at the user's request; try a hard refresh / new tab first if it recurs.

## 11. Where things live

- VPS: `/opt/trading-monitor`, git remote `origin` → GitHub (deploy-key auth, read-only).
- Collector config: `/opt/trading-monitor/collector/.env` (real MT5 login/password/server, never
  committed).
- Production secrets: `.env.production`, `backend/.env.production`, `frontend/.env.production`
  (all `.gitignore`d, all `chmod 600`, all on the VPS only).
- Dashboard login credentials: in `.env.production`'s `DASHBOARD_BASIC_AUTH_USER`/`_HASH` on the
  VPS — not duplicated in this file since it's tracked in git.
- The friend's original XTB trade-history export: `Downloads\account_50283640_fr_xlsx_2005-12-31_2026-08-25.xlsx`
  on the user's Windows machine — not stored anywhere in the repo or database (only the parsed
  trade rows persist), so a from-scratch database rebuild would need this file re-imported.
