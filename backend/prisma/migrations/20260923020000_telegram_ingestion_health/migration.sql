-- Two additions in support of Engine B dashboard observability. Additive
-- only; nothing belonging to Engine A or to existing Engine B trading logic
-- is touched.

-- AlterTable: which parser refusal produced a NOT_A_SIGNAL classification,
-- and which transport edge (push/poll) delivered the message first.
ALTER TABLE "telegram_ingested_messages"
  ADD COLUMN "refusal_reason" TEXT,
  ADD COLUMN "delivery_path" TEXT;

-- CreateTable: a periodic snapshot of the telegram-ingest process's own
-- push/poll liveness, written by that process and read by the api process
-- serving the dashboard -- the two are separate containers with no shared
-- memory. Same shape as the existing XauusdM1M5Mt5Snapshot pattern.
CREATE TABLE "telegram_ingestion_health" (
    "account_id" TEXT NOT NULL,
    "authorized" BOOLEAN NOT NULL DEFAULT false,
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "push_last_update_at" TIMESTAMP(3),
    "poll_last_at" TIMESTAMP(3),
    "poll_last_error" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_ingestion_health_pkey" PRIMARY KEY ("account_id")
);
