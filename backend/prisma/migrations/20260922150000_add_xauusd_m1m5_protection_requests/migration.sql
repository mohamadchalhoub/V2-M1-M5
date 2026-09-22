-- Protection remediation requests for xauusd-m1-m5-rsi-threshold-v2.
--
-- A filled order is not proof that protection is attached: the broker can
-- confirm a fill and still report no stop loss. Its own table, never a flag on
-- the close-request table, so a mis-branched request cannot CLOSE a position
-- when it meant to REPAIR one.

-- CreateEnum
CREATE TYPE "XauusdM1M5ProtectionStatus" AS ENUM ('PENDING', 'SENT', 'ACCEPTED', 'FAILED');

-- CreateTable
CREATE TABLE "xauusd_m1m5_protection_requests" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "ticket" TEXT NOT NULL,
    "timeframe" "XauusdM1M5Timeframe" NOT NULL,
    "magic_number" INTEGER NOT NULL,
    "stop_loss" DECIMAL(18,6) NOT NULL,
    "take_profit" DECIMAL(18,6) NOT NULL,
    "missing" TEXT NOT NULL,
    "status" "XauusdM1M5ProtectionStatus" NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "error_message" TEXT,

    CONSTRAINT "xauusd_m1m5_protection_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "xauusd_m1m5_protection_requests_account_id_status_idx" ON "xauusd_m1m5_protection_requests"("account_id", "status");

-- CreateIndex
CREATE INDEX "xauusd_m1m5_protection_requests_account_id_ticket_idx" ON "xauusd_m1m5_protection_requests"("account_id", "ticket");

-- AddForeignKey
ALTER TABLE "xauusd_m1m5_protection_requests" ADD CONSTRAINT "xauusd_m1m5_protection_requests_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
