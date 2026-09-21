// Covers required scenarios 1, 2, 3, 9, and the "unusable before
// establishedAt" half of scenario 4 (the no-look-ahead invariant's
// construction-time half lives in level-construction.spec.ts).
import { describe, expect, it } from 'vitest';
import { buildTouchEvent, createLevel, findFirstTouch, isWithinFirstTouchWindow } from '../../../src/research/first-touch/engine';
import type { DataGap } from '../../../src/research/first-touch/types';
import { candle, h4Candle } from './helpers';

const SYMBOL = 'XAUUSD';

describe('scenario 1 — a first-touch outside the eligible window consumes the level, blocking a later inside-window "repeat"', () => {
  it('finds the 02:00-local (out-of-window) touch as THE first touch, never the later 04:00+ one', () => {
    // establishedAt: 2026-01-10T04:00:00Z. January -> Beirut EET, UTC+2.
    const source = h4Candle('2026-01-10T00:00:00.000Z', 2000, 2010, 1995, 2005);
    const level = createLevel({ id: 'lvl', role: 'SUPPORT', price: 2000, sourceCandles: [source], establishedAt: source.closeTime, methodVersion: 'v1' });

    // 2026-01-11T00:00:00Z local = 02:00 EET — outside the 04:00-12:00 window. Body straddles 2000.
    const touchA = candle('2026-01-11T00:00:00.000Z', 2005, 2006, 1995, 1996);
    // 2026-01-12T02:00:00Z local = 04:00 EET — inside the window, chronologically LATER. Body also straddles 2000.
    const touchB = candle('2026-01-12T02:00:00.000Z', 2010, 2011, 1990, 1991);

    const detection = findFirstTouch({ level, candles: [source, touchA, touchB], gaps: [], symbol: SYMBOL });

    expect(detection.status).toBe('TOUCHED');
    expect(detection.touchCandle?.openTime.toISOString()).toBe(touchA.openTime.toISOString());
    expect(detection.touchCandle?.openTime.toISOString()).not.toBe(touchB.openTime.toISOString());

    const event = buildTouchEvent({ level, detection, candles: [source, touchA, touchB], symbol: SYMBOL });
    expect(event).not.toBeNull();
    expect(event!.withinEligibleWindow).toBe(false); // it was the 02:00 touch
    expect(event!.touchTimestampUtc.toISOString()).toBe(touchA.openTime.toISOString());
  });
});

describe('scenario 2 — no daily / 04:00 reset, verified across a multi-day synthetic series', () => {
  it('an out-of-window touch on day 1 stays the first touch even though days 2-4 each present another within-window "touch" opportunity', () => {
    const source = h4Candle('2026-02-01T00:00:00.000Z', 2000, 2010, 1995, 2005);
    const level = createLevel({ id: 'lvl', role: 'SUPPORT', price: 2000, sourceCandles: [source], establishedAt: source.closeTime, methodVersion: 'v1' });

    // Day 1, 02:00 local (outside window) — consumes the first-touch event.
    const day1 = candle('2026-02-02T00:00:00.000Z', 2005, 2006, 1994, 1996);
    // Days 2-4, 05:00 local (INSIDE window) — if there were any daily/04:00
    // reset, one of these would wrongly become "the" first touch.
    const day2 = candle('2026-02-03T03:00:00.000Z', 2008, 2009, 1992, 1993);
    const day3 = candle('2026-02-04T03:00:00.000Z', 2008, 2009, 1992, 1993);
    const day4 = candle('2026-02-05T03:00:00.000Z', 2008, 2009, 1992, 1993);

    const candles = [source, day1, day2, day3, day4];
    const detection = findFirstTouch({ level, candles, gaps: [], symbol: SYMBOL });

    expect(detection.status).toBe('TOUCHED');
    expect(detection.touchCandle?.openTime.toISOString()).toBe(day1.openTime.toISOString());
    for (const later of [day2, day3, day4]) {
      expect(detection.touchCandle?.openTime.toISOString()).not.toBe(later.openTime.toISOString());
    }

    // Idempotent: re-running the identical scan changes nothing.
    const detectionAgain = findFirstTouch({ level, candles, gaps: [], symbol: SYMBOL });
    expect(detectionAgain).toEqual(detection);
  });
});

