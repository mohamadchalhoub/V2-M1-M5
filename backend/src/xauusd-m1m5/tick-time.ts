/**
 * Converting a stored tick timestamp into true UTC.
 *
 * `historical_ticks.timestamp` does NOT hold true UTC. MT5 reports tick times
 * as an epoch built from the broker server's own wall clock, and the collector
 * stores it as-is, so the digits are broker-local (EET/EEST -- UTC+3 in
 * summer) wearing a UTC label. `live_ticks` is different: that path already
 * applies the correction on the way in.
 *
 * Measured on this deployment, not assumed: at 2026-09-22T08:05Z the newest
 * stored tick read `now() - max(timestamp) = -02:59:59` -- three hours in the
 * future -- while `live_ticks` read 23s old.
 *
 * Why it matters here specifically: the quote resolver rejects a quote dated
 * beyond a small future-skew tolerance. Uncorrected, every tick from the
 * one-second stream was three hours ahead and silently discarded, so the
 * strategy fell back to the ~10-second live tick and the one-second
 * observation its spec requires never actually happened.
 *
 * The previous strategy in this codebase found and fixed the identical problem
 * (`xauusd-rsi/tick-time.ts`). This is its own small wrapper over the SAME
 * conversion, `wallClockToUtc`, rather than an import from that retired
 * module: one conversion, DST handled once, never a second disagreeing one.
 */
import { wallClockToUtc } from '../research/confirmed-retest/time';

/**
 * The broker server's timezone. Must match the collector's
 * MT5_BROKER_TIMEZONE, which wrote these rows. EET covers both EET (+2) and
 * EEST (+3); `wallClockToUtc` resolves whichever applied on the date.
 */
export const V2_BROKER_SERVER_TIMEZONE = process.env.MT5_BROKER_TIMEZONE?.trim() || 'EET';

/**
 * One stored broker timestamp to true UTC ms.
 *
 * Null for a wall-clock time that does not exist or is ambiguous in the
 * broker's zone (the DST gap and overlap hours). Such a tick is dropped rather
 * than guessed at: gold does not trade in those Sunday hours, so one appearing
 * there is a data problem, not a price.
 */
export function storedBrokerTimeToUtcMs(storedMs: number, timeZone: string = V2_BROKER_SERVER_TIMEZONE): number | null {
  try {
    return wallClockToUtc(timeZone, storedMs);
  } catch {
    return null;
  }
}
