-- Telegram delivery records for xauusd-m1-m5-rsi-threshold-v2.
--
-- Its own table, not the neighbouring strategy's: a shared dedup key space
-- would let one strategy's event suppress the other's alert about a different
-- position. One row per RECIPIENT, so a retry re-sends only what failed.

-- CreateEnum
CREATE TYPE "XauusdM1M5TelegramStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "xauusd_m1m5_telegram_notifications" (
    "id" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "recipient_label" TEXT,
    "event_type" TEXT NOT NULL,
    "status" "XauusdM1M5TelegramStatus" NOT NULL DEFAULT 'PENDING',
    "message_id" INTEGER,
    "last_error" TEXT,
    "text" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "xauusd_m1m5_telegram_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "xauusd_m1m5_telegram_notifications_dedup_key_key" ON "xauusd_m1m5_telegram_notifications"("dedup_key");

-- CreateIndex
CREATE INDEX "xauusd_m1m5_telegram_notifications_status_created_at_idx" ON "xauusd_m1m5_telegram_notifications"("status", "created_at");
