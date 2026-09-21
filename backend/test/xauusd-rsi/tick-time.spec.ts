/**
 * The broker wall-clock correction for stored tick and candle timestamps.
 *
 * Regression test for a demonstrated defect: `historical_ticks.timestamp`
 * held broker-local digits wearing a UTC label, so an observation recorded
 * at 01:00:01 Beirut persisted as `2026-09-21T01:00:01Z` — three hours
 * ahead of the 22:00:01Z it actually happened at — and the dashboard, which
 * formats correctly in Asia/Beirut, faithfully rendered it as 04:00.
 *
 * The same offset silently disabled the engine's staleness test, because
 * `now - atT` came out negative for every tick.
 */
import { describe, expect, it } from 'vitest';
import {
  RSI_CURSOR_TIME_BASIS,
  storedBrokerTimeToUtcMs,
} from '../../src/xauusd-rsi/tick-time';
import { utcToWallClockMs } from '../../src/research/confirmed-retest/time';
import { beirutLabel } from '../../src/xauusd-rsi/time';
import { applyClosedBar, applyTick, createEngineState, M1_MS } from '../../src/xauusd-rsi/engine';
import { SPEC } from '../../src/xauusd-rsi/spec';
import { RSI_FUTURE_OBSERVATION_TOLERANCE_MS } from '../../src/xauusd-rsi/safety-constants';

/** The exact decision the defect was demonstrated on. */
const STORED_OBSERVED_AT = Date.parse('2026-09-21T01:00:01.415Z');
const TRUE_OBSERVED_AT = Date.parse('2026-09-20T22:00:01.415Z');

describe('storedBrokerTimeToUtcMs', () => {
  it('converts the demonstrated decision back to the instant it really happened', () => {
    expect(storedBrokerTimeToUtcMs(STORED_OBSERVED_AT, 'EET')).toBe(TRUE_OBSERVED_AT);
  });

  it('renders that decision as 01:00 Beirut, not 04:00', () => {
    const corrected = storedBrokerTimeToUtcMs(STORED_OBSERVED_AT, 'EET')!;
    expect(beirutLabel(corrected)).toContain('01:00:01');
    // The uncorrected value is exactly what the dashboard showed before.
    expect(beirutLabel(STORED_OBSERVED_AT)).toContain('04:00:01');
  });

  it('shifts by exactly three hours in EEST (summer)', () => {
    const july = Date.parse('2026-07-15T12:00:00.000Z');
    expect(july - storedBrokerTimeToUtcMs(july, 'EET')!).toBe(3 * 60 * 60 * 1000);
  });

  it('shifts by exactly two hours in EET (winter), rather than a hardcoded offset', () => {
    const january = Date.parse('2026-01-15T12:00:00.000Z');
    expect(january - storedBrokerTimeToUtcMs(january, 'EET')!).toBe(2 * 60 * 60 * 1000);
  });

  it('round-trips against the conversion the research layer already uses', () => {
    const utc = storedBrokerTimeToUtcMs(STORED_OBSERVED_AT, 'EET')!;
    expect(utcToWallClockMs('EET', utc)).toBe(STORED_OBSERVED_AT);
  });

  it('drops a timestamp inside the DST spring-forward gap rather than guessing', () => {
    // 03:30 on the changeover Sunday does not exist in EET.
    const nonexistent = Date.parse('2026-03-29T03:30:00.000Z');
    expect(storedBrokerTimeToUtcMs(nonexistent, 'EET')).toBeNull();
  });

  it('preserves ordering, so a corrected series cannot look out of order', () => {
    const a = storedBrokerTimeToUtcMs(STORED_OBSERVED_AT, 'EET')!;
    const b = storedBrokerTimeToUtcMs(STORED_OBSERVED_AT + 5_000, 'EET')!;
    expect(b - a).toBe(5_000);
  });
});

