/**
 * One coherent quote: price, broker timestamp, age and source together.
 *
 * Regression test for a defect measured on the deployed server. The API
 * published `bid`/`ask`/`tickAt` from `live_ticks` while taking
 * `ageSeconds` from whichever stream was fresher, so:
 *
 *   evaluatedAt 2026-09-21T13:30:11.495Z
 *   tickAt      2026-09-21T13:29:37.000Z   (34.495s old)
 *   ageSeconds  3.547                       ("fresh")
 *
 * These exercise the REAL resolver used by the dashboard, the session gate
 * and the pre-send check — not a helper that re-implements the arithmetic.
 */
import { describe, expect, it } from 'vitest';
import { QuoteCandidate, resolveQuote } from '../../src/xauusd-rsi/quote';
import { utcToWallClockMs } from '../../src/research/confirmed-retest/time';
import { RSI_FUTURE_OBSERVATION_TOLERANCE_MS, RSI_QUOTE_MAX_STALENESS_SECONDS } from '../../src/xauusd-rsi/safety-constants';

/** The exact instant from the reported sample. */
const EVALUATED_AT = Date.parse('2026-09-21T13:30:11.495Z');

/** `live_ticks` stores true UTC — the collector corrects it on the way in. */
const live = (utcMs: number, bid = 4370.1, ask = 4370.4): QuoteCandidate => ({
  bid, ask, storedMs: utcMs, source: 'live_ticks',
});

/** `historical_ticks` stores BROKER wall clock and must be converted once. */
const observed = (utcMs: number, bid = 4371.2, ask = 4371.5): QuoteCandidate => ({
  bid, ask, storedMs: utcToWallClockMs('EET', utcMs), source: 'historical_ticks',
});

describe('The reported defect', () => {
  it('does not let a 34.5s-old price inherit a 3.5s-old freshness', () => {
    const r = resolveQuote(
      [live(Date.parse('2026-09-21T13:29:37.000Z')), observed(EVALUATED_AT - 3_547)],
      EVALUATED_AT,
    );

    // The fast stream carries a usable bid/ask, so it IS the quote — and its
    // own price and timestamp travel with its age.
    expect(r.quote!.source).toBe('historical_ticks');
    expect(r.quote!.ageSeconds).toBeCloseTo(3.547, 3);
    expect(r.quote!.tickAtMs).toBe(EVALUATED_AT - 3_547);
    expect(r.quote!.bid).toBe(4371.2);

    // The published relationship must hold exactly.
    expect((r.evaluatedAtMs - r.quote!.tickAtMs) / 1000).toBeCloseTo(r.quote!.ageSeconds, 6);
    // And the stale candidate is visible rather than silently dropped.
    expect(r.considered.find((c) => c.source === 'live_ticks')!.ageSeconds).toBeCloseTo(34.495, 3);
  });

  it('selects the slow stream when IT is the newer valid one', () => {
    const r = resolveQuote([live(EVALUATED_AT - 1_000), observed(EVALUATED_AT - 20_000)], EVALUATED_AT);
    expect(r.quote!.source).toBe('live_ticks');
    expect(r.quote!.ageSeconds).toBeCloseTo(1, 3);
    expect(r.quote!.bid).toBe(4370.1);
  });
});

describe('Freshness', () => {
  it('blocks when BOTH sources are stale, naming the real reason', () => {
    const r = resolveQuote([live(EVALUATED_AT - 120_000), observed(EVALUATED_AT - 95_000)], EVALUATED_AT);
    expect(r.quote!.fresh).toBe(false);
    expect(r.quote!.ageSeconds).toBeCloseTo(95, 3);
    expect(r.blockedReason).toMatch(/95\.0s old \(limit 30s\), from historical_ticks/);
  });

  it('accepts a quote exactly at the limit', () => {
    const r = resolveQuote([live(EVALUATED_AT - RSI_QUOTE_MAX_STALENESS_SECONDS * 1000)], EVALUATED_AT);
    expect(r.quote!.fresh).toBe(true);
    expect(r.blockedReason).toBeNull();
  });

  it('does not refresh an unchanged tick on re-read', () => {
    const tickUtc = EVALUATED_AT - 40_000;
    const first = resolveQuote([live(tickUtc)], EVALUATED_AT);
    const later = resolveQuote([live(tickUtc)], EVALUATED_AT + 10_000);
    expect(first.quote!.ageSeconds).toBeCloseTo(40, 3);
    expect(later.quote!.ageSeconds).toBeCloseTo(50, 3);
    expect(later.quote!.tickAtMs).toBe(first.quote!.tickAtMs);
  });
});

