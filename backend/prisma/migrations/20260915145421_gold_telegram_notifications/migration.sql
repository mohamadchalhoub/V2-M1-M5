-- CreateEnum
CREATE TYPE "GoldTelegramNotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "gold_telegram_notifications" (
    "id" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "status" "GoldTelegramNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "message_id" INTEGER,
    "last_error" TEXT,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "gold_telegram_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gold_telegram_notifications_dedup_key_key" ON "gold_telegram_notifications"("dedup_key");

-- CreateIndex
CREATE INDEX "gold_telegram_notifications_status_created_at_idx" ON "gold_telegram_notifications"("status", "created_at");
