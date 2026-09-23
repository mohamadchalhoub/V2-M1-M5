import { describe, expect, it } from 'vitest';
import { attributeDeal, attributeMagic } from '../../src/trading-data/engine-attribution';
import {
  buildDailyReport,
  dayBounds,
  localDate,
  previousDate,
  renderDailyReport,
} from '../../src/trading-data/daily-report';

describe('engine and frame attribution from the magic number', () => {
  it.each([
    [262610200, 'Engine A', 'M1'],
    [262610201, 'Engine A', 'M5'],
    [262610210, 'Engine B', null],
    [262610180, 'Legacy', null],
    [262610181, 'Legacy', null],
    [0, 'Manual / other', null],
  ])('magic %s -> %s %s', (magic, engine, timeframe) => {
    const a = attributeMagic(magic);
    expect(a.engine).toBe(engine);
    expect(a.timeframe).toBe(timeframe);
  });

  it('uses the opening deal when the closing deal carries magic 0', () => {
    const a = attributeDeal({ magic: 0 }, { magic: 262610201 });
    expect(a.engine).toBe('Engine A');
    expect(a.timeframe).toBe('M5');
  });

  it('falls back to the deal itself when the opening deal is unknown', () => {
    expect(attributeDeal({ magic: 262610210 }, null).engine).toBe('Engine B');
  });
});

describe('Beirut calendar days', () => {
  it('reports the Beirut date, not the UTC date, just after local midnight', () => {
    // 2026-09-23 21:30Z is 00:30 on the 24th in Beirut (UTC+3 in summer).
    expect(localDate(Date.UTC(2026, 8, 23, 21, 30))).toBe('2026-09-24');
  });

  it('bounds a summer day at 21:00Z to 21:00Z', () => {
    const { startMs, endMs } = dayBounds('2026-09-23');
    expect(new Date(startMs).toISOString()).toBe('2026-09-22T21:00:00.000Z');
    expect(new Date(endMs).toISOString()).toBe('2026-09-23T21:00:00.000Z');
  });

  it('bounds a winter day at 22:00Z (UTC+2)', () => {
    const { startMs } = dayBounds('2026-01-15');
    expect(new Date(startMs).toISOString()).toBe('2026-01-14T22:00:00.000Z');
  });

  it('steps back across a month boundary', () => {
    expect(previousDate('2026-10-01')).toBe('2026-09-30');
  });
});

describe('the report', () => {
  const report = buildDailyReport('2026-09-23', 'Demo 5056294252', 'USD', [
    { attribution: attributeMagic(262610200), net: 4.5 },
    { attribution: attributeMagic(262610200), net: -2 },
    { attribution: attributeMagic(262610201), net: 3 },
    { attribution: attributeMagic(262610210), net: 0.24 },
    { attribution: attributeMagic(262610210), net: -1.1 },
  ]);

  it('counts wins and losses per engine and frame', () => {
    expect(report.engineAM1).toMatchObject({ wins: 1, losses: 1 });
    expect(report.engineAM5).toMatchObject({ wins: 1, losses: 0 });
    expect(report.engineB).toMatchObject({ wins: 1, losses: 1 });
    expect(report.total).toMatchObject({ wins: 3, losses: 2 });
    expect(report.total.net).toBeCloseTo(4.64, 6);
  });

  it('renders every engine line, including ones with no trades', () => {
    const text = renderDailyReport(buildDailyReport('2026-09-23', 'X', 'USD', []));
    expect(text).toContain('Engine A — M1: 0 wins, 0 losses');
    expect(text).toContain('Engine A — M5: 0 wins, 0 losses');
    expect(text).toContain('Engine B — Telegram: 0 wins, 0 losses');
    expect(text).not.toContain('Other');
  });

  it('names the day and the account', () => {
    const text = renderDailyReport(report);
    expect(text).toContain('DAILY REPORT — 2026-09-23 (Beirut time)');
    expect(text).toContain('Account: Demo 5056294252');
    expect(text).toContain('TOTAL: 3 wins, 2 losses');
  });
});
