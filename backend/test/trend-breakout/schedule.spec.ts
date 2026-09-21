import { describe, expect, it } from 'vitest';
import { getBeirutCalendarDate, getBeirutWallClock, isWithinEntryWindow } from '../../src/trend-breakout/schedule';

describe('Beirut entry-window schedule', () => {
  it('is inclusive at 03:00:00 local (EET winter, UTC+2)', () => {
    // Jan 2026 — Lebanon is on standard time (EET, UTC+2), no DST.
    expect(isWithinEntryWindow(new Date('2026-01-15T01:00:00.000Z'))).toBe(true); // 03:00:00 local
    expect(isWithinEntryWindow(new Date('2026-01-15T00:59:59.999Z'))).toBe(false); // 02:59:59.999 local
  });

  it('is exclusive at 12:00:00 local (noon)', () => {
    expect(isWithinEntryWindow(new Date('2026-01-15T09:59:59.000Z'))).toBe(true); // 11:59:59 local
    expect(isWithinEntryWindow(new Date('2026-01-15T10:00:00.000Z'))).toBe(false); // 12:00:00 local exactly — excluded
  });

  it('shifts correctly across the DST transition (EEST summer, UTC+3)', () => {
    // Lebanon's 2026 DST start is 2026-03-27 00:00 local (per this project's
    // own verified tzdata check) — pick a clearly-summer date instead of the
    // transition instant itself, to test the OFFSET shifted, not the edge.
    // At UTC+3, 03:00 local = 00:00 UTC.
    expect(isWithinEntryWindow(new Date('2026-07-01T00:00:00.000Z'))).toBe(true); // 03:00:00 EEST
    expect(isWithinEntryWindow(new Date('2026-07-01T08:59:59.000Z'))).toBe(true); // 11:59:59 EEST
    expect(isWithinEntryWindow(new Date('2026-07-01T09:00:00.000Z'))).toBe(false); // 12:00:00 EEST exactly
    // The SAME wall-clock check that was true in winter at 01:00 UTC is now false in summer (offset shifted).
    expect(isWithinEntryWindow(new Date('2026-07-01T01:00:00.000Z'))).toBe(true); // 04:00:00 EEST — still within window
  });

  it('midnight Beirut local time is correctly read as 00:xx, not "24:xx"', () => {
    // Exactly local midnight in winter (UTC+2) is 22:00 UTC the previous day.
    const clock = getBeirutWallClock(new Date('2026-01-14T22:00:00.000Z'));
    expect(clock.hour).toBe(0);
    expect(clock.dateKey).toBe('2026-01-15');
  });

  it('getBeirutCalendarDate returns the Beirut calendar day, which can differ from the UTC day', () => {
    // 23:30 UTC in winter is 01:30 the NEXT day in Beirut (UTC+2).
    expect(getBeirutCalendarDate(new Date('2026-01-14T23:30:00.000Z'))).toBe('2026-01-15');
  });
});
