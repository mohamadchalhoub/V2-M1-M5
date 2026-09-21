-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('MT5', 'XTB');

-- CreateEnum
CREATE TYPE "Side" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "DealEntry" AS ENUM ('IN', 'OUT', 'INOUT', 'OUT_BY');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trading_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "external_account_id" TEXT NOT NULL,
    "broker" TEXT,
    "currency" CHAR(3) NOT NULL,
    "display_name" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "trading_day_timezone" TEXT NOT NULL DEFAULT 'UTC',
    "trading_day_reset_hour" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trading_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "account_id" TEXT NOT NULL,
    "balance" DECIMAL(18,2) NOT NULL,
    "equity" DECIMAL(18,2) NOT NULL,
    "margin" DECIMAL(18,2) NOT NULL,
    "free_margin" DECIMAL(18,2) NOT NULL,
    "margin_level" DECIMAL(9,2),
    "profit" DECIMAL(18,2) NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "external_position_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "Side" NOT NULL,
    "volume" DECIMAL(12,2) NOT NULL,
    "open_price" DECIMAL(18,6) NOT NULL,
    "current_price" DECIMAL(18,6),
    "stop_loss" DECIMAL(18,6),
    "take_profit" DECIMAL(18,6),
    "profit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "swap" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "raw_payload" JSONB,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "external_trade_id" TEXT NOT NULL,
    "position_id" TEXT,
    "order_id" TEXT,
    "symbol" TEXT NOT NULL,
    "side" "Side" NOT NULL,
    "deal_entry" "DealEntry" NOT NULL,
    "volume" DECIMAL(12,2) NOT NULL,
    "price" DECIMAL(18,6) NOT NULL,
    "commission" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "swap" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "profit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "executed_at" TIMESTAMP(3) NOT NULL,
    "comment" TEXT,
    "raw_payload" JSONB,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_cursors" (
    "account_id" TEXT NOT NULL,
    "last_synced_at" TIMESTAMP(3),
    "last_deal_ticket" TEXT,

    CONSTRAINT "sync_cursors_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "collector_heartbeats" (
    "account_id" TEXT NOT NULL,
    "last_heartbeat_at" TIMESTAMP(3) NOT NULL,
    "mt5_connected" BOOLEAN NOT NULL,
    "last_error" TEXT,
    "collector_version" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collector_heartbeats_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "api_credentials" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'collector',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "api_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "trading_accounts_platform_external_account_id_key" ON "trading_accounts"("platform", "external_account_id");

-- CreateIndex
CREATE INDEX "account_snapshots_account_id_captured_at_idx" ON "account_snapshots"("account_id", "captured_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "account_snapshots_account_id_captured_at_key" ON "account_snapshots"("account_id", "captured_at");

-- CreateIndex
CREATE INDEX "positions_account_id_status_idx" ON "positions"("account_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "positions_account_id_platform_external_position_id_key" ON "positions"("account_id", "platform", "external_position_id");

-- CreateIndex
CREATE INDEX "trades_account_id_executed_at_idx" ON "trades"("account_id", "executed_at" DESC);

-- CreateIndex
CREATE INDEX "trades_account_id_symbol_idx" ON "trades"("account_id", "symbol");

-- CreateIndex
CREATE INDEX "trades_account_id_position_id_idx" ON "trades"("account_id", "position_id");

-- CreateIndex
CREATE UNIQUE INDEX "trades_account_id_platform_external_trade_id_key" ON "trades"("account_id", "platform", "external_trade_id");

-- AddForeignKey
ALTER TABLE "trading_accounts" ADD CONSTRAINT "trading_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_snapshots" ADD CONSTRAINT "account_snapshots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collector_heartbeats" ADD CONSTRAINT "collector_heartbeats_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