describe('The staleness test the offset was disabling', () => {
  const MAX_STALENESS_MS = 30_000;

  it('an uncorrected timestamp makes every tick look fresh, however old it is', () => {
    // A tick from two hours ago, uncorrected: `now - atT` is NEGATIVE, so the
    // <= limit comparison passes and nothing can ever be rejected.
    const nowT = TRUE_OBSERVED_AT;
    const twoHoursOldStored = utcToWallClockMs('EET', nowT - 2 * 60 * 60 * 1000);
    expect(nowT - twoHoursOldStored).toBeLessThan(0);
    expect(nowT - twoHoursOldStored <= MAX_STALENESS_MS).toBe(true);
  });

  it('the corrected timestamp rejects that same tick', () => {
    const nowT = TRUE_OBSERVED_AT;
    const twoHoursOldStored = utcToWallClockMs('EET', nowT - 2 * 60 * 60 * 1000);
    const corrected = storedBrokerTimeToUtcMs(twoHoursOldStored, 'EET')!;
    expect(nowT - corrected).toBe(2 * 60 * 60 * 1000);
    expect(nowT - corrected <= MAX_STALENESS_MS).toBe(false);
  });

  it('and still accepts a genuinely fresh one', () => {
    const nowT = TRUE_OBSERVED_AT;
    const oneSecondOldStored = utcToWallClockMs('EET', nowT - 1_000);
    const corrected = storedBrokerTimeToUtcMs(oneSecondOldStored, 'EET')!;
    expect(nowT - corrected).toBe(1_000);
    expect(nowT - corrected <= MAX_STALENESS_MS).toBe(true);
  });
});

describe('The cursor time-basis tag', () => {
  it('is a stable, non-empty identifier', () => {
    expect(RSI_CURSOR_TIME_BASIS).toBe('BROKER_WALL_CLOCK_CORRECTED_V1');
  });

  it('distinguishes a pre-correction cursor, which would sit in the future', () => {
    // An untagged cursor holds the stored value; after the correction the
    // same tick reads three hours earlier, so every new tick would be
    // filtered out as "older than the cursor" and the strategy would go
    // blind while still looking healthy.
    const untaggedCursor = STORED_OBSERVED_AT;
    const nextTickCorrected = storedBrokerTimeToUtcMs(STORED_OBSERVED_AT + 1_000, 'EET')!;
    expect(nextTickCorrected).toBeLessThan(untaggedCursor);
  });
});

describe('Freshness is bounded on BOTH sides', () => {
  const REQUIRED_BARS = SPEC.rsi.period + 1 + SPEC.rsi.warmupBars;

  /** A warm engine whose last closed bar sits at `endT`. */
  function warmEngine(endT: number) {
    let s = createEngineState('TICK');
    let t = endT - REQUIRED_BARS * M1_MS;
    for (let i = 0; i < REQUIRED_BARS; i += 1) {
      s = applyClosedBar(s, t, 2000 + (i % 2 === 0 ? 0.5 : -0.5)).state;
      t += M1_MS;
    }
    return s;
  }

  const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

  it('accepts a genuinely fresh observation', () => {
    const s = warmEngine(NOW - M1_MS);
    const step = applyTick(s, { atT: NOW - 1_000, bid: 2001, tickKey: 'k1', nowT: NOW });
    expect(step.notes.join(' ')).not.toMatch(/suppressed/);
  });

  it('rejects a stale observation', () => {
    // The observation must still be NEWER than the engine's clock, or it is
    // rejected as out-of-order before freshness is ever considered. Age is
    // therefore created by advancing `nowT`, not by back-dating the tick.
    const s = warmEngine(NOW - M1_MS);
    const step = applyTick(s, { atT: NOW, bid: 2001, tickKey: 'k2', nowT: NOW + 120_000 });
    expect(step.notes.join(' ')).toMatch(/old \(limit 30s\).*suppressed/);
    expect(step.signals).toHaveLength(0);
  });

  it('REJECTS a future-dated observation instead of silently passing it', () => {
    // The exact shape of the old defect: a three-hour-ahead timestamp.
    const s = warmEngine(NOW - M1_MS);
    const step = applyTick(s, { atT: NOW + 3 * 60 * 60 * 1000, bid: 2001, tickKey: 'k3', nowT: NOW });
    expect(step.notes.join(' ')).toMatch(/dated .* in the FUTURE/);
    expect(step.signals).toHaveLength(0);
  });

  it('a negative age does not slip through the stale comparison', () => {
    // `age <= limit` is TRUE for every negative age — that is the blind spot.
    const ageMs = -(3 * 60 * 60 * 1000);
    expect(ageMs <= SPEC.observation.maxStalenessMs).toBe(true);
    // The implementation must not rely on that comparison alone.
    expect(ageMs < -RSI_FUTURE_OBSERVATION_TOLERANCE_MS).toBe(true);
  });

  it('tolerates ordinary clock skew just inside the tolerance', () => {
    const s = warmEngine(NOW - M1_MS);
    const step = applyTick(s, {
      atT: NOW + RSI_FUTURE_OBSERVATION_TOLERANCE_MS - 100,
      bid: 2001, tickKey: 'k4', nowT: NOW,
    });
    expect(step.notes.join(' ')).not.toMatch(/FUTURE/);
  });

  it('rejects just beyond the tolerance', () => {
    const s = warmEngine(NOW - M1_MS);
    const step = applyTick(s, {
      atT: NOW + RSI_FUTURE_OBSERVATION_TOLERANCE_MS + 500,
      bid: 2001, tickKey: 'k5', nowT: NOW,
    });
    expect(step.notes.join(' ')).toMatch(/FUTURE/);
  });
});

