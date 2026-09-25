/**
 * Audit coverage added 2026-09-25: the operator's exact moving-price
 * examples, ownership of magic-0 / V1 positions, and the daily close across
 * a Beirut DST change.
 */
import { describe, expect, it } from 'vitest';
import { isOwnedBySar } from '../../src/xauusd-sar/ownership';
import { SAR_MAGIC } from '../../src/xauusd-sar/safety-constants';
import { isWithinDailyClose } from '../../src/xauusd-sar/spec';
import { applyTrailing, initialSessionState, openInitialCycle, updateBuyTrailing, updateSellTrailing } from '../../src/xauusd-sar/state-machine';

const base = initialSessionState('2026-09-25');

describe('the reversal level follows the moving price, not the original entry', () => {
  it('SELL opened ~4500, market falls to 4490: BUY reversal level is 4490.50, not 4500.50', () => {
    let s = openInitialCycle(base, 'SELL', 4500, 'c1', 't1');
    for (const ask of [4498, 4495, 4490]) s = applyTrailing(s, updateSellTrailing(s, { bid: ask - 0.2, ask }));
    expect(s.reversalLevel).toBeCloseTo(4490.5, 9);
    expect(updateSellTrailing(s, { bid: 4490.1, ask: 4490.3 }).reversalTriggered).toBe(false);
    expect(updateSellTrailing(s, { bid: 4490.3, ask: 4490.5 }).reversalTriggered).toBe(true);
  });

  it('BUY with the market at 4501.50: SELL reversal level is 4501.00, not entry - 0.50', () => {
    let s = openInitialCycle(base, 'BUY', 4499, 'c1', 't1');
    for (const bid of [4500, 4501, 4501.5]) s = applyTrailing(s, updateBuyTrailing(s, { bid, ask: bid + 0.2 }));
    expect(s.reversalLevel).toBeCloseTo(4501.0, 9);
    expect(updateBuyTrailing(s, { bid: 4501.1, ask: 4501.3 }).reversalTriggered).toBe(false);
    expect(updateBuyTrailing(s, { bid: 4501.0, ask: 4501.2 }).reversalTriggered).toBe(true);
  });

  it('a repeated identical quote below the trigger changes nothing', () => {
    let s = openInitialCycle(base, 'SELL', 4500, 'c1', 't1');
    s = applyTrailing(s, updateSellTrailing(s, { bid: 4494.8, ask: 4495 }));
    for (let i = 0; i < 5; i++) {
      const u = updateSellTrailing(s, { bid: 4495.0, ask: 4495.2 });
      expect(u.reversalTriggered).toBe(false);
      s = applyTrailing(s, u);
    }
    expect(s.reversalLevel).toBeCloseTo(4495.5, 9);
  });
});

describe('SAR never owns positions that are not its own magic', () => {
  it.each([
    ['manual trade (magic 0)', 0],
    ['V1 RSI strategy', 262610190],
    ['Engine B Telegram', 262610210],
    ['unknown/absent magic', null],
  ])('%s is not SAR-owned', (_label, magic) => {
    expect(isOwnedBySar(magic as number | null)).toBe(false);
  });

  it('only SAR_MAGIC 262610220 is SAR-owned', () => {
    expect(SAR_MAGIC).toBe(262610220);
    expect(isOwnedBySar(262610220)).toBe(true);
  });
});

describe('daily close at 23:40 Beirut follows DST', () => {
  it('summer (UTC+3): 20:39:59Z trades, 20:40:00Z is closed, 21:59:59Z closed, 22:00:00Z trades', () => {
    expect(isWithinDailyClose(Date.UTC(2026, 8, 25, 20, 39, 59))).toBe(false);
    expect(isWithinDailyClose(Date.UTC(2026, 8, 25, 20, 40, 0))).toBe(true);
    expect(isWithinDailyClose(Date.UTC(2026, 8, 25, 21, 59, 59))).toBe(true);
    expect(isWithinDailyClose(Date.UTC(2026, 8, 25, 22, 0, 0))).toBe(false);
  });

  it('winter (UTC+2): 21:39:59Z trades, 21:40:00Z is closed, 22:59:59Z closed, 23:00:00Z trades', () => {
    expect(isWithinDailyClose(Date.UTC(2026, 11, 10, 21, 39, 59))).toBe(false);
    expect(isWithinDailyClose(Date.UTC(2026, 11, 10, 21, 40, 0))).toBe(true);
    expect(isWithinDailyClose(Date.UTC(2026, 11, 10, 22, 59, 59))).toBe(true);
    expect(isWithinDailyClose(Date.UTC(2026, 11, 10, 23, 0, 0))).toBe(false);
  });
});
