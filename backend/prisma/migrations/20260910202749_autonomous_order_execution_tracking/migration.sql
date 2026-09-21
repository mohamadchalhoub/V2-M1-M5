-- CreateEnum
CREATE TYPE "AutonomousOrderStatus" AS ENUM ('NONE', 'PENDING', 'SENT', 'FILLED', 'FAILED');

-- AlterTable
ALTER TABLE "autonomous_decisions" ADD COLUMN     "account_id" TEXT,
ADD COLUMN     "execution_error" TEXT,
ADD COLUMN     "filled_at" TIMESTAMP(3),
ADD COLUMN     "filled_price" DECIMAL(18,6),
ADD COLUMN     "mt5_ticket" INTEGER,
ADD COLUMN     "order_status" "AutonomousOrderStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "risk_manager_approved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "risk_manager_rejection_reason" TEXT;

-- CreateIndex
CREATE INDEX "autonomous_decisions_account_id_order_status_idx" ON "autonomous_decisions"("account_id", "order_status");

-- AddForeignKey
ALTER TABLE "autonomous_decisions" ADD CONSTRAINT "autonomous_decisions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
