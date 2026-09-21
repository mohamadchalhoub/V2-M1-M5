-- CreateEnum
CREATE TYPE "GoldProtectionRestoreStatus" AS ENUM ('PENDING', 'SENT', 'RESTORED', 'FAILED');

-- CreateTable
CREATE TABLE "gold_protection_restore_requests" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "position_ticket" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "stopLoss" DECIMAL(18,6) NOT NULL,
    "takeProfit" DECIMAL(18,6) NOT NULL,
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "status" "GoldProtectionRestoreStatus" NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "result_error" TEXT,
    "restored_at" TIMESTAMP(3),

    CONSTRAINT "gold_protection_restore_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gold_protection_restore_requests_status_requested_at_idx" ON "gold_protection_restore_requests"("status", "requested_at");

-- CreateIndex
CREATE INDEX "gold_protection_restore_requests_position_ticket_status_idx" ON "gold_protection_restore_requests"("position_ticket", "status");
