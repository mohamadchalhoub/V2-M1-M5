# Provenance

This project was created as a **copy of a committed state** of another
repository. It is a separate project with its own Git history, and it has no
remote and no connection to the original.

## Source

| | |
|---|---|
| Source working copy | `C:\Users\user\Desktop\trading-monitor-autonomous` |
| Source remote | `https://github.com/mohamadchalhoub/trading-monitor-autonomous.git` |
| Source commit | `bf083c8` — *Merge pull request #8 from mohamadchalhoub/strategy/xauusd-m1-rsi-retest-extremes-v1* |
| Source branch | `master` (also the tip of `strategy/xauusd-m1-rsi-retest-extremes-v1` by content) |
| Source tree | `e7697cd95383fe78809685d081e0efc1e2de9173` |
| Copied on | 2026-09-21 |

`bf083c8` and the branch head `6f896f5307022cc4edc8cd26aa1870e7fb9ca32f` have
**identical trees** — the same files byte for byte. `bf083c8` was chosen
because it is the commit deployed to the production VPS at the time of the
copy, so this project starts from a state that is known to run.

The copy was taken with `git archive`, so it contains exactly the files
**tracked at that commit** and nothing from the source working directory.
Two uncommitted items in the source (`.claude/settings.json` modifications
and an untracked `.VSCodeCounter/` directory) were therefore not copied. The
source repository was not modified.

## What was deliberately excluded

Everything below was tracked in the source but is not appropriate to carry
into a new project.

| Excluded | Count | Why |
|---|---|---|
| `collector/.venv/**` | 3,297 files | A Python virtualenv committed to the source repository. Installed dependencies, equivalent to `node_modules`. Recreate with `python -m venv` and `pip install -r requirements.txt`. |
| `**/*.log` | 14 files | Run logs and research verification output from the source project's own execution. |

Nothing else needed removing, because the rest was already untracked at the
source and so never entered the archive: `node_modules/`, `dist/`, `.next/`,
databases, runtime state directories (`xauusd-rsi-runtime/`,
`gold-execution-runtime/`), kill-switch and stop-new-entries control files,
watch-state and lock files, and every real `.env`.

## What was intentionally kept

- **All application code**, backend, collector and frontend
- **All 35 Prisma migrations**, plus `migration_lock.toml`
- **All documentation**, including the deployment guides and the XAUUSD RSI
  operations manual
- **Configuration templates**: every `.env.example` and
  `.env.production.example`
- **`docker-compose.prod.yml`**, the `deploy/` directory and the `Caddyfile`

### One judgement call: `backend/.env.test`

This is a real file rather than a template, so it deserves a note. It was
kept because the test suite reads it and it holds no secrets: every
credential in it is a literal placeholder (`test-bot-token-not-real`,
`test-api-key-not-real`), and its only password belongs to a local test
Postgres container. Delete it if you would rather start from nothing.

## Relationship to the source project

This project **does not** share infrastructure with the source. Before
running anything here, give it dedicated resources: its own database and
containers, its own ports and volumes, its own MT5 account, and its own
Telegram bot and chat ids. Reusing any of the source project's live
resources — in particular its database or its broker account — would
interfere with a system that is currently deployed and trading.

The source project's own deployment, on the VPS at
`/opt/autonomous-trading`, is entirely separate and was not touched by this
copy.

## Status

The M1/M5 strategy is **not implemented**. This is the source project's code
as of `bf083c8`, unmodified apart from the exclusions above, as a starting
point.
