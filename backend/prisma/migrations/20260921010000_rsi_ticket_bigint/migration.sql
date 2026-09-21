-- MT5 position tickets outgrew INT4.
--
-- Observed live on 2026-09-21: the broker returned ticket 58537207521 for a
-- real filled XAUUSD position. Writing it failed with "Unable to fit integer
-- value '58537207521' into an INT4 (32-bit signed integer)", so the fill was
-- never recorded, the decision stayed SENT, and its rule-family slot was
-- never released - blocking every further entry in that family.
--
-- Widening only. INT4 values fit in INT8 unchanged, so no stored ticket is
-- altered and nothing is rewritten.
ALTER TABLE "xauusd_rsi_decisions"
  ALTER COLUMN "mt5_ticket" TYPE BIGINT;