describe('scenario 3 — Beirut DST boundary correctness for the 04:00-12:00 window', () => {
  it('is inclusive at 04:00:00 local and exclusive at 12:00:00, in winter (EET, UTC+2)', () => {
    expect(isWithinFirstTouchWindow(new Date('2026-01-15T02:00:00.000Z'))).toBe(true); // 04:00:00 local
    expect(isWithinFirstTouchWindow(new Date('2026-01-15T01:59:59.999Z'))).toBe(false); // 03:59:59.999 local
    expect(isWithinFirstTouchWindow(new Date('2026-01-15T09:59:59.000Z'))).toBe(true); // 11:59:59 local
    expect(isWithinFirstTouchWindow(new Date('2026-01-15T10:00:00.000Z'))).toBe(false); // 12:00:00 local exactly
  });

  it('shifts correctly once in EEST summer time (UTC+3)', () => {
    expect(isWithinFirstTouchWindow(new Date('2026-07-01T01:00:00.000Z'))).toBe(true); // 04:00:00 local
    expect(isWithinFirstTouchWindow(new Date('2026-07-01T00:59:59.999Z'))).toBe(false); // 03:59:59.999 local
    expect(isWithinFirstTouchWindow(new Date('2026-07-01T09:00:00.000Z'))).toBe(false); // 12:00:00 local exactly
  });

  it('is correct on BOTH sides of the actual 2026 spring-forward instant (2026-03-27T00:00 local, per this project\'s own verified tzdata check — see test/trend-breakout/schedule.spec.ts)', () => {
    // One second before the jump: 2026-03-26T23:59:59.999 EET (UTC+2) -> hour 23, outside the window.
    expect(isWithinFirstTouchWindow(new Date('2026-03-26T21:59:59.999Z'))).toBe(false);
    // The instant of the jump: local clock jumps 00:00 -> 01:00 EEST (UTC+3) -> hour 1, still outside the window.
    expect(isWithinFirstTouchWindow(new Date('2026-03-26T22:00:00.000Z'))).toBe(false);
    // Comfortably either side, to also prove the OFFSET actually shifted and the function didn't just get lucky near midnight.
    expect(isWithinFirstTouchWindow(new Date('2026-03-26T08:00:00.000Z'))).toBe(true); // 10:00 EET, pre-transition
    expect(isWithinFirstTouchWindow(new Date('2026-03-27T07:00:00.000Z'))).toBe(true); // 10:00 EEST, post-transition
  });
});

describe('scenario 9 — a pre-touch data gap forces first-touch eligibility to UNKNOWN, never a false NOT_TOUCHED/TOUCHED', () => {
  it('marks UNKNOWN when an UNCONFIRMED gap could have concealed an earlier touch', () => {
    const source = h4Candle('2026-01-01T00:00:00.000Z', 2000, 2010, 1995, 2005);
    const level = createLevel({ id: 'lvl', role: 'SUPPORT', price: 2000, sourceCandles: [source], establishedAt: source.closeTime, methodVersion: 'v1' });

    // No data at all for ~2 days right after establishment, cause unknown.
    const gap: DataGap = { symbol: SYMBOL, start: level.establishedAt, end: new Date('2026-01-03T00:00:00.000Z'), kind: 'UNCONFIRMED' };
    // The first candle we DO have is well after the gap and touches the zone.
    const candidate = candle('2026-01-03T05:00:00.000Z', 2005, 2006, 1994, 1996);

    const detection = findFirstTouch({ level, candles: [source, candidate], gaps: [gap], symbol: SYMBOL });

    expect(detection.status).toBe('UNKNOWN');
    expect(detection.concealingGap).toEqual(gap);
    // The candidate is still surfaced for inspection...
    expect(detection.touchCandle?.openTime.toISOString()).toBe(candidate.openTime.toISOString());
    // ...but buildTouchEvent must refuse to fabricate a TouchEvent from an unconfirmed detection.
    const event = buildTouchEvent({ level, detection, candles: [source, candidate], symbol: SYMBOL });
    expect(event).toBeNull();
  });

  it('does NOT mark UNKNOWN when no gap overlaps the pre-touch range', () => {
    const source = h4Candle('2026-01-01T00:00:00.000Z', 2000, 2010, 1995, 2005);
    const level = createLevel({ id: 'lvl', role: 'SUPPORT', price: 2000, sourceCandles: [source], establishedAt: source.closeTime, methodVersion: 'v1' });
    const candidate = candle('2026-01-03T05:00:00.000Z', 2005, 2006, 1994, 1996);
    // A gap that is entirely AFTER the candidate touch is irrelevant to it.
    const irrelevantGap: DataGap = { symbol: SYMBOL, start: new Date('2026-01-10T00:00:00.000Z'), end: new Date('2026-01-11T00:00:00.000Z'), kind: 'UNCONFIRMED' };

    const detection = findFirstTouch({ level, candles: [source, candidate], gaps: [irrelevantGap], symbol: SYMBOL });
    expect(detection.status).toBe('TOUCHED');
  });

  it('does NOT mark UNKNOWN across a CONFIRMED_CLOSURE gap — a verified-shut session conceals nothing', () => {
    const source = h4Candle('2026-01-01T00:00:00.000Z', 2000, 2010, 1995, 2005);
    const level = createLevel({ id: 'lvl', role: 'SUPPORT', price: 2000, sourceCandles: [source], establishedAt: source.closeTime, methodVersion: 'v1' });

    // An ordinary weekend closure, independently verified shut (e.g. corroborated by the BackfillInterval ledger) — not merely inferred from the calendar.
    const weekendClosure: DataGap = { symbol: SYMBOL, start: level.establishedAt, end: new Date('2026-01-03T00:00:00.000Z'), kind: 'CONFIRMED_CLOSURE' };
    const candidate = candle('2026-01-03T05:00:00.000Z', 2005, 2006, 1994, 1996);

    const detection = findFirstTouch({ level, candles: [source, candidate], gaps: [weekendClosure], symbol: SYMBOL });

    expect(detection.status).toBe('TOUCHED');
    expect(detection.concealingGap).toBeNull();
    const event = buildTouchEvent({ level, detection, candles: [source, candidate], symbol: SYMBOL });
    expect(event).not.toBeNull();
  });
});

