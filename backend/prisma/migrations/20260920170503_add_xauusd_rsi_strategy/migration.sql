-- CreateEnum
CREATE TYPE "XauusdRsiOrderStatus" AS ENUM ('NONE', 'PENDING', 'SENT', 'FILLED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "XauusdRsiSetupKind" AS ENUM ('SELL_PEAK_RETEST', 'BUY_TROUGH_RETEST', 'EXTREME_SELL', 'EXTREME_BUY');

-- CreateEnum
CREATE TYPE "XauusdRsiDirection" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "XauusdRsiLiquidationItemKind" AS ENUM ('POSITION', 'PENDING_ORDER');

-- CreateEnum
CREATE TYPE "XauusdRsiLiquidationItemStatus" AS ENUM ('OUTSTANDING', 'SUBMITTED', 'CONFIRMED_CLEARED', 'FAILED');

-- CreateTable
CREATE TABLE "xauusd_rsi_decisions" (
    "id" TEXT NOT NULL,
    "strategy_version" TEXT NOT NULL,
    "spec_hash" TEXT NOT NULL,
    "account_id" TEXT,
    "symbol" TEXT NOT NULL DEFAULT 'XAUUSD',
    "observed_at" TIMESTAMP(3) NOT NULL,
    "evaluated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "direction" "XauusdRsiDirection" NOT NULL,
    "setup_kinds" "XauusdRsiSetupKind"[],
    "rsi_value" DECIMAL(12,8) NOT NULL,
    "previous_rsi" DECIMAL(12,8),
    "basis_price" DECIMAL(18,6) NOT NULL,
    "observation_mode" TEXT NOT NULL,
    "entry_price" DECIMAL(18,6),
    "stop_loss" DECIMAL(18,6),
    "take_profit" DECIMAL(18,6),
    "volume_lots" DECIMAL(18,6),
    "reasoning" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "skip_reason" TEXT,
    "order_status" "XauusdRsiOrderStatus" NOT NULL DEFAULT 'NONE',
    "magic_number" INTEGER NOT NULL,
    "mt5_ticket" INTEGER,
    "requested_price" DECIMAL(18,6),
    "filled_price" DECIMAL(18,6),
    "slippage_points" DECIMAL(18,6),
    "broker_stop_loss" DECIMAL(18,6),
    "broker_take_profit" DECIMAL(18,6),
    "filled_at" TIMESTAMP(3),
    "execution_error" TEXT,

    CONSTRAINT "xauusd_rsi_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "xauusd_rsi_liquidation_items" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL DEFAULT 'XAUUSD',
    "deadline_at" TIMESTAMP(3) NOT NULL,
    "kind" "XauusdRsiLiquidationItemKind" NOT NULL,
    "ticket" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "volume" DECIMAL(18,6) NOT NULL,
    "magic_number" INTEGER NOT NULL,
    "status" "XauusdRsiLiquidationItemStatus" NOT NULL DEFAULT 'OUTSTANDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "cleared_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "xauusd_rsi_liquidation_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "xauusd_rsi_decisions_evaluated_at_idx" ON "xauusd_rsi_decisions"("evaluated_at" DESC);

-- CreateIndex
CREATE INDEX "xauusd_rsi_decisions_account_id_order_status_idx" ON "xauusd_rsi_decisions"("account_id", "order_status");

-- CreateIndex
CREATE INDEX "xauusd_rsi_decisions_observed_at_idx" ON "xauusd_rsi_decisions"("observed_at" DESC);

-- CreateIndex
CREATE INDEX "xauusd_rsi_liquidation_items_status_deadline_at_idx" ON "xauusd_rsi_liquidation_items"("status", "deadline_at");

-- CreateIndex
CREATE UNIQUE INDEX "xauusd_rsi_liquidation_items_deadline_at_ticket_key" ON "xauusd_rsi_liquidation_items"("deadline_at", "ticket");

-- AddForeignKey
ALTER TABLE "xauusd_rsi_decisions" ADD CONSTRAINT "xauusd_rsi_decisions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
