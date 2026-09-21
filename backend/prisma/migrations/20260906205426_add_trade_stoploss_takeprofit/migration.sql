-- AlterTable
ALTER TABLE "trades" ADD COLUMN     "stop_loss" DECIMAL(18,6),
ADD COLUMN     "take_profit" DECIMAL(18,6);
