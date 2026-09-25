/**
 * Engine B entry window (operator instruction, 2026-09-25):
 *
 *   SELL: entry - $1.00 <= executable price < SL
 *   BUY:  SL < executable price <= entry + $1.00
 *
 * The published TP and SL are never adjusted for the actual price. The TP1
 * latch still takes precedence over the window.
 */
import { describe, expect, it } from 'vitest';
import { planLegs } from '../../src/telegram-engine/legs';
import { parseTelegramSignal, type ParsedSignal } from '../../src/telegram-engine/parser';
import { entryWindow } from '../../src/telegram-engine/tp1';

function parse(text: string): ParsedSignal {
  const { signal } = parseTelegramSignal(text);
  if (!signal) throw new Error(`fixture failed to parse: ${text}`);
  return signal;
}

const CONSTRAINTS = { pointSize: 0.01, tickSize: 0.01, stopLevelPoints: 0, freezeLevelPoints: 0 };
// Production value of TELEGRAM_MAX_ADVERSE_ENTRY_DEVIATION_USD.
const MAX_ADVERSE = 50;

const SELL = parse('Gold sell now 4275\nSL 4285\nTP 4269');
const BUY = parse('Gold buy now 4275\nSL 4265\nTP 4281');

// A SELL fills at the bid, a BUY at the ask; the other side sits 0.20 away.
const sellAt = (bid: number) => planLegs({ signal: SELL, quote: { bid, ask: bid + 0.2 }, constraints: CONSTRAINTS, maxAdverseUsd: MAX_ADVERSE });
const buyAt = (ask: number) => planLegs({ signal: BUY, quote: { bid: ask - 0.2, ask }, constraints: CONSTRAINTS, maxAdverseUsd: MAX_ADVERSE });

describe('SELL 4275 / TP 4269 / SL 4285: window [4274, 4285)', () => {
  it.each([4274.0, 4274.8, 4275.0, 4276.0, 4280.0, 4284.99])('enters at %s', (price) => {
    const plan = sellAt(price);
    expect(plan.refusal).toBeNull();
    expect(plan.legs).toHaveLength(1);
  });

  it.each([4273.99, 4273.0, 4270.0])('does not enter at %s (more than $1 below the entry)', (price) => {
    const plan = sellAt(price);
    expect(plan.legs).toBeNull();
    expect(plan.refusal).toBe('TELEGRAM_ADVERSE_ENTRY_DEVIATION');
    expect(plan.favourable).toBe(true);
    expect(plan.detail).toContain('TELEGRAM_ENTRY_WINDOW_EXCEEDED');
  });

  it.each([4285.0, 4285.01, 4290.0])('does not enter at %s (at or beyond the SL)', (price) => {
    const plan = sellAt(price);
    expect(plan.legs).toBeNull();
    expect(plan.refusal).toBe('TELEGRAM_ADVERSE_ENTRY_DEVIATION');
    expect(plan.favourable).toBe(false);
    expect(plan.detail).toContain('TELEGRAM_SL_ALREADY_REACHED');
  });

  it('keeps the published TP and SL when entering at a different price', () => {
    const leg = sellAt(4280).legs![0];
    expect(leg.stopLoss).toBe(4285);
    expect(leg.takeProfit).toBe(4269);
    expect(leg.sourceEntry).toBe(4275);
  });

  it('reports the window it applied', () => {
    expect(entryWindow('SELL', 4275, 4285)).toEqual({ low: 4274, high: 4285, lowInclusive: true, highInclusive: false });
  });
});

describe('BUY 4275 / TP 4281 / SL 4265: window (4265, 4276]', () => {
  it.each([4276.0, 4275.5, 4275.0, 4270.0, 4265.01])('enters at %s', (price) => {
    const plan = buyAt(price);
    expect(plan.refusal).toBeNull();
    expect(plan.legs).toHaveLength(1);
  });

  it.each([4276.01, 4277.0])('does not enter at %s (more than $1 above the entry)', (price) => {
    const plan = buyAt(price);
    expect(plan.legs).toBeNull();
    expect(plan.refusal).toBe('TELEGRAM_ADVERSE_ENTRY_DEVIATION');
    expect(plan.favourable).toBe(true);
    expect(plan.detail).toContain('TELEGRAM_ENTRY_WINDOW_EXCEEDED');
  });

  it.each([4265.0, 4264.99, 4260.0])('does not enter at %s (at or beyond the SL)', (price) => {
    const plan = buyAt(price);
    expect(plan.legs).toBeNull();
    expect(plan.favourable).toBe(false);
    expect(plan.detail).toContain('TELEGRAM_SL_ALREADY_REACHED');
  });

  it('keeps the published TP and SL when entering at a different price', () => {
    const leg = buyAt(4270).legs![0];
    expect(leg.stopLoss).toBe(4265);
    expect(leg.takeProfit).toBe(4281);
  });

  it('reports the window it applied', () => {
    expect(entryWindow('BUY', 4275, 4265)).toEqual({ low: 4265, high: 4276, lowInclusive: false, highInclusive: true });
  });
});

describe('the TP1 latch still takes precedence over the window', () => {
  it('a SELL whose TP1 has been reached is spent, even though the entry allowance is irrelevant there', () => {
    // Closing side (ask) at 4269 = TP1 reached.
    const plan = planLegs({ signal: SELL, quote: { bid: 4268.8, ask: 4269.0 }, constraints: CONSTRAINTS, maxAdverseUsd: MAX_ADVERSE });
    expect(plan.refusal).toBe('TELEGRAM_TP1_ALREADY_REACHED');
  });

  it('a BUY whose TP1 has been reached is spent', () => {
    const plan = planLegs({ signal: BUY, quote: { bid: 4281.0, ask: 4281.2 }, constraints: CONSTRAINTS, maxAdverseUsd: MAX_ADVERSE });
    expect(plan.refusal).toBe('TELEGRAM_TP1_ALREADY_REACHED');
  });
});
