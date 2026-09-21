-- CreateEnum
CREATE TYPE "TrendBreakoutCloseRequestStatus" AS ENUM ('PENDING', 'SENT', 'CLOSED', 'FAILED');

-- CreateTable
CREATE TABLE "trend_breakout_close_requests" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "instrument" "TrendBreakoutInstrument" NOT NULL,
    "symbol" TEXT NOT NULL,
    "position_ticket" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "volume" DECIMAL(18,6) NOT NULL,
    "status" "TrendBreakoutCloseRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "result_deal_ticket" INTEGER,
    "result_closed_price" DECIMAL(18,6),
    "result_error" TEXT,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "trend_breakout_close_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trend_breakout_close_requests_status_requested_at_idx" ON "trend_breakout_close_requests"("status", "requested_at");

-- CreateIndex
CREATE INDEX "trend_breakout_close_requests_position_ticket_status_idx" ON "trend_breakout_close_requests"("position_ticket", "status");

-- AddForeignKey
ALTER TABLE "trend_breakout_close_requests" ADD CONSTRAINT "trend_breakout_close_requests_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
