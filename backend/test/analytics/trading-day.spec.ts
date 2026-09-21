import { describe, expect, it } from 'vitest';
import {
  getUtcOffsetMinutes,
  nextTradingDayBoundaryStart,
  previousTradingDayBoundaryStart,
  tradingDayBoundariesInRange,
  tradingDayBoundaryContaining,
} from '../../src/analytics/trading-day';

describe('trading-day boundaries', () => {
  it('defaults to plain UTC calendar days when tz=UTC, resetHour=0', () => {
    const instant = new Date('2026-03-15T13:45:00Z');
    const { start, end } = tradingDayBoundaryContaining(instant, 'UTC', 0);
    expect(start.toISOString()).toBe('2026-03-15T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-16T00:00:00.000Z');
  });

  it('a timestamp exactly at the boundary belongs to the day that starts there', () => {
    const instant = new Date('2026-03-15T00:00:00.000Z');
    const { start } = tradingDayBoundaryContaining(instant, 'UTC', 0);
    expect(start.toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });

  it('a timestamp one millisecond before the boundary belongs to the previous day', () => {
    const instant = new Date('2026-03-14T23:59:59.999Z');
    const { start } = tradingDayBoundaryContaining(instant, 'UTC', 0);
    expect(start.toISOString()).toBe('2026-03-14T00:00:00.000Z');
  });

  it('honors a non-zero reset hour in a non-UTC timezone (Europe/Athens, EET/EEST, reset at 3am local)', () => {
    // Europe/Athens is UTC+2 in winter. 2026-01-10T00:30Z local time is
    // 2026-01-10T02:30 local — before the 03:00 local reset — so it belongs
    // to the trading day that started on 2026-01-09 local (2026-01-09T01:00Z).
    const instant = new Date('2026-01-10T00:30:00Z');
    const { start, end } = tradingDayBoundaryContaining(instant, 'Europe/Athens', 3);
    expect(start.toISOString()).toBe('2026-01-09T01:00:00.000Z'); // 2026-01-09T03:00 EET
    expect(end.toISOString()).toBe('2026-01-10T01:00:00.000Z'); // 2026-01-10T03:00 EET
  });

  it('a timestamp after the local reset hour belongs to that same local calendar date', () => {
    const instant = new Date('2026-01-10T02:00:00Z'); // 04:00 EET — after the 03:00 reset
    const { start } = tradingDayBoundaryContaining(instant, 'Europe/Athens', 3);
    expect(start.toISOString()).toBe('2026-01-10T01:00:00.000Z'); // 2026-01-10T03:00 EET
  });

  it('handles the spring-forward DST transition (Europe/Athens: EET->EEST, clocks jump 03:00->04:00 on 2026-03-29)', () => {
    // Reset hour 05:00 local is used (not 03:00) because 03:00 local doesn't
    // exist at all on 2026-03-29 (clocks jump 03:00 -> 04:00) — that instant
    // is covered separately below as its own documented edge case. At 05:00
    // local, the trading day starting 2026-03-28T05:00 EET (UTC+2) ends at
    // 2026-03-29T05:00 EEST (UTC+3): 23 hours of UTC wall-clock time, not 24.
    const boundaryStart = tradingDayBoundaryContaining(new Date('2026-03-28T12:00:00Z'), 'Europe/Athens', 5).start;
    expect(boundaryStart.toISOString()).toBe('2026-03-28T03:00:00.000Z'); // 2026-03-28T05:00 EET (UTC+2)

    const nextStart = nextTradingDayBoundaryStart(boundaryStart, 'Europe/Athens', 5);
    expect(nextStart.toISOString()).toBe('2026-03-29T02:00:00.000Z'); // 2026-03-29T05:00 EEST (UTC+3)

    const hoursInDay = (nextStart.getTime() - boundaryStart.getTime()) / (60 * 60 * 1000);
    expect(hoursInDay).toBe(23);
  });

  it('a reset hour that falls inside the spring-forward gap (03:00 local, which never occurs on 2026-03-29) still resolves deterministically', () => {
    // 03:00 local doesn't exist that day (clocks skip 02:59:59 EET straight
    // to 04:00:00 EEST). There is no "correct" UTC instant for a wall-clock
    // time that never happened — different systems resolve it differently —
    // but this module must still be deterministic, not throw, and not
    // silently produce two different answers on repeated calls.
    const first = nextTradingDayBoundaryStart(
      tradingDayBoundaryContaining(new Date('2026-03-28T12:00:00Z'), 'Europe/Athens', 3).start,
      'Europe/Athens',
      3,
    );
    const second = nextTradingDayBoundaryStart(
      tradingDayBoundaryContaining(new Date('2026-03-28T12:00:00Z'), 'Europe/Athens', 3).start,
      'Europe/Athens',
      3,
    );
    expect(first.toISOString()).toBe(second.toISOString());
  });

  it('handles the fall-back DST transition (Europe/Athens: EEST->EET, clocks fall 04:00->03:00 on 2026-10-25)', () => {
    const boundaryStart = tradingDayBoundaryContaining(new Date('2026-10-24T12:00:00Z'), 'Europe/Athens', 3).start;
    expect(boundaryStart.toISOString()).toBe('2026-10-24T00:00:00.000Z'); // 2026-10-24T03:00 EEST (UTC+3)

    const nextStart = nextTradingDayBoundaryStart(boundaryStart, 'Europe/Athens', 3);
    // 2026-10-25T03:00 local is EET (UTC+2) post-transition.
    expect(nextStart.toISOString()).toBe('2026-10-25T01:00:00.000Z');

    const hoursInDay = (nextStart.getTime() - boundaryStart.getTime()) / (60 * 60 * 1000);
    expect(hoursInDay).toBe(25);
  });

  it('previousTradingDayBoundaryStart / nextTradingDayBoundaryStart are inverses across a DST gap', () => {
    const start = tradingDayBoundaryContaining(new Date('2026-03-28T12:00:00Z'), 'Europe/Athens', 3).start;
    const next = nextTradingDayBoundaryStart(start, 'Europe/Athens', 3);
    const back = previousTradingDayBoundaryStart(next, 'Europe/Athens', 3);
    expect(back.toISOString()).toBe(start.toISOString());
  });

  it('computes the correct offset for a known IANA zone/date pair', () => {
    expect(getUtcOffsetMinutes(new Date('2026-06-15T12:00:00Z'), 'Europe/Athens')).toBe(180); // EEST, UTC+3
    expect(getUtcOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'Europe/Athens')).toBe(120); // EET, UTC+2
    expect(getUtcOffsetMinutes(new Date('2026-06-15T12:00:00Z'), 'UTC')).toBe(0);
  });

  it('tradingDayBoundariesInRange returns exactly one boundary per day, ascending, half-open', () => {
    const start = new Date('2026-03-01T00:00:00Z');
    const end = new Date('2026-03-06T00:00:00Z');
    const boundaries = tradingDayBoundariesInRange(start, end, 'UTC', 0);
    expect(boundaries.map((d) => d.toISOString())).toEqual([
      '2026-03-01T00:00:00.000Z',
      '2026-03-02T00:00:00.000Z',
      '2026-03-03T00:00:00.000Z',
      '2026-03-04T00:00:00.000Z',
      '2026-03-05T00:00:00.000Z',
    ]);
  });

  it('tradingDayBoundariesInRange spans a DST transition correctly (5 local days, not a fixed hour count)', () => {
    const start = tradingDayBoundaryContaining(new Date('2026-03-26T12:00:00Z'), 'Europe/Athens', 3).start;
    const end = tradingDayBoundaryContaining(new Date('2026-03-31T12:00:00Z'), 'Europe/Athens', 3).start;
    const boundaries = tradingDayBoundariesInRange(start, end, 'Europe/Athens', 3);
    expect(boundaries).toHaveLength(5);
  });
});
