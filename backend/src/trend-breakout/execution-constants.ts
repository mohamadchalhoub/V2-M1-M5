import { TrendBreakoutInstrumentId } from './instrument-config';

/**
 * Absolute, non-negotiable safety bounds for the trend-breakout execution
 * path — hardcoded compile-time constants for anything that must never be
 * something a config value could edit (magic numbers), same posture as
 * `../gold-execution/gold-safety-constants.ts` and
 * `../autonomous/safety-constants.ts`. Deliberately its OWN file, not
 * shared with gold's or the legacy EURUSD strategy's constants, so magic
 * numbers can never accidentally collide across strategies.
 *
 * Per-instrument, unlike gold's single-symbol constants file — this
 * strategy trades BOTH EURUSD and XAUUSD, and `find_open_position(magic,
 * symbol)` in collector/app/executor.py depends on every strategy/instrument
 * combination having its own distinct magic number so positions can never
 * be conflated across strategies OR across this strategy's own two
 * instruments.
 */
export const TREND_BREAKOUT_MAGIC_NUMBER: Record<TrendBreakoutInstrumentId, number> = {
  EURUSD: 262610190,
  XAUUSD: 262610191,
};

/**
 * Point size per instrument — EURUSD's 5th decimal (0.00001) vs XAUUSD's
 * 2nd decimal (0.01, same as gold-execution's own GOLD_POINT_SIZE) — used
 * ONLY as a last-resort fallback when live `SymbolMetadata.point` for that
 * instrument is unavailable. Every real gate elsewhere in this strategy
 * uses the broker-reported `metadata.point`, never this constant, per
 * `trend-breakout-coordinator.service.ts`'s own "symbol metadata is
 * REQUIRED, fail closed if absent" posture — this exists only for the
 * pre-send guard's points-conversion arithmetic, where a broker-reported
 * point size SHOULD already be known (the original decision could not have
 * been queued without it), so this fallback should in practice never be hit.
 */
export const TREND_BREAKOUT_FALLBACK_POINT_SIZE: Record<TrendBreakoutInstrumentId, number> = {
  EURUSD: 0.00001,
  XAUUSD: 0.01,
};

/**
 * Conservative default max entry deviation, in the instrument's own points,
 * applied between decision-queue time and pre-send time — same purpose as
 * gold's `GOLD_MAX_ENTRY_DEVIATION_POINTS` (task step 6D equivalent), but
 * per-instrument since EURUSD's and XAUUSD's point scales are wildly
 * different (a "200 points" tolerance is $2 for gold but ~$0.02 for a
 * standard EURUSD lot's pip-scale, so ONE constant across both would either
 * be far too loose for gold or far too tight for EURUSD). Overridable via
 * `TREND_BREAKOUT_MAX_ENTRY_DEVIATION_POINTS_EURUSD` /
 * `..._XAUUSD` — read fresh on every call, never cached at import time, same
 * posture as every other safety-relevant env read in this codebase.
 */
const DEFAULT_MAX_ENTRY_DEVIATION_POINTS: Record<TrendBreakoutInstrumentId, number> = {
  EURUSD: 50, // ~5 pips at 5-decimal quoting
  XAUUSD: 200, // $2.00, same conservative figure gold-execution itself uses
};

export function getMaxEntryDeviationPoints(instrument: TrendBreakoutInstrumentId): number {
  const envKey = `TREND_BREAKOUT_MAX_ENTRY_DEVIATION_POINTS_${instrument}`;
  const raw = process.env[envKey]?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_ENTRY_DEVIATION_POINTS[instrument];
}
