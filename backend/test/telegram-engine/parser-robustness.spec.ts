/**
 * The parser against the shapes this channel actually publishes in.
 *
 * The cases here are the ones the runtime specification calls out: mixed
 * case, multiline, Arabic text around the instruction, and — the important
 * half — sentences that mention gold and a direction word but are not orders.
 *
 * "Words alone are insufficient" is the rule being pinned down. Every
 * negative case below contains a symbol and a direction and must still not
 * trade, because it lacks the explicit entry, stop and target that make a
 * message an instruction rather than a comment.
 */
import { describe, expect, it } from 'vitest';
import { parseTelegramSignal } from '../../src/telegram-engine/parser';

describe('case and layout', () => {
  it.each([
    ['lower case labels', 'gold sell now 4338\nsl 4348\ntp 4329'],
    ['mixed case labels', 'Gold Sell Now 4338\nSl 4348\nTp 4329\nTp 4300'],
    ['upper case', 'GOLD SELL NOW 4338\nSL 4348\nTP 4329'],
    ['extra blank lines', 'Gold sell now 4338\n\n\nSL 4348\n\nTP 4329'],
    ['trailing spaces', 'Gold sell now 4338   \n  SL 4348  \n TP 4329 '],
    ['colon separators', 'Gold SELL: 4338\nSL: 4348\nTP: 4329'],
    ['all on one line', 'Gold sell now 4338 SL 4348 TP 4329'],
  ])('parses %s', (_label, text) => {
    const { signal } = parseTelegramSignal(text);
    expect(signal).not.toBeNull();
    expect(signal!.direction).toBe('SELL');
    expect(signal!.entry).toBe(4338);
    expect(signal!.stopLoss).toBe(4348);
    expect(signal!.takeProfits[0]).toBe(4329);
  });
});

describe('surrounding text in other languages', () => {
  it('parses an instruction wrapped in Arabic commentary', () => {
    const text = [
      'السلام عليكم',
      'Gold sell now 4338',
      'SL 4348',
      'TP 4329',
      'TP 4300',
      'بالتوفيق للجميع',
    ].join('\n');
    const { signal } = parseTelegramSignal(text);
    expect(signal).toEqual({ direction: 'SELL', entry: 4338, stopLoss: 4348, takeProfits: [4329, 4300] });
  });

  it('parses an instruction wrapped in English commentary', () => {
    const text = [
      'Gold looks heavy on the 15m after that rejection.',
      'Gold sell now 4338',
      'SL 4348',
      'TP 4329',
      'Manage your risk.',
    ].join('\n');
    expect(parseTelegramSignal(text).signal).not.toBeNull();
  });

  it('is not confused by numbers in the surrounding commentary', () => {
    const text = ['Yesterday we closed +250 pips from the 4400 area.', 'Gold sell now 4338', 'SL 4348', 'TP 4329'].join('\n');
    const { signal } = parseTelegramSignal(text);
    expect(signal!.entry).toBe(4338);
  });
});

describe('a direction word is not an instruction', () => {
  it.each([
    ['Gold is a good buy'],
    ['Nice sell'],
    ['TP hit'],
    ['Who bought gold?'],
    ['Close buy'],
    ['Gold buy setup forming, wait for confirmation'],
    ['We are still long gold from yesterday'],
    ['Congrats to everyone who took the gold sell'],
  ])('%s does not trade', (text) => {
    const { signal } = parseTelegramSignal(text);
    expect(signal).toBeNull();
  });

  it('refuses "Close buy" specifically, because close instructions are not implemented', () => {
    // If close instructions are ever added, they will be a deliberate,
    // separately specified feature. Until then this must not be read as an
    // order to open a buy.
    const { signal } = parseTelegramSignal('Close buy');
    expect(signal).toBeNull();
  });
});

describe('incomplete instructions are never completed from context', () => {
  it('does not borrow a stop from an earlier message', () => {
    // Each message is parsed alone. There is no state carried between
    // messages, which is what makes this impossible rather than unlikely.
    parseTelegramSignal('Gold sell now 4338\nSL 4348\nTP 4329');
    const second = parseTelegramSignal('Gold sell now 4340\nTP 4330');
    expect(second.signal).toBeNull();
    expect(second.refusal).toBe('STOP_LOSS_MISSING');
  });

  it('refuses a signal with a stop but no target', () => {
    expect(parseTelegramSignal('Gold buy 4300\nSL 4290').refusal).toBe('TAKE_PROFIT_MISSING');
  });
});

describe('single and multiple targets', () => {
  it('a one-target signal yields exactly one target', () => {
    const { signal } = parseTelegramSignal('Gold sell now 4338\nSL 4348\nTP 4329');
    expect(signal!.takeProfits).toEqual([4329]);
  });

  it('a two-target signal yields both, in published order', () => {
    const { signal } = parseTelegramSignal('Gold sell now 4338\nSL 4348\nTP 4329\nTP 4300');
    expect(signal!.takeProfits).toEqual([4329, 4300]);
  });

  it('a BUY with two targets parses symmetrically', () => {
    const { signal } = parseTelegramSignal('Gold buy now 4331\nSL 4321\nTP 4338\nTP 4350');
    expect(signal).toEqual({ direction: 'BUY', entry: 4331, stopLoss: 4321, takeProfits: [4338, 4350] });
  });
});
