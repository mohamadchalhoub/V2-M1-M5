-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RuleType" ADD VALUE 'SUPPORT_RESISTANCE_PROXIMITY';
ALTER TYPE "RuleType" ADD VALUE 'ICHIMOKU_BREAKOUT';
ALTER TYPE "RuleType" ADD VALUE 'DAILY_MARKET_ANALYSIS';
