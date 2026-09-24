# Engine A strategy replacement — migration and rollback plan

Status: **prepared, not executed.** Nothing in this document has been run
against the VPS. This is the plan referenced by the final report; follow it
in order when the operator decides to deploy.

## Pre-deployment checklist

1. **Database backup.** Full `pg_dump` of the production database before
   applying the new migration. Standard backup path already used for this
   project (see `deploy/`); confirm a recent one exists or take one now.
2. **Verify current MT5 account state.**
   - `SELECT * FROM xauusd_m1m5_slot_locks;` — any row means the frozen RSI
     strategy believes it holds an M1 or M5 slot.
   - Broker terminal: list open positions and pending orders directly (not
     only through this application) for magics `262610200`, `262610201`.
   - `SELECT * FROM telegram_signal_group_locks;` — confirm Engine B's own
     state independently; this migration must not touch it, but knowing its
     state going in makes any unexpected change after deploy immediately
     visible.
3. **Decide what to do with existing frozen-strategy exposure**, if any:
   - No open position: proceed, nothing to migrate.
   - An open M1/M5 position: it is **not** silently adopted by
     `xauusd-sar-v1` (different magic, own ownership registry — see
     `ownership.ts`). It remains owned by the frozen strategy's
     reconciliation, which stays active. Decide explicitly whether to let it
     run to its own close or close it manually before activating the new
     strategy. Do this BEFORE step 6.
4. **Confirm the volume to carry forward.** Read the live configured value:
   ```sql
   SELECT volume_lots FROM xauusd_m1m5_volume_settings WHERE account_id = '<account-id>';
   ```
   This is the number that must be seeded into `xauusd_sar_volume_settings`
   in step 6 — never the compiled default (`SAR_DEFAULT_VOLUME_LOTS = 0.5`).
   Per the operator instruction, the new strategy's volume must **not** be
   silently reset just because the strategy changed.
5. **Recipient list.** Confirm `XAUUSD_M1M5_TELEGRAM_TRADING_CHAT_IDS` /
   `_OPS_CHAT_IDS` (or `TELEGRAM_ENGINE_NOTIFY_*` if set) on the VPS holds
   every intended recipient — this is the one list Engine A (new and frozen)
   and Engine B's alerts all read.

## Deployment steps

