-- The execution timeline for xauusd-m1-m5-rsi-threshold-v2: four separate
-- instants, so our scheduling delay and the broker's latency can be told apart.
-- Nullable: rows written before this existed have no timeline, and inventing
-- one retroactively would be a fabricated measurement.

-- AlterTable
ALTER TABLE "xauusd_m1m5_decisions" ADD COLUMN "detected_at" TIMESTAMP(3),
ADD COLUMN "execution_evaluated_at" TIMESTAMP(3),
ADD COLUMN "submitted_at" TIMESTAMP(3),
ADD COLUMN "acknowledged_at" TIMESTAMP(3);
