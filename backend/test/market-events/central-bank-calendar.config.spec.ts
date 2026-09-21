import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { loadCentralBankCalendarConfig } from '../../src/market-events/central-bank-calendar.config';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('loadCentralBankCalendarConfig — off by default, no credential required', () => {
  it('CENTRAL_BANK_CALENDAR_ENABLED unset → disabled, no error, no vars required', () => {
    const result = loadCentralBankCalendarConfig(configWith({}));
    expect(result).toEqual({ enabled: false, fetchIntervalSeconds: 86400 });
  });

  it('CENTRAL_BANK_CALENDAR_ENABLED=true with nothing else set → enabled, no throw (no credential exists to require)', () => {
    const result = loadCentralBankCalendarConfig(configWith({ CENTRAL_BANK_CALENDAR_ENABLED: 'true' }));
    expect(result).toEqual({ enabled: true, fetchIntervalSeconds: 86400 });
  });

  it('falls back to the default fetch interval when unset or invalid', () => {
    const base = { CENTRAL_BANK_CALENDAR_ENABLED: 'true' };
    expect(loadCentralBankCalendarConfig(configWith(base)).fetchIntervalSeconds).toBe(86400);
    expect(
      loadCentralBankCalendarConfig(configWith({ ...base, CENTRAL_BANK_CALENDAR_FETCH_INTERVAL_SECONDS: 'nope' }))
        .fetchIntervalSeconds,
    ).toBe(86400);
    expect(
      loadCentralBankCalendarConfig(configWith({ ...base, CENTRAL_BANK_CALENDAR_FETCH_INTERVAL_SECONDS: '3600' }))
        .fetchIntervalSeconds,
    ).toBe(3600);
  });
});
