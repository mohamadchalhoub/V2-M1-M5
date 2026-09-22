/**
 * What the parser accepts, and — mostly — what it refuses.
 *
 * The refusal cases outnumber the acceptance cases deliberately. A parser
 * that is too permissive opens real positions from a sentence that was never
 * an order, and no later check can undo that: freshness, duplicates and
 * availability all assume the message WAS a trade instruction.
 */
import { describe, expect, it } from 'vitest';
import { parseTelegramSignal } from '../../src/telegram-engine/parser';

describe('the worked example from the specification', () => {
  const text = ['Gold sell now 4338', 'SL 4348', 'TP 4329', 'TP 4300'].join('\n');

  it('parses into one SELL at 4338 with two targets, in published order', () => {
    const { signal, refusal } = parseTelegramSignal(text);
    expect(refusal).toBeNull();
    expect(signal).toEqual({ direction: 'SELL', entry: 4338, stopLoss: 4348, takeProfits: [4329, 4300] });
  });
});

describe('accepted variations of the same instruction', () => {
  it.each([
    ['labelled entry', 'XAUUSD BUY\nEntry: 4300\nSL: 4290\nTP1: 4310\nTP2: 4320'],
    ['at-sign entry', 'Gold buy @4300\nStop loss 4290\nTake profit 4310'],
    ['thousands separator', 'Gold sell 4,338\nSL 4,348\nTP 4,329'],
    ['decimals', 'Gold sell 4338.50\nSL 4348.25\nTP 4329.75'],
    ['emoji and bullets', '🔴 GOLD SELL NOW 4338 🔴\n🛑 SL 4348\n🎯 TP 4329'],
    ['long/short wording', 'Gold short 4338\nSL 4348\nTarget 4329'],
  ])('%s', (_label, text) => {
    expect(parseTelegramSignal(text).signal).not.toBeNull();
  });

  it('carries every published target through as its own future leg', () => {
    const text = 'Gold buy 4300\nSL 4290\nTP1 4305\nTP2 4310\nTP3 4315';
    expect(parseTelegramSignal(text).signal?.takeProfits).toEqual([4305, 4310, 4315]);
  });
});

describe('messages that are not orders', () => {
  it.each([
    ['empty', ''],
    ['chat', 'Good morning traders, big week ahead'],
    ['results post', 'Gold TP 4329 hit! +90 pips, well done everyone'],
  ])('%s is refused', (_label, text) => {
    expect(parseTelegramSignal(text).signal).toBeNull();
  });

  it('refuses a results post specifically for lacking an instruction, not for lacking numbers', () => {
    const r = parseTelegramSignal('Gold TP 4329 hit! Closed in profit');
    expect(r.refusal).toBe('DIRECTION_MISSING');
  });

  it('refuses another symbol even when perfectly formatted', () => {
    const r = parseTelegramSignal('EURUSD sell 1.0850\nSL 1.0880\nTP 1.0800');
    expect(r.refusal).toBe('SYMBOL_NOT_GOLD');
  });
});

describe('incomplete instructions are refused, never completed', () => {
  it('refuses a signal with no stop loss rather than deriving one', () => {
    const r = parseTelegramSignal('Gold sell now 4338\nTP 4329');
    expect(r.refusal).toBe('STOP_LOSS_MISSING');
  });

  it('refuses a signal with no target', () => {
    const r = parseTelegramSignal('Gold sell now 4338\nSL 4348');
    expect(r.refusal).toBe('TAKE_PROFIT_MISSING');
  });

  it('refuses a signal with no entry rather than assuming market', () => {
    const r = parseTelegramSignal('Gold sell\nSL 4348\nTP 4329');
    expect(r.refusal).toBe('ENTRY_MISSING');
  });

  it('refuses a message containing both buy and sell rather than choosing', () => {
    const r = parseTelegramSignal('Gold buy 4300 and sell 4400\nSL 4290\nTP 4310');
    expect(r.refusal).toBe('DIRECTION_AMBIGUOUS');
  });
});

describe('numbers that are not prices', () => {
  it('never reads an ordinal label as a protective level', () => {
    // "TP 1 / TP 2" with no prices attached. A single digit is not a price
    // token at all, so no target is found and the signal is refused whole —
    // which is the outcome that matters. What must never happen is a stop or
    // target placed at $1.
    const r = parseTelegramSignal('Gold sell 4338\nSL 4348\nTP 1\nTP 2');
    expect(r.signal).toBeNull();
    expect(r.refusal).toBe('TAKE_PROFIT_MISSING');
  });

  it('refuses a price-shaped number that is not a plausible gold price', () => {
    const r = parseTelegramSignal('Gold sell 4338\nSL 4348\nTP 100');
    expect(r.signal).toBeNull();
    expect(r.refusal).toBe('IMPLAUSIBLE_PRICE');
  });

  it('refuses a duplicated target rather than opening two identical legs', () => {
    const r = parseTelegramSignal('Gold sell 4338\nSL 4348\nTP 4329\nTP 4329');
    expect(r.refusal).toBe('DUPLICATE_TAKE_PROFIT');
  });

  it('refuses more targets than the engine will open at once', () => {
    const tps = [4330, 4320, 4310, 4300, 4290, 4280, 4270].map((t) => `TP ${t}`).join('\n');
    const r = parseTelegramSignal(`Gold sell 4338\nSL 4348\n${tps}`);
    expect(r.refusal).toBe('TOO_MANY_TAKE_PROFITS');
  });
});

describe('geometry', () => {
  it('refuses a SELL whose stop sits below entry', () => {
    const r = parseTelegramSignal('Gold sell 4338\nSL 4300\nTP 4280');
    expect(r.refusal).toBe('STOP_LOSS_ON_WRONG_SIDE');
  });

  it('refuses a BUY whose target sits below entry', () => {
    const r = parseTelegramSignal('Gold buy 4338\nSL 4328\nTP 4300');
    expect(r.refusal).toBe('TAKE_PROFIT_ON_WRONG_SIDE');
  });
});

describe('the entry is never a second reading of another level', () => {
  it('does not resolve the entry to the stop when the entry follows the direction word', () => {
    const { signal } = parseTelegramSignal('Gold sell now 4338\nSL 4348\nTP 4329');
    expect(signal?.entry).toBe(4338);
    expect(signal?.stopLoss).toBe(4348);
  });

  it('prefers the price beside the direction word over the first number in the message', () => {
    const { signal } = parseTelegramSignal('Gold update 4400 zone watched\nsell now 4338\nSL 4348\nTP 4329');
    expect(signal?.entry).toBe(4338);
  });
});
