-- Engine B's own outgoing-alert table.
--
-- Separate from the RSI engine's for the reason that engine's own schema
-- gives: a shared dedup key space lets one engine's event silently suppress
-- the other's alert about an entirely different position. Both engines trade
-- the same symbol on the same account, so the collision is not hypothetical.
--
-- Additive only. Nothing belonging to the RSI engine is touched.

-- CreateEnum
CREATE TYPE "TelegramEngineNotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'ABANDONED');

-- CreateTable
CREATE TABLE "telegram_engine_notifications" (
    "id" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "recipient_label" TEXT,
    "event_type" TEXT NOT NULL,
    "status" "TelegramEngineNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "message_id" INTEGER,
    "last_error" TEXT,
    "text" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "telegram_engine_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_engine_notifications_dedup_key_key" ON "telegram_engine_notifications"("dedup_key");

-- CreateIndex
CREATE INDEX "telegram_engine_notifications_status_created_at_idx" ON "telegram_engine_notifications"("status", "created_at");
