-- The restatement key: direction + entry + stop, deliberately WITHOUT the
-- target list.
--
-- A 100-message scan of the source channel showed it republishing each signal
-- within seconds, sometimes identically and sometimes with the targets varied
-- (one dollar moved, or a second target added). Three of five bursts contained
-- such a variant. Those are not equal by `semantic_key` -- a different target
-- list is a different fingerprint -- so the existing check let them through,
-- and only signal-group occupancy stood between a repost and a second trade.
--
-- Nullable: rows written before this existed have no key, and the duplicate
-- check treats a null as "cannot compare" rather than as a match.
--
-- Additive only. Nothing belonging to the RSI engine is touched.

-- AlterTable
ALTER TABLE "telegram_signals" ADD COLUMN "restatement_key" TEXT;

-- CreateIndex
CREATE INDEX "telegram_signals_account_id_restatement_key_published_at_idx" ON "telegram_signals"("account_id", "restatement_key", "published_at");
