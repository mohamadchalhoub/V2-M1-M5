import { describe, expect, it } from 'vitest';
import { toCronPatternAndTimezone } from '../../src/health/heartbeat-digest.processor';

describe('toCronPatternAndTimezone (heartbeat digest)', () => {
  it('converts "21:00" to a daily cron pattern plus the given timezone', () => {
    expect(toCronPatternAndTimezone('21:00', 'Asia/Beirut')).toEqual({ pattern: '0 21 * * *', tz: 'Asia/Beirut' });
  });

  it('handles single-digit hours/minutes without leading-zero surprises', () => {
    expect(toCronPatternAndTimezone('06:05', 'UTC')).toEqual({ pattern: '5 6 * * *', tz: 'UTC' });
  });

  it('handles midnight and the last minute of the day', () => {
    expect(toCronPatternAndTimezone('00:00', 'UTC')).toEqual({ pattern: '0 0 * * *', tz: 'UTC' });
    expect(toCronPatternAndTimezone('23:59', 'UTC')).toEqual({ pattern: '59 23 * * *', tz: 'UTC' });
  });

  it('rejects an out-of-range hour or minute rather than silently producing a broken cron pattern', () => {
    expect(() => toCronPatternAndTimezone('24:00', 'UTC')).toThrow(/HH:MM/);
    expect(() => toCronPatternAndTimezone('12:60', 'UTC')).toThrow(/HH:MM/);
    expect(() => toCronPatternAndTimezone('not-a-time', 'UTC')).toThrow(/HH:MM/);
  });
});