6. **Pull, build, migrate.**
   ```bash
   git pull
   bash deploy/m1m5.sh build      # or the project's equivalent build step
   npx prisma migrate deploy      # applies xauusd_sar_* tables — additive only,
                                   # touches no existing table
   ```
   Then seed the carried-forward volume (step 4's number):
   ```sql
   INSERT INTO xauusd_sar_volume_settings (account_id, volume_lots, source, provenance, updated_at)
   VALUES ('<account-id>', <value from step 4>, 'MIGRATED_FROM_M1M5', 'Carried forward from xauusd-m1m5 at strategy replacement.', now())
   ON CONFLICT (account_id) DO UPDATE SET volume_lots = EXCLUDED.volume_lots, source = EXCLUDED.source, provenance = EXCLUDED.provenance;
   ```
7. **Environment.** Add, do not yet enable:
   ```
   XAUUSD_SAR_ENABLED=false
   XAUUSD_SAR_EXECUTION_MODE=OFF
   XAUUSD_SAR_ACCOUNT_ID=<same account id already used>
   XAUUSD_SAR_EXECUTION_ENABLED=false     # collector-side flag
   ```
   Leave `XAUUSD_M1M5_EXECUTION_MODE` etc. exactly as they are — they now
   have no effect on entries (hard-retired in code), and touching them is
   unnecessary.
8. **Restart services**, including the collector (`sar_execution_enabled`
   is read at collector startup) and the API.
9. **Start `scripts/xauusd-sar-scheduler.ts`** as its own process (systemd
   unit / pm2 entry / however the other schedulers are run), with
   `XAUUSD_SAR_ENABLED=false` still — so it evaluates and initializes state
   but cannot reach the broker. Confirm in its logs that it starts, resolves
   the account, and reports its mode as OFF.
10. **Post-deploy verification (SHADOW first).**
    - Set `XAUUSD_SAR_EXECUTION_MODE=SHADOW`, restart the scheduler only.
    - Confirm `/xauusd-sar/status` shows sessions initializing at/after
      01:00 Beirut and evaluating triggers, with **no** broker calls (check
      `xauusd_sar_order_attempts` stays empty, or shows only what SHADOW
      itself records if that is later added — currently SHADOW is
      equivalent to OFF for this strategy since there is no separate
      decision-record table; confirm no order attempt rows appear).
    - Confirm the combined daily report (`/xauusd-sar` dashboard and the
      Telegram daily report) shows the session correctly, with zero trades.
11. **Deliberate activation**, when satisfied:
    ```
    XAUUSD_SAR_ENABLED=true
    XAUUSD_SAR_EXECUTION_MODE=DEMO
    XAUUSD_SAR_EXECUTION_ENABLED=true      # collector-side
    ```
    Restart the scheduler and the collector. Confirm the pre-activation
    readiness (the equivalent of Engine B's `telegram-ready` check — see
    "Remaining risks" below, this specific script is not yet built) or at
    minimum manually re-check items in the checklist above before flipping
    this.
12. **Post-activation verification.**
    - Watch the first session initialize (`WAIT_INITIAL_DIRECTION`, with
      correct BUY/SELL triggers) via `/xauusd-sar` and the Telegram alert.
    - Watch the first entry and first reversal end to end, confirming the
      ticket, fill price and dashboard all agree.
    - Confirm Engine B's dashboard and open positions are unaffected
      throughout (the isolation test suite proves this in the abstract;
      this step proves it against the real broker).

## Rollback plan

If anything is wrong after activation:

1. **Immediate stop, no data loss risk:**
   ```
   XAUUSD_SAR_KILL_SWITCH=true
   ```
   (env var or the kill-switch file, same mechanism as Engine A/B). Blocks
   new entries and reversals immediately. Does **not** flatten an open
   position — that is deliberate, matching every other kill switch in this
   codebase (a kill switch that auto-closes a position on engagement is a
   worse outcome than the one it exists to prevent).
2. **Flatten manually if needed:** close the open `SAR_MAGIC` (`262610220`)
   position directly at the broker terminal, or build/trigger a close-request
   equivalent to `xauusd-m1m5`'s if this needs to be a supported code path
   before going live (not yet built — see "Remaining risks").
3. **Full rollback to the frozen RSI strategy:**
   - Set `XAUUSD_SAR_ENABLED=false`. Confirm no SAR position remains open
     (magic `262610220`); if one does, it is not touched by this step and
     must be closed as in step 2 first.
   - `XAUUSD_M1M5_EXECUTION_MODE` cannot be un-retired by an env change — it
     is hard-locked in code (`legacy-entries-disabled.ts`). To genuinely
     revert to the RSI strategy trading again, this specific code change
     must be reverted (`git revert` the commit that added
     `LEGACY_EXECUTION_MODE` to `xauusd-m1m5/controls.ts`) and redeployed.
     This is intentional friction: re-enabling a retired strategy is a
     deliberate, reviewed decision, not a config flip — the same posture
     already applied to `xauusd-rsi`, gold and trend-breakout.
4. **Database rollback.** The migration is purely additive (new tables,
   new columns on nothing existing). Rolling it back means dropping the
   `xauusd_sar_*` tables, which is safe with respect to every other table —
   no foreign key from anywhere else points into them. Historical rows in
   `trades`/`positions` for magic `262610220` are left in place either way
   (never delete trading history); dropping the strategy's own state tables
   does not touch them.

## Remaining risks / open items (see final report §30 for the full list)

- No pre-activation readiness/audit script exists yet for xauusd-sar,
  unlike Engine B's `telegram-ready.js`. Step 11 above is manual until one
  is built.
- No close-request dashboard action exists yet for an operator to request a
  manual flatten through the UI (Engine A/M1M5 has one via
  `close-request.service.ts`); rollback step 2 is broker-terminal-manual or
  kill-switch-plus-wait-for-next-reversal until built.
- The collector-side reversal sequence (close existing ticket, then open the
  new one) is two separate MT5 calls, not one atomic operation — see the
  final report's discussion of `_poll_and_execute_pending_sar_order` for the
  exact partial-failure handling (escalates to UNCERTAIN rather than
  guessing).
- Every SAR order carries a wide catastrophic backstop stop-loss/take-profit
  (this codebase's own `send_bracket_order` enforces "never a bare order");
  the reversal logic is the real exit mechanism, and this backstop should
  only ever fire if the process itself is down or disconnected for an
  extended period. Confirm the configured distance is what the operator
  actually wants before DEMO activation — it is not yet operator-configurable
  from the dashboard.
