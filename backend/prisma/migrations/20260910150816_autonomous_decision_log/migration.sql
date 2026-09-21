-- CreateEnum
CREATE TYPE "AutonomousDecisionAction" AS ENUM ('OPEN_BUY', 'OPEN_SELL', 'HOLD');

-- CreateEnum
CREATE TYPE "AutonomousDecisionSource" AS ENUM ('RULES_ONLY');

-- CreateEnum
CREATE TYPE "AutonomousLevelType" AS ENUM ('SUPPORT', 'RESISTANCE');

-- CreateTable
CREATE TABLE "autonomous_decisions" (
    "id" TEXT NOT NULL,
    "evaluated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbol" TEXT NOT NULL DEFAULT 'EURUSD',
    "action" "AutonomousDecisionAction" NOT NULL,
    "source" "AutonomousDecisionSource" NOT NULL DEFAULT 'RULES_ONLY',
    "entry_price" DECIMAL(18,6),
    "stop_loss" DECIMAL(18,6),
    "take_profit" DECIMAL(18,6),
    "level_used" "AutonomousLevelType",
    "reference_week_start" TIMESTAMP(3),
    "reasoning" TEXT NOT NULL,
    "input_snapshot" JSONB NOT NULL,

    CONSTRAINT "autonomous_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "autonomous_decisions_evaluated_at_idx" ON "autonomous_decisions"("evaluated_at" DESC);
