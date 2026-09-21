import { describe, expect, it } from 'vitest';
import { dateKeyInTimezone, toCronPatternAndTimezone } from '../../src/alerts/daily-market-analysis.processor';

describe('toCronPatternAndTimezone', () => {
  it('converts "08:00" to a daily cron pattern plus the given timezone', () => {
    expect(toCronPatternAndTimezone('08:00', 'Asia/Beirut')).toEqual({ pattern: '0 8 * * *', tz: 'Asia/Beirut' });
  });

  it('handles single-digit hours/minutes without leading-zero surprises', () => {
    expect(toCronPatternAndTimezone('06:05', 'UTC')).toEqual({ pattern: '5 6 * * *', tz: 'UTC' });
  });

  it('handles midnight and the last minute of the day', () => {
    expect(toCronPatternAndTimezone('00:00', 'UTC')).toEqual({ pattern: '0 0 * * *', tz: 'UTC' });
    expect(toCronPatternAndTimezone('23:59', 'UTC')).toEqual({ pattern: '59 23 * * *', tz: 'UTC' });
  });
});

describe('dateKeyInTimezone', () => {
  it('returns the UTC calendar date for a UTC timestamp well inside the day', () => {
    expect(dateKeyInTimezone(new Date('2026-09-07T12:00:00Z'), 'UTC')).toBe('2026-09-07');
  });

  it('rolls over to the next local day when the timezone is ahead of UTC', () => {
    // 22:30 UTC on the 6th is already 01:30 on the 7th in Asia/Beirut (UTC+3).
    expect(dateKeyInTimezone(new Date('2026-09-06T22:30:00Z'), 'Asia/Beirut')).toBe('2026-09-07');
  });

  it('rolls back to the previous local day when the timezone is behind UTC', () => {
    // 02:00 UTC on the 7th is still 21:00 on the 6th in America/New_York (UTC-5 in September).
    expect(dateKeyInTimezone(new Date('2026-09-07T02:00:00Z'), 'America/New_York')).toBe('2026-09-06');
  });

  it('agrees across the whole day for two timestamps in the same local calendar day', () => {
    const morning = dateKeyInTimezone(new Date('2026-09-07T06:00:00Z'), 'Asia/Beirut');
    const evening = dateKeyInTimezone(new Date('2026-09-07T18:00:00Z'), 'Asia/Beirut');
    expect(morning).toBe(evening);
  });
});
