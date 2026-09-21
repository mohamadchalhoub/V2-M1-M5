/**
 * Absolute, non-negotiable safety bounds for the gold (XAUUSD) strategy —
 * hardcoded compile-time constants, deliberately NOT `.env` config, same
 * posture as `autonomous/safety-constants.ts` for EURUSD (§1 of that
 * module's own plan: these must never be something a config value could
 * edit). This is a SEPARATE constants file, not a shared one, specifically
 * so gold's magic number/volume can never accidentally collide with or be
 * edited alongside EURUSD's — the two strategies stay fully independent.
 */
export const GOLD_SYMBOL = 'XAUUSD';

/** User-controlled fixed volume per the friend-rules doc — only the user changes this. */
export const GOLD_VOLUME_LOTS = 0.01;

/**
 * Distinct from `autonomous/safety-constants.ts`'s AUTONOMOUS_MAGIC_NUMBER
 * (262610180, EURUSD-only) — deliberately a different arbitrary constant so
 * `find_open_position(magic, symbol)` in collector/app/executor.py can never
 * conflate a gold position with a EURUSD one, and so an accidental EURUSD
 * code-path reuse would immediately fail any magic-number-based check
 * rather than silently operate on the wrong strategy's position.
 */
export const GOLD_MAGIC_NUMBER = 262610181;

/**
 * XAUUSD price-increment size at this broker: 2 decimal digits, so
 * point = 0.01 (see confirmed-retest-v2/spec.ts's own comment: "XAUUSD:
 * digits=2, point=0.01, so 1 unit = $0.01 = one cent"). Verified against
 * the same broker contract metadata source the research modules use —
 * not re-derived independently here to avoid two sources of truth.
 */
export const GOLD_POINT_SIZE = 0.01;

/** Friend's rule: TP/SL are each a $10 price movement — expressed in points using GOLD_POINT_SIZE. */
export const GOLD_TP_SL_USD = 10;
export const GOLD_TP_SL_POINTS = GOLD_TP_SL_USD / GOLD_POINT_SIZE; // 1000 points

/** Same tolerance convention as EURUSD's SL_TP_TOLERANCE_POINTS, scaled for gold's coarser point size. */
export const GOLD_SL_TP_TOLERANCE_POINTS = 1;

/**
 * Frozen conservative default max entry deviation, in gold points, applied
 * between signal time and send time (task step 6D). No pre-existing
 * gold-specific executor limit was found in this codebase (only EURUSD's
 * `deviation_points: int = 20` default in collector/app/executor.py, which
 * is broker-slippage deviation at send time, not a signal-to-send guard).
 * 200 points = $2.00 — a delegated, documented conservative choice, roughly
 * 20% of the $10 TP/SL distance; if the executable price has moved beyond
 * this since the signal was formed, the coordinator must skip, never chase.
 */
export const GOLD_MAX_ENTRY_DEVIATION_POINTS = 200;

/**
 * Max age, in seconds, between when a first-touch M1 candle CLOSED
 * (`FirstReturnEvent.touchEndT`, i.e. the earliest instant the touch was
 * even knowable) and when the coordinator actually evaluates the signal for
 * submission. Distinct from `GOLD_MAX_ENTRY_DEVIATION_POINTS` (a price-drift
 * proxy): a ranging market can leave price within the deviation tolerance
 * for much longer than a touch should be allowed to sit unacted-on, e.g.
 * after the collector or candle-sync was stalled and resumes with a backlog
 * of same-day, in-window, never-acted-on events. 600s (10 minutes) is a
 * conservative multiple of the normal pipeline latency (candle-sync interval
 * up to 300s + one scheduler cycle up to 60s ~= 360s worst case in healthy
 * operation) — enough headroom for jitter, not enough to let a genuinely
 * stale touch pass as if it just happened. NOTE: since live-quote detection
 * (`gold-live-touch.ts`) is now the PRIMARY detection path — per the
 * friend's actual rule (first touch as it happens, not "wait for an M1
 * candle to close") — a live-detected signal's age at evaluation is
 * normally near-zero; this constant now mainly backstops the SLOWER,
 * secondary M1-replay path (still needed for anything the live layer's
 * latest-tick-only sampling misses, and for level FORMATION, which is
 * untouched and stays M1/H4/D1-based).
 */
export const GOLD_MAX_SIGNAL_AGE_SECONDS = 600;

/**
 * A `LiveTick` row older than this (vs. the moment it is read) is treated as
 * unavailable for live first-touch detection — never used to declare a
 * touch just happened when the quote itself might not be current. The
 * collector pushes a fresh tick roughly every `POLL_INTERVAL_SECONDS`
 * (10s in this deployment's `collector/.env`); 30s gives headroom for
 * normal jitter without allowing a genuinely stale quote through.
 */
export const GOLD_LIVE_TICK_MAX_STALENESS_SECONDS = 30;

/**
 * The largest gap, in seconds, between two consecutive live-quote
 * observations of the SAME level that this module will still compare
 * directly to detect a crossing. A larger gap (a missed cycle, a stall, a
 * restart) means this module cannot honestly claim to know what happened
 * to price during that gap, so it re-baselines instead of guessing,
 * deferring to the M1 replay layer (which has the actual historical bars
 * for that period) to determine whether — and when — a touch really
 * happened. Set well above the scheduler's own default cycle interval
 * (60s) so one merely-slow cycle doesn't trip it, but well below
 * `GOLD_MAX_SIGNAL_AGE_SECONDS` so a genuine multi-minute stall is caught
 * here rather than silently producing a slightly-stale live signal.
 */
export const GOLD_LIVE_OBSERVATION_MAX_GAP_SECONDS = 150;

/** Risk caps carried over unweakened from confirmed-retest-v2's paper-simulation assumptions. */
export const GOLD_STOP_RISK_CAP_PCT = 0.5;
export const GOLD_COMBINED_RISK_CAP_PCT = 1;
export const GOLD_DAILY_LOSS_CAP_PCT = 2;
export const GOLD_DRAWDOWN_CAP_PCT = 5;