describe('Quote freshness uses the freshest XAUUSD stream, not the slowest', () => {
  /**
   * Regression test for a gate that measured the wrong thing.
   *
   * The collector writes XAUUSD twice. `live_ticks` is written once per
   * snapshot cycle, and that cycle also syncs candles across six timeframes
   * and two symbols, so it lands every 25-45 seconds. `historical_ticks` is
   * written by the dedicated one-second observation thread and is what the
   * strategy actually observes.
   *
   * Reading only `live_ticks` made the eligibility gate oscillate between
   * "quote is 6.7s old" and "quote is 43s old (limit 30s)" with no change in
   * the market, blocking entries whenever the snapshot cycle ran long. Any
   * signal in those windows was consumed and skipped.
   *
   * The comparison is not trivial: the two streams store timestamps on
   * different clocks.
   */
  const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

  /** What the freshness check computes, given both streams. */
  function ageSeconds(liveTickUtcMs: number | null, storedObservationMs: number | null) {
    const observationUtc = storedObservationMs === null ? null : storedBrokerTimeToUtcMs(storedObservationMs);
    const candidates = [liveTickUtcMs, observationUtc].filter((t): t is number => t !== null);
    return (NOW - Math.max(...candidates)) / 1000;
  }

  it('reports a fresh quote when observations are current but live_ticks lags', () => {
    // The real case: snapshot row 43s old, observation thread 1s old.
    const live = NOW - 43_000;
    const observed = utcToWallClockMs('EET', NOW - 1_000);
    expect(ageSeconds(live, observed)).toBeCloseTo(1, 3);
    expect(ageSeconds(live, observed)).toBeLessThan(SPEC.observation.maxStalenessMs / 1000);
  });

  it('would have blocked on the old behaviour, which is the defect', () => {
    // live_ticks alone: 43s, past the 30s limit.
    expect(ageSeconds(NOW - 43_000, null)).toBeCloseTo(43, 3);
    expect(ageSeconds(NOW - 43_000, null)).toBeGreaterThan(SPEC.observation.maxStalenessMs / 1000);
  });

  it('still reports STALE when BOTH streams are old — the gate is not weakened', () => {
    const live = NOW - 120_000;
    const observed = utcToWallClockMs('EET', NOW - 95_000);
    expect(ageSeconds(live, observed)).toBeCloseTo(95, 3);
    expect(ageSeconds(live, observed)).toBeGreaterThan(SPEC.observation.maxStalenessMs / 1000);
  });

  it('converts the observation clock rather than comparing raw values', () => {
    // Raw, the stored observation looks 3h in the FUTURE; uncorrected it
    // would make every quote appear impossibly fresh.
    const observedRaw = utcToWallClockMs('EET', NOW - 5_000);
    expect(NOW - observedRaw).toBeLessThan(0);
    expect(ageSeconds(null, observedRaw)).toBeCloseTo(5, 3);
  });

  it('works when only one stream exists', () => {
    expect(ageSeconds(NOW - 2_000, null)).toBeCloseTo(2, 3);
    expect(ageSeconds(null, utcToWallClockMs('EET', NOW - 2_000))).toBeCloseTo(2, 3);
  });
});
