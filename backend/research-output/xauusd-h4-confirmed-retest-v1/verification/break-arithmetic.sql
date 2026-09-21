-- Verification pass: daily XAUUSD break boundaries in STORED (raw MT5) time,
-- one Tue-Thu sample per DST regime. Read-only.
WITH m AS (
  SELECT open_time t, lag(open_time) OVER (ORDER BY open_time) p
  FROM historical_candles
  WHERE symbol = 'XAUUSD' AND timeframe = 'M1' AND extract(dow FROM open_time) BETWEEN 2 AND 4
)
SELECT p::date AS session_date,
       to_char(p + interval '1 minute', 'HH24:MI') AS stored_break_start,
       to_char(t, 'HH24:MI') AS stored_reopen,
       extract(epoch FROM t - p) / 60 - 1 AS missing_minutes
FROM m
WHERE p::date IN ('2024-03-13','2024-07-17','2024-10-16','2024-10-30','2024-11-06','2024-12-18','2025-01-15','2025-03-19','2025-07-16','2025-10-29','2025-11-05')
  AND t - p > interval '30 minutes'
ORDER BY p;
