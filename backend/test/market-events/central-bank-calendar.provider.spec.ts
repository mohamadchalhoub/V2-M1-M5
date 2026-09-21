import { describe, expect, it } from 'vitest';
import { CentralBankCalendarProvider } from '../../src/market-events/central-bank-calendar.provider';

describe('CentralBankCalendarProvider', () => {
  it('returns events falling within the requested window, correctly converted to UTC', async () => {
    const provider = new CentralBankCalendarProvider();
    // 2026-09-16 is a real curated FOMC decision date (14:00 ET = 18:00 UTC in September, EDT/UTC-4).
    const events = await provider.fetchEvents({
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-09-30T00:00:00Z'),
    });

    const fomcSeptember = events.find((e) => e.source === 'FOMC' && e.externalId === '2026-09-16');
    expect(fomcSeptember).toBeDefined();
    expect(fomcSeptember).toMatchObject({
      category: 'ECONOMIC_EVENT',
      scheduleType: 'EXPECTED',
      impact: 'HIGH',
      affectedCurrencies: ['USD'],
    });
    expect(fomcSeptember!.scheduledAt.toISOString()).toBe('2026-09-16T18:00:00.000Z');
  });

  it('converts an ECB decision (CET/CEST) correctly — 2026-09-10 is CEST (UTC+2)', async () => {
    const provider = new CentralBankCalendarProvider();
    const events = await provider.fetchEvents({
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-09-30T00:00:00Z'),
    });

    const ecbSeptember = events.find((e) => e.source === 'ECB' && e.externalId === '2026-09-10');
    expect(ecbSeptember).toBeDefined();
    expect(ecbSeptember).toMatchObject({ affectedCurrencies: ['EUR'], impact: 'HIGH' });
    // 14:15 CEST (UTC+2) = 12:15 UTC.
    expect(ecbSeptember!.scheduledAt.toISOString()).toBe('2026-09-10T12:15:00.000Z');
  });

  it('converts a winter-dated meeting correctly (EST/CET, not EDT/CEST) — DST-aware', async () => {
    const provider = new CentralBankCalendarProvider();
    const events = await provider.fetchEvents({
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2026-01-31T00:00:00Z'),
    });

    const fomcJanuary = events.find((e) => e.source === 'FOMC');
    expect(fomcJanuary).toBeDefined();
    // 14:00 EST (UTC-5) = 19:00 UTC, not 18:00 (which would be the summer/EDT offset).
    expect(fomcJanuary!.scheduledAt.toISOString()).toBe('2026-01-28T19:00:00.000Z');
  });

  it('excludes events outside the requested window', async () => {
    const provider = new CentralBankCalendarProvider();
    const events = await provider.fetchEvents({
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-09-30T00:00:00Z'),
    });

    expect(events.every((e) => e.scheduledAt >= new Date('2026-09-01T00:00:00Z'))).toBe(true);
    expect(events.every((e) => e.scheduledAt <= new Date('2026-09-30T00:00:00Z'))).toBe(true);
    expect(events.some((e) => e.externalId === '2026-12-09')).toBe(false);
  });
});
