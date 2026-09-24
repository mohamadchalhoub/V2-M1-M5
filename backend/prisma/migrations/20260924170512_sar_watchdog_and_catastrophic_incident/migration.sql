-- AlterTable
ALTER TABLE "xauusd_sar_sessions" ADD COLUMN     "last_evaluated_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "xauusd_sar_catastrophic_incidents" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "direction" "XauusdSarDirection" NOT NULL,
    "entry_ticket" TEXT NOT NULL,
    "entry_fill_price" DECIMAL(18,6) NOT NULL,
    "entry_at" TIMESTAMP(3) NOT NULL,
    "exit_fill_price" DECIMAL(18,6) NOT NULL,
    "exit_at" TIMESTAMP(3) NOT NULL,
    "last_known_extreme" DECIMAL(18,6),
    "last_known_reversal_level" DECIMAL(18,6),
    "last_evaluated_at" TIMESTAMP(3),
    "threshold_was_previously_crossed" BOOLEAN NOT NULL,
    "adverse_distance_usd" DECIMAL(18,6) NOT NULL,
    "volume_lots" DECIMAL(18,6),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xauusd_sar_catastrophic_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "xauusd_sar_catastrophic_incidents_account_id_created_at_idx" ON "xauusd_sar_catastrophic_incidents"("account_id", "created_at");

-- AddForeignKey
ALTER TABLE "xauusd_sar_catastrophic_incidents" ADD CONSTRAINT "xauusd_sar_catastrophic_incidents_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
