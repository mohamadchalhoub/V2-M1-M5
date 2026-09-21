-- Verification pass (2026-09-15): independent recount of the v1 formation
-- inputs, written without reference to the TypeScript engine. Read-only.
-- Same bar set as the frozen run: stored XAUUSD H4 rows with a CLOSE at or
-- before the frozen endpoint (last stored M1 bar close = server 2026-09-11 23:00,
-- so H4 bars opening before server 2026-09-11 20:00). Prices are compared as the
-- stored NUMERIC values — no rounding, no cent assumption.
\pset footer off
\echo '== bar set =='
WITH h4 AS (
  SELECT row_number() OVER (ORDER BY open_time) - 1 AS idx, open_time, open, high, low, close
  FROM historical_candles
  WHERE symbol = 'XAUUSD' AND timeframe = 'H4' AND open_time < '2026-09-11 20:00'
)
SELECT count(*) AS h4_bars, min(open_time) AS first_server, max(open_time) AS last_server FROM h4;

\echo '== price precision: stored values that are not multiples of symbol_metadata.trade_tick_size =='
SELECT m.digits, m.point, m.trade_tick_size,
       count(*) FILTER (WHERE mod(c.high, m.trade_tick_size) <> 0 OR mod(c.low, m.trade_tick_size) <> 0
                           OR mod(c.open, m.trade_tick_size) <> 0 OR mod(c.close, m.trade_tick_size) <> 0) AS h4_rows_off_tick_grid,
       count(*) AS h4_rows
FROM historical_candles c JOIN symbol_metadata m ON m.symbol = c.symbol
WHERE c.symbol = 'XAUUSD' AND c.timeframe = 'H4'
GROUP BY m.digits, m.point, m.trade_tick_size;

CREATE TEMP VIEW h4 AS
  SELECT row_number() OVER (ORDER BY open_time) - 1 AS idx, open_time, open, high, low, close
  FROM historical_candles
  WHERE symbol = 'XAUUSD' AND timeframe = 'H4' AND open_time < '2026-09-11 20:00';

-- Strict 2-left/2-right pivots with both neighbours present; qualification =
-- one of the two following closes at least $10 away in the rejection direction.
CREATE TEMP VIEW pivots AS
  WITH w AS (
    SELECT idx, open_time, high, low,
           lag(high, 1) OVER o AS lh1, lag(high, 2) OVER o AS lh2, lead(high, 1) OVER o AS rh1, lead(high, 2) OVER o AS rh2,
           lag(low, 1) OVER o AS ll1, lag(low, 2) OVER o AS ll2, lead(low, 1) OVER o AS rl1, lead(low, 2) OVER o AS rl2,
           lead(close, 1) OVER o AS rc1, lead(close, 2) OVER o AS rc2
    FROM h4 WINDOW o AS (ORDER BY idx)
  )
  SELECT idx, open_time, 'RESISTANCE' AS role, high AS price, (rc1 <= high - 10 OR rc2 <= high - 10) AS qualified
  FROM w WHERE lh2 IS NOT NULL AND rh2 IS NOT NULL AND high > lh1 AND high > lh2 AND high > rh1 AND high > rh2
  UNION ALL
  SELECT idx, open_time, 'SUPPORT', low, (rc1 >= low + 10 OR rc2 >= low + 10)
  FROM w WHERE ll2 IS NOT NULL AND rl2 IS NOT NULL AND low < ll1 AND low < ll2 AND low < rl1 AND low < rl2;

\echo '== pivot and rejection counts =='
SELECT role, count(*) AS candidates, count(*) FILTER (WHERE qualified) AS qualified,
       count(*) FILTER (WHERE NOT qualified) AS rejected_no_10usd_close
FROM pivots GROUP BY role ORDER BY role;

\echo '== every same-role pair with EXACTLY equal stored price, any distance =='
SELECT a.role, a.price, a.idx AS first_h4_index, a.open_time AS first_pivot_server_time,
       b.idx AS second_h4_index, b.open_time AS second_pivot_server_time,
       b.idx - a.idx AS h4_index_separation, a.qualified AS first_qualified, b.qualified AS second_qualified
FROM pivots a JOIN pivots b ON a.role = b.role AND a.price = b.price AND a.idx < b.idx
ORDER BY a.open_time;

\echo '== same-role pairs whose index separation is within 5..120 (this is the ~25,000 population), by exact stored price difference =='
SELECT a.role,
       count(*) AS pairs_in_5_120_window,
       count(*) FILTER (WHERE a.qualified AND b.qualified) AS both_qualified,
       count(*) FILTER (WHERE a.price = b.price) AS exact_equal,
       count(*) FILTER (WHERE abs(a.price - b.price) > 0 AND abs(a.price - b.price) <= 0.05) AS diff_1_to_5_ticks,
       count(*) FILTER (WHERE abs(a.price - b.price) > 0.05 AND abs(a.price - b.price) <= 0.10) AS diff_6_to_10_ticks,
       count(*) FILTER (WHERE a.qualified AND b.qualified AND abs(a.price - b.price) <= 0.10) AS both_qualified_within_10_ticks
FROM pivots a JOIN pivots b ON a.role = b.role AND b.idx - a.idx BETWEEN 5 AND 120
GROUP BY a.role ORDER BY a.role;
