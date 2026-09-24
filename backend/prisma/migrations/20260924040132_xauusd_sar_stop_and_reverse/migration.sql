-- CreateEnum
CREATE TYPE "XauusdSarState" AS ENUM ('WAIT_MARKET_OPEN', 'WAIT_INITIAL_DIRECTION', 'ACTIVE_BUY', 'ACTIVE_SELL', 'REVERSAL_UNKNOWN', 'DAILY_CLOSED');

-- CreateEnum
CREATE TYPE "XauusdSarDirection" AS ENUM ('BUY', 'SELL');

-- CreateTable
CREATE TABLE "xauusd_sar_sessions" (
    "account_id" TEXT NOT NULL,
    "spec_hash" TEXT NOT NULL,
    "session_date" TEXT NOT NULL,
    "state" "XauusdSarState" NOT NULL,
    "session_reference" DECIMAL(18,6),
    "initial_buy_trigger" DECIMAL(18,6),
    "initial_sell_trigger" DECIMAL(18,6),
    "reference_captured_at" TIMESTAMP(3),
    "reference_quote_evidence" JSONB,
    "cycle_id" TEXT,
    "direction" "XauusdSarDirection",
    "entry_fill_price" DECIMAL(18,6),
    "extreme_since_entry" DECIMAL(18,6),
    "reversal_level" DECIMAL(18,6),
    "broker_ticket" TEXT,
    "unknown_since" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "xauusd_sar_sessions_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "xauusd_sar_cycles" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "direction" "XauusdSarDirection" NOT NULL,
    "entry_ticket" TEXT NOT NULL,
    "entry_fill_price" DECIMAL(18,6) NOT NULL,
    "entry_at" TIMESTAMP(3) NOT NULL,
    "exit_ticket" TEXT,
    "exit_fill_price" DECIMAL(18,6),
    "exit_at" TIMESTAMP(3),
    "exit_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xauusd_sar_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "xauusd_sar_order_attempts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "idempotency_tag" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "direction" "XauusdSarDirection" NOT NULL,
    "volume" DECIMAL(18,6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "ticket" TEXT,
    "fill_price" DECIMAL(18,6),
    "failure_reason" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "xauusd_sar_order_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "xauusd_sar_volume_settings" (
    "account_id" TEXT NOT NULL,
    "volume_lots" DECIMAL(18,6) NOT NULL,
    "source" TEXT NOT NULL,
    "provenance" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "xauusd_sar_volume_settings_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "xauusd_sar_volume_audits" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "previous_lots" DECIMAL(18,6),
    "new_lots" DECIMAL(18,6) NOT NULL,
    "source" TEXT NOT NULL,
    "provenance" TEXT NOT NULL,
    "changed_by" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xauusd_sar_volume_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "xauusd_sar_cycles_cycle_id_key" ON "xauusd_sar_cycles"("cycle_id");

-- CreateIndex
CREATE INDEX "xauusd_sar_cycles_account_id_entry_at_idx" ON "xauusd_sar_cycles"("account_id", "entry_at");

-- CreateIndex
CREATE UNIQUE INDEX "xauusd_sar_order_attempts_idempotency_tag_key" ON "xauusd_sar_order_attempts"("idempotency_tag");

-- CreateIndex
CREATE INDEX "xauusd_sar_order_attempts_account_id_status_idx" ON "xauusd_sar_order_attempts"("account_id", "status");

-- CreateIndex
CREATE INDEX "xauusd_sar_volume_audits_account_id_changed_at_idx" ON "xauusd_sar_volume_audits"("account_id", "changed_at");

-- AddForeignKey
ALTER TABLE "xauusd_sar_sessions" ADD CONSTRAINT "xauusd_sar_sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xauusd_sar_cycles" ADD CONSTRAINT "xauusd_sar_cycles_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xauusd_sar_order_attempts" ADD CONSTRAINT "xauusd_sar_order_attempts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xauusd_sar_volume_settings" ADD CONSTRAINT "xauusd_sar_volume_settings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xauusd_sar_volume_audits" ADD CONSTRAINT "xauusd_sar_volume_audits_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