describe('wick-based (not body-only) first touch — corrected 2026-09-13 after a real XAUUSD discrepancy', () => {
  it('counts a candle whose WICK reaches the zone even though its BODY never does, as the real regression: XAUUSD SUPPORT 2326.17, 2024-04-29 04:00 UTC candle O=2332.03 H=2332.03 L=2324.11 C=2327.81 (body [2327.81, 2332.03] never reaches 2326.17, but the low does)', () => {
    const source = h4Candle('2024-04-26T16:00:00.000Z', 2344.91, 2350.35, 2328.72, 2333.6);
    const level = createLevel({ id: 'lvl', role: 'SUPPORT', price: 2326.17, sourceCandles: [source], establishedAt: source.closeTime, methodVersion: 'v1' });

    const bodyMissesButWickReaches = candle('2024-04-29T04:00:00.000Z', 2332.03, 2332.03, 2324.11, 2327.81);
    const laterBodyTouch = candle('2024-04-29T04:15:00.000Z', 2326.49, 2326.49, 2322.4, 2322.87);

    const detection = findFirstTouch({
      level,
      candles: [source, bodyMissesButWickReaches, laterBodyTouch],
      gaps: [],
      symbol: SYMBOL,
    });

    expect(detection.status).toBe('TOUCHED');
    expect(detection.touchCandle?.openTime.toISOString()).toBe(bodyMissesButWickReaches.openTime.toISOString());
    expect(detection.touchCandle?.openTime.toISOString()).not.toBe(laterBodyTouch.openTime.toISOString());
  });

  it('still finds nothing when neither body nor wick ever reaches the zone', () => {
    const source = h4Candle('2026-01-05T00:00:00.000Z', 2000, 2010, 1995, 2005);
    const level = createLevel({ id: 'lvl', role: 'SUPPORT', price: 1900, sourceCandles: [source], establishedAt: source.closeTime, methodVersion: 'v1' });
    const neverClose = candle('2026-01-06T05:00:00.000Z', 2005, 2006, 1994, 1996);

    const detection = findFirstTouch({ level, candles: [source, neverClose], gaps: [], symbol: SYMBOL });
    expect(detection.status).toBe('NOT_TOUCHED');
  });
});

describe('scenario 4 (detection half) — a level is unusable before its own establishedAt', () => {
  it('ignores a zone-intersecting candle that occurs BEFORE establishedAt, and finds the real, later first touch instead', () => {
    const source = h4Candle('2026-01-05T00:00:00.000Z', 2000, 2010, 1995, 2005);
    const level = createLevel({ id: 'lvl', role: 'SUPPORT', price: 2000, sourceCandles: [source], establishedAt: source.closeTime, methodVersion: 'v1' });

    // Would intersect the zone, but occurs BEFORE establishedAt (2026-01-05T04:00:00Z) — must be ignored entirely.
    const beforeEstablishment = candle('2026-01-04T00:00:00.000Z', 2005, 2006, 1994, 1996);
    // The real first touch, after establishment.
    const afterEstablishment = candle('2026-01-06T05:00:00.000Z', 2005, 2006, 1994, 1996);

    const detection = findFirstTouch({
      level,
      candles: [beforeEstablishment, source, afterEstablishment],
      gaps: [],
      symbol: SYMBOL,
    });

    expect(detection.status).toBe('TOUCHED');
    expect(detection.touchCandle?.openTime.toISOString()).toBe(afterEstablishment.openTime.toISOString());
    expect(detection.touchCandle?.openTime.toISOString()).not.toBe(beforeEstablishment.openTime.toISOString());
  });

  it('never counts the level\'s own establishing/source candle as a touch of itself', () => {
    // The source candle's own body obviously "intersects" the zone (it's how the pivot was found) — it must never be picked up as the first touch.
    const source = h4Candle('2026-01-05T00:00:00.000Z', 2001, 2010, 1995, 2000); // body straddles/reaches 2000
    const level = createLevel({ id: 'lvl', role: 'SUPPORT', price: 2000, sourceCandles: [source], establishedAt: source.closeTime, methodVersion: 'v1' });
    const realTouch = candle('2026-01-06T05:00:00.000Z', 2005, 2006, 1994, 1996);

    const detection = findFirstTouch({ level, candles: [source, realTouch], gaps: [], symbol: SYMBOL });
    expect(detection.status).toBe('TOUCHED');
    expect(detection.touchCandle?.openTime.toISOString()).toBe(realTouch.openTime.toISOString());
  });
});
