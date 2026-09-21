/**
 * The one place the XAUUSD RSI strategy converts a stored tick timestamp
 * into true UTC.
 *
 * `historical_ticks.timestamp` does NOT hold true UTC. MT5 reports tick
 * times as an epoch assembled from the broker server's own wall-clock
 * components, and the collector stores that value as-is, so the digits are
 * broker-local (EET/EEST — UTC+3 in summer) wearing a UTC label. This was
 * measured, not assumed: at 2026-09-20T23:16:00Z the newest stored XAUUSD
 * tick read 2026-09-21T02:15:58Z, exactly 3h ahead, while `live_ticks`
 * — the one path that already applies the broker-timezone correction —
 * read 4.4s old at the same instant.
 *
 * Leaving it uncorrected was not cosmetic. Observation timestamps landed
 * three hours in the FUTURE, which meant:
 *
 *   - the engine's staleness test (`now - atT <= 30s`) compared against a
 *     negative age and therefore passed unconditionally, so a genuinely
 *     stale tick could never be rejected;
 *   - `xauusd_rsi_decisions.observed_at` was persisted three hours ahead of
 *     the event, and the dashboard faithfully rendered 04:00 Beirut for a
 *     signal that happened at 01:00 Beirut.
 *
 * The correction is applied HERE, at the read boundary, rather than by
 * rewriting stored rows: the stored history stays exactly as recorded, and
 * nothing else reads these timestamps (the research layer only counts
 * them). It reuses `wallClockToUtc`, the conversion this repository already
 * uses for the same mislabeling in candle times, so the offset is resolved
 * once, with DST handled, and never guessed or applied twice.
 */
import { wallClockToUtc } from '../research/confirmed-retest/time';

/**
 * The broker server's timezone, as configured for the collector that wrote
 * these rows. EET carries both EET (+2) and EEST (+3); `wallClockToUtc`
 * resolves whichever applied on the date in question.
 */
export const RSI_BROKER_SERVER_TIMEZONE =
  process.env.MT5_BROKER_TIMEZONE?.trim() || 'EET';

/**
 * Identifies the timeline a persisted watch cursor was recorded on.
 *
 * A cursor written before this correction holds a broker-local value. After
 * the correction the same tick reads three hours earlier, so an uncorrected
 * cursor would sit in the future and silently filter out every new tick.
 * The watch state records this tag and discards a cursor that does not
 * carry it, which makes the fix self-healing instead of quietly blinding
 * the strategy.
 */
export const RSI_CURSOR_TIME_BASIS = 'BROKER_WALL_CLOCK_CORRECTED_V1';

/**
 * Converts one stored broker timestamp — a tick's `timestamp` or a candle's
 * `open_time`, which share the same mislabeling — to true UTC ms.
 *
 * Returns `null` for a timestamp that is not a valid wall-clock time in the
 * broker's zone (the DST spring-forward gap, or an ambiguous autumn hour).
 * Such a tick is dropped rather than guessed at: XAUUSD does not trade in
 * those Sunday hours, so one appearing there is a data problem.
 */
export function storedBrokerTimeToUtcMs(
  storedMs: number,
  timeZone: string = RSI_BROKER_SERVER_TIMEZONE,
): number | null {
  try {
    return wallClockToUtc(timeZone, storedMs);
  } catch {
    return null;
  }
}
