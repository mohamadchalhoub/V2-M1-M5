-- Let a failed Telegram notification be retried instead of lost.
--
-- A send that failed was written FAILED and never looked at again, so a
-- transient network problem permanently lost the alert. Observed live on
-- 2026-09-21: every trade notification for two round trips failed with
-- "network error calling Telegram: fetch failed" while api.telegram.org was
-- unreachable from the host, and none was ever delivered afterwards.
--
-- Additive only; existing rows keep their history and start at zero attempts.
ALTER TABLE "gold_telegram_notifications"
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_attempt_at" TIMESTAMP(3);
