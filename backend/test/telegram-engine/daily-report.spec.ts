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
  // 10:00Z = 13:00 Beirut (UTC+3 in September).
  const at = (h: number) => Date.UTC(2026, 8, 23, h, 0);
  const report = buildDailyReport('2026-09-23', 'Demo 5056294252', 'USD', [
    { attribution: attributeMagic(262610200), net: 4.5, side: 'BUY', volume: 0.01, openPrice: 4300, closePrice: 4304.5, closedAtMs: at(10) },
    { attribution: attributeMagic(262610200), net: -2, side: 'SELL', volume: 0.01, openPrice: 4310, closePrice: 4312, closedAtMs: at(8) },
    { attribution: attributeMagic(262610201), net: 3, side: 'BUY', volume: 0.01, openPrice: 4290, closePrice: 4293, closedAtMs: at(12) },
    { attribution: attributeMagic(262610210), net: 0.24, side: 'BUY', volume: 0.01, openPrice: 4314.76, closePrice: 4315, closedAtMs: at(14) },
    { attribution: attributeMagic(262610210), net: -1.1, side: 'SELL', volume: 0.01, openPrice: 4338, closePrice: 4339.1, closedAtMs: at(15) },
  ]);
  const text = () => renderDailyReport(report).join('\n');

  it('counts wins and losses per engine and frame', () => {
    expect(report.engineAM1).toMatchObject({ wins: 1, losses: 1 });
    expect(report.engineAM5).toMatchObject({ wins: 1, losses: 0 });
    expect(report.engineB).toMatchObject({ wins: 1, losses: 1 });
    expect(report.total).toMatchObject({ wins: 3, losses: 2 });
    expect(report.total.net).toBeCloseTo(4.64, 6);
  });

  it('lists every order on its own line, Engine A first, then Engine B, in closing order', () => {
    const t = text();
    const a = t.indexOf('ENGINE A');
    const b = t.indexOf('ENGINE B');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    // Engine A in closing order: the 11:00 Beirut loss before the 13:00 win.
    expect(t).toContain('1. M1 · SELL 0.01 lot · 4310 → 4312 · closed 11:00 · ❌ LOSS -2.00 USD');
    expect(t).toContain('2. M1 · BUY 0.01 lot · 4300 → 4304.5 · closed 13:00 · ✅ WIN +4.50 USD');
    expect(t).toContain('3. M5 · BUY 0.01 lot · 4290 → 4293 · closed 15:00 · ✅ WIN +3.00 USD');
    // Engine B has no frame.
    expect(t).toContain('1. BUY 0.01 lot · 4314.76 → 4315 · closed 17:00 · ✅ WIN +0.24 USD');
    expect(t).toContain('2. SELL 0.01 lot · 4338 → 4339.1 · closed 18:00 · ❌ LOSS -1.10 USD');
  });

  it('ends with the total of the winning orders, the losing orders, and the net', () => {
    const t = text();
    expect(t.indexOf('TOTAL')).toBeGreaterThan(t.indexOf('ENGINE B'));
    expect(t).toContain('Winning orders: 3 · +7.74 USD');
    expect(t).toContain('Losing orders: 2 · -3.10 USD');
    expect(t).toContain('Net: +4.64 USD');
  });

  it('says so when an engine closed nothing', () => {
    const t = renderDailyReport(buildDailyReport('2026-09-23', 'X', 'USD', [])).join('\n');
    expect(t.match(/No closed orders\./g)).toHaveLength(2);
    expect(t).not.toContain('Other');
  });

  it('names the day and the account', () => {
    expect(text()).toContain('DAILY REPORT — 2026-09-23 (Beirut time)');
    expect(text()).toContain('Account: Demo 5056294252');
  });

  it('splits a long day into several messages instead of cutting it off', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      attribution: attributeMagic(262610200),
      net: i % 2 ? 1 : -1,
      side: 'BUY' as const,
      volume: 0.01,
      openPrice: 4300,
      closePrice: 4301,
      closedAtMs: at(10) + i * 60_000,
    }));
    const parts = renderDailyReport(buildDailyReport('2026-09-23', 'X', 'USD', many));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts.join('\n')).toContain('120. M1');
    expect(parts[parts.length - 1]).toContain('Net:');
  });
});
