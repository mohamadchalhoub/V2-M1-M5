-- CreateEnum
CREATE TYPE "TrendBreakoutInstrument" AS ENUM ('EURUSD', 'XAUUSD');

-- CreateEnum
CREATE TYPE "TrendBreakoutSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "TrendBreakoutSlotState" AS ENUM ('PENDING', 'OPEN', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TrendBreakoutIncidentKind" AS ENUM ('MISSING_STOP_LOSS');

-- CreateEnum
CREATE TYPE "TrendBreakoutIncidentStatus" AS ENUM ('OPEN', 'MITIGATED', 'UNRESOLVED');

-- CreateTable
CREATE TABLE "trend_breakout_volume_settings" (
    "instrument" "TrendBreakoutInstrument" NOT NULL,
    "volumeLots" DECIMAL(10,2) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "trend_breakout_volume_settings_pkey" PRIMARY KEY ("instrument")
);

-- CreateTable
CREATE TABLE "trend_breakout_volume_audits" (
    "id" TEXT NOT NULL,
    "instrument" "TrendBreakoutInstrument" NOT NULL,
    "oldVolume" DECIMAL(10,2),
    "newVolume" DECIMAL(10,2) NOT NULL,
    "new_version" INTEGER NOT NULL,
    "changed_by" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trend_breakout_volume_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "symbol_metadata" (
    "symbol" TEXT NOT NULL,
    "volume_min" DECIMAL(10,4) NOT NULL,
    "volume_max" DECIMAL(10,2) NOT NULL,
    "volume_step" DECIMAL(10,4) NOT NULL,
    "digits" INTEGER NOT NULL,
    "point" DECIMAL(18,8) NOT NULL,
    "contract_size" DECIMAL(18,4) NOT NULL,
    "profit_currency" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MT5',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "symbol_metadata_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "trend_breakout_risk_policies" (
    "version" SERIAL NOT NULL,
    "max_trade_risk_pct" DECIMAL(6,4) NOT NULL,
    "max_combined_risk_pct" DECIMAL(6,4) NOT NULL,
    "daily_loss_pct" DECIMAL(6,4) NOT NULL,
    "drawdown_pct" DECIMAL(6,4) NOT NULL,
    "max_spread_pct_of_d" DECIMAL(6,4) NOT NULL,
    "max_quote_age_seconds" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "trend_breakout_risk_policies_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "trend_breakout_risk_states" (
    "account_id" TEXT NOT NULL,
    "beirut_date" TEXT NOT NULL,
    "daily_baseline_equity" DECIMAL(18,2) NOT NULL,
    "daily_net_cash_flow" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "daily_loss_triggered" BOOLEAN NOT NULL DEFAULT false,
    "cash_flow_adjusted_high" DECIMAL(18,2) NOT NULL,
    "drawdown_triggered" BOOLEAN NOT NULL DEFAULT false,
    "drawdown_triggered_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trend_breakout_risk_states_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "trend_breakout_slot_locks" (
    "account_id" TEXT NOT NULL,
    "instrument" "TrendBreakoutInstrument" NOT NULL,
    "state" "TrendBreakoutSlotState" NOT NULL,
    "decision_id" TEXT NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trend_breakout_slot_locks_pkey" PRIMARY KEY ("account_id","instrument")
);

-- CreateTable
CREATE TABLE "trend_breakout_decisions" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "strategy_version" TEXT NOT NULL,
    "instrument" "TrendBreakoutInstrument" NOT NULL,
    "signal_close_at" TIMESTAMP(3) NOT NULL,
    "decision_at_utc" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decision_at_beirut" TEXT NOT NULL,
    "action" "AutonomousDecisionAction" NOT NULL DEFAULT 'HOLD',
    "h4_close" DECIMAL(18,6),
    "h4_ema50" DECIMAL(18,6),
    "h4_ema200" DECIMAL(18,6),
    "h1_range_high" DECIMAL(18,6),
    "h1_range_low" DECIMAL(18,6),
    "h1_signal_close" DECIMAL(18,6),
    "h1_signal_high" DECIMAL(18,6),
    "h1_signal_low" DECIMAL(18,6),
    "atr14" DECIMAL(18,6),
    "bid" DECIMAL(18,6),
    "ask" DECIMAL(18,6),
    "spread_points" DECIMAL(10,2),
    "quote_at" TIMESTAMP(3),
    "volume_used" DECIMAL(10,2),
    "volume_config_version" INTEGER,
    "risk_policy_version" INTEGER,
    "estimated_stop_risk_amount" DECIMAL(18,2),
    "estimated_stop_risk_ccy" TEXT,
    "intended_entry_price" DECIMAL(18,6),
    "intended_stop_loss" DECIMAL(18,6),
    "intended_take_profit" DECIMAL(18,6),
    "actual_fill_price" DECIMAL(18,6),
    "actual_stop_loss" DECIMAL(18,6),
    "actual_take_profit" DECIMAL(18,6),
    "sl_confirmed" BOOLEAN,
    "gate_results" JSONB NOT NULL,
    "rejection_reason" TEXT,
    "broker_request_id" TEXT,
    "broker_order_id" TEXT,
    "broker_position_id" TEXT,
    "order_status" "AutonomousOrderStatus" NOT NULL DEFAULT 'NONE',
    "reconciliation_state" TEXT,
    "closed_at" TIMESTAMP(3),
    "close_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trend_breakout_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trend_breakout_emergency_incidents" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "instrument" "TrendBreakoutInstrument" NOT NULL,
    "decision_id" TEXT,
    "kind" "TrendBreakoutIncidentKind" NOT NULL,
    "status" "TrendBreakoutIncidentStatus" NOT NULL DEFAULT 'OPEN',
    "detail" JSONB NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "trend_breakout_emergency_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trend_breakout_volume_audits_instrument_changed_at_idx" ON "trend_breakout_volume_audits"("instrument", "changed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "trend_breakout_slot_locks_decision_id_key" ON "trend_breakout_slot_locks"("decision_id");

-- CreateIndex
CREATE INDEX "trend_breakout_decisions_account_id_instrument_decision_at__idx" ON "trend_breakout_decisions"("account_id", "instrument", "decision_at_utc" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "trend_breakout_decisions_account_id_strategy_version_instru_key" ON "trend_breakout_decisions"("account_id", "strategy_version", "instrument", "signal_close_at");

-- CreateIndex
CREATE INDEX "trend_breakout_emergency_incidents_account_id_status_idx" ON "trend_breakout_emergency_incidents"("account_id", "status");

-- AddForeignKey
ALTER TABLE "trend_breakout_slot_locks" ADD CONSTRAINT "trend_breakout_slot_locks_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "trend_breakout_decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
