/**
 * The first target: how it is identified, and why reaching it ends the signal
 * permanently.
 *
 * The specification's worked example is used verbatim throughout —
 * SELL 4338, TP1 4329 — with the mirrored BUY case beside it, because the two
 * directions are the place this logic is easiest to get backwards.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateEntryDeviation,
  firstTarget,
  initialTp1State,
  observeTp1,
  reachesFirstTarget,
} from '../../src/telegram-engine/tp1';
import { planLegs } from '../../src/telegram-engine/legs';
import { parseTelegramSignal, type ParsedSignal } from '../../src/telegram-engine/parser';

function parse(text: string): ParsedSignal {
  const { signal } = parseTelegramSignal(text);
  if (!signal) throw new Error(`fixture failed to parse: ${text}`);
  return signal;
}

const SELL = parse('Gold sell now 4338\nSL 4348\nTP 4329\nTP 4300');
const BUY = parse('Gold buy now 4331\nSL 4321\nTP 4338\nTP 4350');
const CONSTRAINTS = { pointSize: 0.01, tickSize: 0.01, stopLevelPoints: 0, freezeLevelPoints: 0 };

describe('identifying TP1', () => {
  it('SELL 4338 with targets 4329 and 4300 has TP1 4329', () => {
    expect(firstTarget('SELL', SELL.takeProfits)).toBe(4329);
  });

  it('BUY 4331 with targets 4338 and 4350 has TP1 4338', () => {
    expect(firstTarget('BUY', BUY.takeProfits)).toBe(4338);
  });

  it('is the nearest target, not the first one listed', () => {
    // A channel that published its targets furthest-first must not make the
    // engine treat 4300 as the level that cancels the signal.
    expect(firstTarget('SELL', [4300, 4329])).toBe(4329);
    expect(firstTarget('BUY', [4350, 4338])).toBe(4338);
  });

  it('handles a single-target signal', () => {
    expect(firstTarget('SELL', [4329])).toBe(4329);
  });
});

describe('when TP1 counts as reached', () => {
  it.each([
    [4338, false],
    [4337, false],
    [4335, false],
    [4330, false],
    [4329, true],
    [4328, true],
    [4300, true],
  ])('SELL TP1 4329 at price %s -> reached=%s', (price, expected) => {
    expect(reachesFirstTarget('SELL', 4329, price)).toBe(expected);
  });

  it.each([
    [4331, false],
    [4335, false],
    [4337, false],
    [4338, true],
    [4339, true],
  ])('BUY TP1 4338 at price %s -> reached=%s', (price, expected) => {
    expect(reachesFirstTarget('BUY', 4338, price)).toBe(expected);
  });
});

describe('the touch is a latch', () => {
  it('stays touched after price retraces back through the level', () => {
    let state = initialTp1State('SELL', SELL.takeProfits);
    state = observeTp1(state, 'SELL', { bid: 4334.7, ask: 4335.0, atMs: 1 });
    expect(state.touched).toBe(false);

    state = observeTp1(state, 'SELL', { bid: 4327.7, ask: 4328.0, atMs: 2 });
    expect(state.touched).toBe(true);
    expect(state.touchPrice).toBe(4328.0);

    // Retrace to 4334 — well away from the target.
    state = observeTp1(state, 'SELL', { bid: 4333.7, ask: 4334.0, atMs: 3 });
    expect(state.touched).toBe(true);
    expect(state.touchedAtMs).toBe(2);
  });

  it('checks the side the target would actually trigger on', () => {
    // A SELL is closed by buying, at the ask. Checking the bid would declare
    // the target reached a whole spread early.
    const state = initialTp1State('SELL', SELL.takeProfits);
    const nearlyThere = observeTp1(state, 'SELL', { bid: 4328.8, ask: 4329.1, atMs: 1 });
    expect(nearlyThere.touched).toBe(false);
  });
});

describe('a spent signal opens nothing', () => {
  it('cancels the whole group once price has reached TP1', () => {
    const plan = planLegs({
      signal: SELL,
      quote: { bid: 4328.7, ask: 4329.0 },
      constraints: CONSTRAINTS,
      maxAdverseUsd: 1.5,
    });
    expect(plan.legs).toBeNull();
    expect(plan.refusal).toBe('TELEGRAM_TP1_ALREADY_REACHED');
  });

  it('cancels on the recorded latch even when the current quote has retraced', () => {
    const plan = planLegs({
      signal: SELL,
      // 4334 is a perfectly good entry for this signal on its own terms.
      quote: { bid: 4333.7, ask: 4334.0 },
      constraints: CONSTRAINTS,
      maxAdverseUsd: 1.5,
      tp1AlreadyTouched: true,
    });
    expect(plan.legs).toBeNull();
    expect(plan.refusal).toBe('TELEGRAM_TP1_ALREADY_REACHED');
    expect(plan.detail).toMatch(/already reached|since retraced/i);
  });

  it('does not open the far leg alone: TP2 is not a consolation trade', () => {
    const plan = planLegs({
      signal: SELL,
      quote: { bid: 4328.7, ask: 4329.0 },
      constraints: CONSTRAINTS,
      maxAdverseUsd: 1.5,
    });
    expect(plan.legs).toBeNull();
  });

  it('mirrors for a BUY, which is closed at the BID', () => {
    const plan = planLegs({
      signal: BUY,
      // The bid is what a long position's target triggers on, so the bid is
      // what must reach 4338 — not the ask.
      quote: { bid: 4338.0, ask: 4338.3 },
      constraints: CONSTRAINTS,
      maxAdverseUsd: 1.5,
    });
    expect(plan.refusal).toBe('TELEGRAM_TP1_ALREADY_REACHED');
  });
});

describe('the two bounds together', () => {
  it('accepts the whole favourable range between entry and TP1, and nothing past it', () => {
    const outcomes = [4338, 4337, 4335, 4331, 4330, 4329.01, 4329, 4328].map((bid) => ({
      bid,
      refusal: planLegs({
        signal: SELL,
        quote: { bid, ask: bid + 0.3 },
        constraints: CONSTRAINTS,
        maxAdverseUsd: 1.5,
      }).refusal,
    }));

    // Everything from the entry down to just above TP1 is tradable...
    for (const o of outcomes.filter((x) => x.bid > 4329)) {
      expect(o.refusal).toBeNull();
    }
    // ...and at or below TP1 the signal is finished. (The ask leads the bid,
    // so 4329.01 bid is already 4329.31 ask — past the target.)
    expect(outcomes.find((o) => o.bid === 4328)!.refusal).toBe('TELEGRAM_TP1_ALREADY_REACHED');
  });
});

describe('the deviation verdict itself', () => {
  it('reports favourable movement as negative adverse, not as a large deviation', () => {
    const v = evaluateEntryDeviation('SELL', 4338, 4330, 1.5);
    expect(v.acceptable).toBe(true);
    expect(v.favourable).toBe(true);
    expect(v.adverseUsd).toBeCloseTo(-8, 6);
  });

  it('explains a refusal in terms an operator can act on', () => {
    const v = evaluateEntryDeviation('SELL', 4338, 4342, 1.5);
    expect(v.acceptable).toBe(false);
    expect(v.detail).toMatch(/WORSE/);
  });

  it('treats the bound as inclusive', () => {
    expect(evaluateEntryDeviation('SELL', 4338, 4339.5, 1.5).acceptable).toBe(true);
    expect(evaluateEntryDeviation('SELL', 4338, 4339.51, 1.5).acceptable).toBe(false);
  });
});
