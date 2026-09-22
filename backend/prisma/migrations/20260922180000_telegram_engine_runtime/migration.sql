-- Engine B runtime integration: the TP1 latch, the measured execution
-- timeline, Telegram edits, per-leg broker identity and closure, the
-- reconciliation state that `recoveryComplete` is read from, and the raw
-- ingestion log.
--
-- Additive only. No existing table, column, index or constraint belonging to
-- the RSI M1/M5 engine is touched.

-- AlterTable: telegram_signals
ALTER TABLE "telegram_signals"
  ADD COLUMN "tp1" DECIMAL(18,6),
  ADD COLUMN "tp1_touched" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "tp1_touched_at" TIMESTAMP(3),
  ADD COLUMN "tp1_touch_price" DECIMAL(18,6),
  ADD COLUMN "favourable_entry" BOOLEAN,
  ADD COLUMN "parser_version" TEXT NOT NULL DEFAULT '1',
  ADD COLUMN "edit_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_edited_at" TIMESTAMP(3),
  ADD COLUMN "edit_history" JSONB,
  ADD COLUMN "parser_completed_at" TIMESTAMP(3),
  ADD COLUMN "decision_at" TIMESTAMP(3),
  ADD COLUMN "publication_to_ingestion_ms" INTEGER,
  ADD COLUMN "ingestion_to_parse_ms" INTEGER,
  ADD COLUMN "parse_to_decision_ms" INTEGER,
  ADD COLUMN "publication_to_decision_ms" INTEGER;

-- AlterTable: telegram_signal_legs
--
-- `idempotency_tag` is added NOT NULL with no default and backfilled from the
-- row id, which is safe because it is unique per row by construction. It is
-- what a recovery pass matches a broker position against: several legs share
-- the Telegram magic number, so the magic alone cannot identify one.
ALTER TABLE "telegram_signal_legs"
  ADD COLUMN "decision_to_submission_ms" INTEGER,
  ADD COLUMN "publication_to_submission_ms" INTEGER,
  ADD COLUMN "submission_to_broker_ack_ms" INTEGER,
  ADD COLUMN "claimed_at" TIMESTAMP(3),
  ADD COLUMN "idempotency_tag" TEXT,
  ADD COLUMN "protection_verified_at" TIMESTAMP(3),
  ADD COLUMN "protection_incident" TEXT,
  ADD COLUMN "reconciled_at" TIMESTAMP(3),
  ADD COLUMN "closed_at" TIMESTAMP(3),
  ADD COLUMN "closure_complete" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "realized_pl" DECIMAL(18,6);

UPDATE "telegram_signal_legs" SET "idempotency_tag" = "id" WHERE "idempotency_tag" IS NULL;
ALTER TABLE "telegram_signal_legs" ALTER COLUMN "idempotency_tag" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "telegram_signal_legs_idempotency_tag_key" ON "telegram_signal_legs"("idempotency_tag");

-- CreateTable
CREATE TABLE "telegram_reconciliation_state" (
    "account_id" TEXT NOT NULL,
    "recovery_complete" BOOLEAN NOT NULL DEFAULT false,
    "last_completed_at" TIMESTAMP(3),
    "broker_snapshot_at" TIMESTAMP(3),
    "unresolved_legs" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_reconciliation_state_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "telegram_ingested_messages" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "publication_to_ingestion_ms" INTEGER,
    "text_preview" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "is_edit" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_ingested_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_ingested_messages_channel_id_message_id_is_edit_key" ON "telegram_ingested_messages"("channel_id", "message_id", "is_edit");

-- CreateIndex
CREATE INDEX "telegram_ingested_messages_received_at_idx" ON "telegram_ingested_messages"("received_at");
