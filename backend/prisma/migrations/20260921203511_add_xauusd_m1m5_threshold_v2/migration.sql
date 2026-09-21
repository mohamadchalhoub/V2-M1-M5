-- CreateEnum
CREATE TYPE "XauusdM1M5Timeframe" AS ENUM ('M1', 'M5');

-- CreateEnum
CREATE TYPE "XauusdM1M5Direction" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "XauusdM1M5OrderStatus" AS ENUM ('NONE', 'PENDING', 'SENT', 'FILLED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "XauusdM1M5SlotState" AS ENUM ('PENDING', 'SENT', 'FILLED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "xauusd_m1m5_decisions" (
    "id" TEXT NOT NULL,
    "strategy_version" TEXT NOT NULL,
    "spec_hash" TEXT NOT NULL,
    "account_id" TEXT,
    "symbol" TEXT NOT NULL DEFAULT 'XAUUSD',
    "timeframe" "XauusdM1M5Timeframe" NOT NULL,
    "direction" "XauusdM1M5Direction" NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "evaluated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event_id" TEXT NOT NULL,
    "rsi_value" DECIMAL(12,8) NOT NULL,
    "previous_rsi" DECIMAL(12,8),
    "threshold" DECIMAL(12,8) NOT NULL,
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
    "order_status" "XauusdM1M5OrderStatus" NOT NULL DEFAULT 'NONE',
    "magic_number" INTEGER,
    "ticket" BIGINT,
    "position_id" TEXT,
    "sent_at" TIMESTAMP(3),
    "filled_at" TIMESTAMP(3),
    "fill_price" DECIMAL(18,6),
    "broker_stop_loss" DECIMAL(18,6),
    "broker_take_profit" DECIMAL(18,6),
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "xauusd_m1m5_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "xauusd_m1m5_slot_locks" (
    "account_id" TEXT NOT NULL,
    "timeframe" "XauusdM1M5Timeframe" NOT NULL,
    "state" "XauusdM1M5SlotState" NOT NULL,
    "decision_id" TEXT NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "xauusd_m1m5_slot_locks_pkey" PRIMARY KEY ("account_id","timeframe")
);

-- CreateTable
CREATE TABLE "xauusd_m1m5_directional_locks" (
    "account_id" TEXT NOT NULL,
    "timeframe" "XauusdM1M5Timeframe" NOT NULL,
    "direction" "XauusdM1M5Direction" NOT NULL,
    "strategy_version" TEXT NOT NULL,
    "spec_hash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "losing_position_id" TEXT,
    "losing_closure_event_id" TEXT,
    "net_realized" DECIMAL(18,6),
    "closed_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "rsi_at_activation" DECIMAL(12,8),
    "unlock_condition" TEXT,
    "unlock_threshold" DECIMAL(12,8),
    "unlock_rsi" DECIMAL(12,8),
    "unlocked_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "xauusd_m1m5_directional_locks_pkey" PRIMARY KEY ("account_id","timeframe","direction")
);

-- CreateTable
CREATE TABLE "xauusd_m1m5_processed_closures" (
    "account_id" TEXT NOT NULL,
    "closure_event_id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "classification" TEXT NOT NULL,

    CONSTRAINT "xauusd_m1m5_processed_closures_pkey" PRIMARY KEY ("account_id","closure_event_id")
);

-- CreateTable
CREATE TABLE "xauusd_m1m5_report_periods" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "start_t" TIMESTAMP(3) NOT NULL,
    "end_t" TIMESTAMP(3) NOT NULL,
    "m1_wins" INTEGER NOT NULL DEFAULT 0,
    "m1_losses" INTEGER NOT NULL DEFAULT 0,
    "m5_wins" INTEGER NOT NULL DEFAULT 0,
    "m5_losses" INTEGER NOT NULL DEFAULT 0,
    "zero_results" INTEGER NOT NULL DEFAULT 0,
    "unresolved" INTEGER NOT NULL DEFAULT 0,
    "net_realized" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "included_position_ids" TEXT[],
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    "delivery_error" TEXT,

    CONSTRAINT "xauusd_m1m5_report_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "xauusd_m1m5_volume_settings" (
    "account_id" TEXT NOT NULL,
    "volume_lots" DECIMAL(18,6) NOT NULL,
    "source" TEXT NOT NULL,
    "provenance" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "xauusd_m1m5_volume_settings_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "xauusd_m1m5_volume_audits" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "previous_lots" DECIMAL(18,6),
    "new_lots" DECIMAL(18,6) NOT NULL,
    "source" TEXT NOT NULL,
    "provenance" TEXT NOT NULL,
    "changed_by" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xauusd_m1m5_volume_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "xauusd_m1m5_decisions_account_id_timeframe_order_status_idx" ON "xauusd_m1m5_decisions"("account_id", "timeframe", "order_status");

-- CreateIndex
CREATE INDEX "xauusd_m1m5_decisions_account_id_observed_at_idx" ON "xauusd_m1m5_decisions"("account_id", "observed_at");

-- CreateIndex
CREATE UNIQUE INDEX "xauusd_m1m5_decisions_account_id_strategy_version_event_id_key" ON "xauusd_m1m5_decisions"("account_id", "strategy_version", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "xauusd_m1m5_slot_locks_decision_id_key" ON "xauusd_m1m5_slot_locks"("decision_id");

-- CreateIndex
CREATE INDEX "xauusd_m1m5_processed_closures_account_id_position_id_idx" ON "xauusd_m1m5_processed_closures"("account_id", "position_id");

-- CreateIndex
CREATE INDEX "xauusd_m1m5_report_periods_account_id_end_t_idx" ON "xauusd_m1m5_report_periods"("account_id", "end_t");

-- CreateIndex
CREATE UNIQUE INDEX "xauusd_m1m5_report_periods_account_id_start_t_key" ON "xauusd_m1m5_report_periods"("account_id", "start_t");

-- CreateIndex
CREATE INDEX "xauusd_m1m5_volume_audits_account_id_changed_at_idx" ON "xauusd_m1m5_volume_audits"("account_id", "changed_at");

-- AddForeignKey
ALTER TABLE "xauusd_m1m5_decisions" ADD CONSTRAINT "xauusd_m1m5_decisions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xauusd_m1m5_slot_locks" ADD CONSTRAINT "xauusd_m1m5_slot_locks_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "xauusd_m1m5_decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xauusd_m1m5_slot_locks" ADD CONSTRAINT "xauusd_m1m5_slot_locks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xauusd_m1m5_directional_locks" ADD CONSTRAINT "xauusd_m1m5_directional_locks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xauusd_m1m5_report_periods" ADD CONSTRAINT "xauusd_m1m5_report_periods_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xauusd_m1m5_volume_settings" ADD CONSTRAINT "xauusd_m1m5_volume_settings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xauusd_m1m5_volume_audits" ADD CONSTRAINT "xauusd_m1m5_volume_audits_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
