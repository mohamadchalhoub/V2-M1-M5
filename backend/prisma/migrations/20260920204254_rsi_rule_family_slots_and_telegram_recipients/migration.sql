-- Rule-family execution slots for xauusd-m1-rsi-retest-extremes-v1, and
-- per-recipient Telegram delivery records.
--
-- Written by hand rather than left as Prisma generated it, for two reasons:
-- the generated version adds NOT NULL columns with no default (which fails on
-- any non-empty table, and this project's own database is not the only place
-- this migration may run), and the slot reservation needs a PARTIAL unique
-- index, which Prisma's schema language cannot express.

-- CreateEnum
CREATE TYPE "XauusdRsiRuleFamily" AS ENUM ('RETEST', 'EXTREME');

-- ---------------------------------------------------------------------------
-- Telegram: one delivery record per RECIPIENT.
--
-- Both columns are nullable on purpose. Rows written before multi-recipient
-- support existed have no recipient recorded, and back-filling them with the
-- current sole recipient would assert something about history that was never
-- observed.
-- ---------------------------------------------------------------------------
ALTER TABLE "gold_telegram_notifications"
  ADD COLUMN "chat_id" TEXT,
  ADD COLUMN "recipient_label" TEXT;

CREATE INDEX "gold_telegram_notifications_chat_id_created_at_idx"
  ON "gold_telegram_notifications" ("chat_id", "created_at");

-- ---------------------------------------------------------------------------
-- Decisions: rule family, event identity, and slot release.
-- ---------------------------------------------------------------------------

-- Added nullable first so the statement succeeds regardless of existing rows.
ALTER TABLE "xauusd_rsi_decisions"
  ADD COLUMN "rule_family" "XauusdRsiRuleFamily",
  ADD COLUMN "event_id" TEXT,
  ADD COLUMN "slot_released_at" TIMESTAMP(3);

-- Back-fill from the setups each historical row actually recorded, so an
-- existing decision is classified by what it really was rather than by a
-- blanket default. A row carrying only extreme setups is EXTREME; anything
-- else is RETEST.
UPDATE "xauusd_rsi_decisions"
SET "rule_family" = CASE
  WHEN "setup_kinds" <@ ARRAY['EXTREME_SELL', 'EXTREME_BUY']::"XauusdRsiSetupKind"[]
    THEN 'EXTREME'::"XauusdRsiRuleFamily"
  ELSE 'RETEST'::"XauusdRsiRuleFamily"
END
WHERE "rule_family" IS NULL;

-- Historical rows predate event identity; the row's own id is a stable,
-- unique stand-in and is honest about its provenance.
UPDATE "xauusd_rsi_decisions"
SET "event_id" = 'legacy:' || "id"
WHERE "event_id" IS NULL;

-- A historical decision that never occupied a slot, or whose position is long
-- gone, must not hold a slot forever once the constraint below exists. Only
-- rows that are genuinely still in flight keep holding.
UPDATE "xauusd_rsi_decisions"
SET "slot_released_at" = COALESCE("filled_at", "evaluated_at")
WHERE "slot_released_at" IS NULL
  AND "order_status" NOT IN ('PENDING', 'SENT', 'UNKNOWN');

ALTER TABLE "xauusd_rsi_decisions"
  ALTER COLUMN "rule_family" SET NOT NULL,
  ALTER COLUMN "event_id" SET NOT NULL;

CREATE INDEX "xauusd_rsi_decisions_account_id_rule_family_slot_released_a_idx"
  ON "xauusd_rsi_decisions" ("account_id", "rule_family", "slot_released_at");

CREATE INDEX "xauusd_rsi_decisions_event_id_idx"
  ON "xauusd_rsi_decisions" ("event_id");

-- ---------------------------------------------------------------------------
-- The slot reservation itself.
--
-- At most ONE slot-holding decision per account per rule family. This is what
-- makes the reservation atomic: two concurrent evaluations for the same family
-- cannot both insert, because the second violates this index and is rejected
-- by the database rather than by a check that could interleave.
--
-- A decision holds its slot from the moment it is queued until reconciliation
-- against real broker state sets `slot_released_at` — so a FILLED decision
-- whose position is still open keeps holding, which is exactly the intent.
--
-- Rows with no account are excluded: they cannot occupy an account's slot.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "xauusd_rsi_one_slot_holder_per_family"
  ON "xauusd_rsi_decisions" ("account_id", "rule_family")
  WHERE "slot_released_at" IS NULL
    AND "account_id" IS NOT NULL
    AND "order_status" IN ('PENDING', 'SENT', 'UNKNOWN', 'FILLED');
