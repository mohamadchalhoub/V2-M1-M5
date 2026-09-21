-- CreateEnum
CREATE TYPE "AccountMarginMode" AS ENUM ('RETAIL_NETTING', 'EXCHANGE', 'RETAIL_HEDGING');

-- AlterTable
ALTER TABLE "account_snapshots" ADD COLUMN     "margin_mode" "AccountMarginMode";
