-- Adds the collector's claim column to xauusd_sar_order_attempts, added
-- after the strategy's initial migration once the collector-facing poll
-- endpoint needed an atomic claim (mirrors telegram_signal_legs.claimed_at).
-- Additive only; nothing belonging to any other strategy is touched.

ALTER TABLE "xauusd_sar_order_attempts"
  ADD COLUMN "claimed_at" TIMESTAMP(3);
