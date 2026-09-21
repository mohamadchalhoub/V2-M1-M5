-- CreateEnum
CREATE TYPE "GoldCloseRequestStatus" AS ENUM ('PENDING', 'SENT', 'CLOSED', 'FAILED');

-- CreateTable
CREATE TABLE "gold_close_requests" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "position_ticket" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "volume" DECIMAL(18,6) NOT NULL,
    "status" "GoldCloseRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "result_deal_ticket" INTEGER,
    "result_closed_price" DECIMAL(18,6),
    "result_error" TEXT,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "gold_close_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gold_close_requests_status_requested_at_idx" ON "gold_close_requests"("status", "requested_at");

-- CreateIndex
CREATE INDEX "gold_close_requests_position_ticket_status_idx" ON "gold_close_requests"("position_ticket", "status");
