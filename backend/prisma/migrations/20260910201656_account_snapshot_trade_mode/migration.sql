-- CreateEnum
CREATE TYPE "AccountTradeMode" AS ENUM ('REAL', 'DEMO', 'CONTEST');

-- AlterTable
ALTER TABLE "account_snapshots" ADD COLUMN     "trade_mode" "AccountTradeMode";