describe('Validation happens before selection', () => {
  it('rejects a future-dated candidate beyond the clock-skew tolerance', () => {
    const r = resolveQuote(
      [live(EVALUATED_AT + RSI_FUTURE_OBSERVATION_TOLERANCE_MS + 5_000), observed(EVALUATED_AT - 2_000)],
      EVALUATED_AT,
    );
    expect(r.quote!.source).toBe('historical_ticks');
    expect(r.considered.find((c) => c.source === 'live_ticks')!.rejected).toMatch(/in the future/);
  });

  it('tolerates ordinary clock skew inside the tolerance', () => {
    const r = resolveQuote([live(EVALUATED_AT + 1_000)], EVALUATED_AT);
    expect(r.quote).not.toBeNull();
    expect(r.quote!.ageSeconds).toBeCloseTo(-1, 3);
  });

  it('does NOT let a malformed newer candidate displace a usable older one', () => {
    const r = resolveQuote(
      [live(EVALUATED_AT - 25_000), { ...observed(EVALUATED_AT - 1_000), bid: 0, ask: 0 }],
      EVALUATED_AT,
    );
    expect(r.quote!.source).toBe('live_ticks');
    expect(r.quote!.ageSeconds).toBeCloseTo(25, 3);
    expect(r.considered.find((c) => c.source === 'historical_ticks')!.rejected).toMatch(/bid\/ask/);
  });

  it.each([
    ['non-finite', Number.NaN, 4370.4],
    ['negative', -1, 4370.4],
    ['crossed', 4371.0, 4370.0],
  ])('rejects a %s bid/ask', (_label, bid, ask) => {
    const r = resolveQuote([{ ...live(EVALUATED_AT - 1_000), bid, ask }], EVALUATED_AT);
    expect(r.quote).toBeNull();
    expect(r.blockedReason).toMatch(/No usable XAUUSD quote/);
  });

  it('reports an explicit block when there is no candidate at all', () => {
    const r = resolveQuote([], EVALUATED_AT);
    expect(r.quote).toBeNull();
    expect(r.blockedReason).toMatch(/no XAUUSD quote has been recorded/);
  });

  it('works when only one source exists', () => {
    expect(resolveQuote([live(EVALUATED_AT - 2_000)], EVALUATED_AT).quote!.source).toBe('live_ticks');
    expect(resolveQuote([observed(EVALUATED_AT - 2_000)], EVALUATED_AT).quote!.source).toBe('historical_ticks');
  });
});

describe('Timestamp normalisation happens exactly once per source', () => {
  it('converts the broker wall clock of the fast stream', () => {
    const r = resolveQuote([observed(EVALUATED_AT - 4_000)], EVALUATED_AT);
    expect(r.quote!.tickAtMs).toBe(EVALUATED_AT - 4_000);
    expect(r.quote!.ageSeconds).toBeCloseTo(4, 3);
  });

  it('does NOT convert the slow stream, which is already true UTC', () => {
    // Double-converting would shift it by the broker offset and read ~3h old.
    const r = resolveQuote([live(EVALUATED_AT - 4_000)], EVALUATED_AT);
    expect(r.quote!.ageSeconds).toBeCloseTo(4, 3);
    expect(r.quote!.ageSeconds).toBeLessThan(60);
  });

  it('compares the two bases correctly when both describe the same instant', () => {
    const sameInstant = EVALUATED_AT - 7_000;
    const r = resolveQuote([live(sameInstant), observed(sameInstant)], EVALUATED_AT);
    expect(r.considered.every((c) => Math.abs((c.ageSeconds ?? 0) - 7) < 0.001)).toBe(true);
  });
});
