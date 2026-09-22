-- Close requests for xauusd-m1-m5-rsi-threshold-v2.
--
-- The backend cannot reach MetaTrader directly; the terminal lives in the
-- collector's container behind a poll. A close, like an entry, is therefore a
-- durable row the collector claims and reports back on.

-- CreateEnum
CREATE TYPE "XauusdM1M5CloseKind" AS ENUM ('POSITION', 'PENDING_ORDER');

-- CreateEnum
CREATE TYPE "XauusdM1M5CloseStatus" AS ENUM ('PENDING', 'SENT', 'ACCEPTED', 'FAILED');

-- CreateTable
CREATE TABLE "xauusd_m1m5_close_requests" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "ticket" TEXT NOT NULL,
    "kind" "XauusdM1M5CloseKind" NOT NULL,
    "magic_number" INTEGER NOT NULL,
    "timeframe" "XauusdM1M5Timeframe" NOT NULL,
    "volume" DECIMAL(18,6) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "XauusdM1M5CloseStatus" NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "error_message" TEXT,

    CONSTRAINT "xauusd_m1m5_close_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "xauusd_m1m5_close_requests_account_id_status_idx" ON "xauusd_m1m5_close_requests"("account_id", "status");

-- CreateIndex
CREATE INDEX "xauusd_m1m5_close_requests_account_id_ticket_idx" ON "xauusd_m1m5_close_requests"("account_id", "ticket");

-- AddForeignKey
ALTER TABLE "xauusd_m1m5_close_requests" ADD CONSTRAINT "xauusd_m1m5_close_requests_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
