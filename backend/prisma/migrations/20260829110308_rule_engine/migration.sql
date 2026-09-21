-- CreateEnum
CREATE TYPE "RuleType" AS ENUM ('DAILY_LOSS_LIMIT', 'DRAWDOWN', 'CONSECUTIVE_LOSSES', 'POSITION_SIZE_MULTIPLE', 'TRADE_FREQUENCY_MULTIPLE', 'COMPOUND');

-- CreateEnum
CREATE TYPE "RuleRunState" AS ENUM ('INACTIVE', 'ACTIVE');

-- CreateTable
CREATE TABLE "rule_definitions" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rule_type" "RuleType" NOT NULL,
    "parameters" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cooldown_seconds" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rule_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_states" (
    "rule_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "state" "RuleRunState" NOT NULL DEFAULT 'INACTIVE',
    "cooldown_until" TIMESTAMP(3),
    "last_triggered_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rule_states_pkey" PRIMARY KEY ("rule_id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "triggered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trigger_values" JSONB NOT NULL,
    "baseline_snapshot" JSONB NOT NULL,
    "rule_snapshot" JSONB NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rule_definitions_account_id_enabled_idx" ON "rule_definitions"("account_id", "enabled");

-- CreateIndex
CREATE INDEX "alerts_account_id_triggered_at_idx" ON "alerts"("account_id", "triggered_at" DESC);

-- AddForeignKey
ALTER TABLE "rule_definitions" ADD CONSTRAINT "rule_definitions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_states" ADD CONSTRAINT "rule_states_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "rule_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_states" ADD CONSTRAINT "rule_states_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "rule_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
