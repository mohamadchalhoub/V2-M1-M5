/**
 * One take-profit, one independent 0.01-lot position — and the refusals that
 * apply to the whole group rather than to a leg.
 */
import { describe, expect, it } from 'vitest';
import { groupMarginRequired, planLegs, validateLegVolume } from '../../src/telegram-engine/legs';
import { parseTelegramSignal, type ParsedSignal } from '../../src/telegram-engine/parser';
import { TELEGRAM_MAGIC } from '../../src/telegram-engine/safety-constants';
import { V2_MAGIC_M1, V2_MAGIC_M5 } from '../../src/xauusd-m1m5/safety-constants';

function parse(text: string): ParsedSignal {
  const { signal } = parseTelegramSignal(text);
  if (!signal) throw new Error(`fixture failed to parse: ${text}`);
  return signal;
}

const SIGNAL = parse('Gold sell now 4338\nSL 4348\nTP 4329\nTP 4300');

/** A broker with ordinary two-digit gold terms and no stop-distance minimum. */
const CONSTRAINTS = { pointSize: 0.01, tickSize: 0.01, stopLevelPoints: 0, freezeLevelPoints: 0 };

/** A market sitting exactly where the channel said to sell. */
const QUOTE = { bid: 4338.0, ask: 4338.3 };

describe('the worked example becomes one 0.01 leg per published target', () => {
  // SIGNAL is SELL 4338, SL 4348, TPs 4329/4300: two independent positions,
  // both with the published stop, each with its own published target.
  const plan = planLegs({ signal: SIGNAL, quote: QUOTE, constraints: CONSTRAINTS });

  it('opens one leg per published target', () => {
    expect(plan.legs).toHaveLength(2);
  });

  it('gives every leg 0.01 lot', () => {
    expect(plan.legs!.map((l) => l.volumeLots)).toEqual([0.01, 0.01]);
  });

  it('carries the SOURCE entry and the SOURCE stop unchanged on every leg', () => {
    for (const leg of plan.legs!) {
      expect(leg.sourceEntry).toBe(4338);
      expect(leg.stopLoss).toBe(4348);
      expect(leg.direction).toBe('SELL');
    }
  });

  it('assigns each published target to its own leg, in publication order', () => {
    expect(plan.legs!.map((l) => l.takeProfit)).toEqual([4329, 4300]);
    expect(plan.tp1).toBe(4329);
  });

  it('does not recompute the brackets from the live quote', () => {
    const leg = plan.legs![0];
    expect(leg.stopLoss - leg.sourceEntry).toBe(10);
  });

  it('stamps every leg with the Telegram magic number, never Engine A’s', () => {
    for (const leg of plan.legs!) {
      expect(leg.magicNumber).toBe(TELEGRAM_MAGIC);
      expect([V2_MAGIC_M1, V2_MAGIC_M5]).not.toContain(leg.magicNumber);
    }
  });

  it('numbers the legs 1 and 2', () => {
    expect(plan.legs!.map((l) => l.legIndex)).toEqual([1, 2]);
  });
});

describe('entry protection: up to $1 favourable is accepted, beyond that is refused', () => {
  // SIGNAL is SELL 4338, SL 4348, TPs 4329 / 4300. SELL window is
  // [entry - $1, SL) — see tp1.ts.
  it('refuses a market $4 BELOW the published entry, even though it is nearer the target', () => {
    const plan = planLegs({
      signal: SIGNAL,
      quote: { bid: 4334.0, ask: 4334.3 },
      constraints: CONSTRAINTS,
      maxAdverseUsd: 1.5,
    });
    expect(plan.legs).toBeNull();
    expect(plan.refusal).toBe('TELEGRAM_ADVERSE_ENTRY_DEVIATION');
    expect(plan.favourable).toBe(true);
    // Negative because it is favourable, not adverse — but still refused.
    expect(plan.deviationUsd).toBeCloseTo(-4, 6);
  });

  it('accepts a SELL exactly $1 better (the edge of the favourable allowance)', () => {
    const plan = planLegs({
      signal: SIGNAL,
      quote: { bid: 4337.0, ask: 4337.3 },
      constraints: CONSTRAINTS,
      maxAdverseUsd: 1.5,
    });
    expect(plan.legs).not.toBeNull();
    expect(plan.favourable).toBe(true);
  });

  it.each([
    ['$1.01 better', 4336.99],
    ['$3 better', 4335.0],
    ['$8 better, just short of the first target', 4330.0],
  ])('refuses a SELL %s', (_label, bid) => {
    const plan = planLegs({
      signal: SIGNAL,
      quote: { bid, ask: bid + 0.3 },
      constraints: CONSTRAINTS,
      maxAdverseUsd: 1.5,
    });
    expect(plan.legs).toBeNull();
    expect(plan.refusal).toBe('TELEGRAM_ADVERSE_ENTRY_DEVIATION');
  });

  it('accepts a SELL exactly at the published entry', () => {
    const plan = planLegs({
      signal: SIGNAL,
      quote: { bid: 4338.0, ask: 4338.3 },
      constraints: CONSTRAINTS,
      maxAdverseUsd: 1.5,
    });
    expect(plan.legs).not.toBeNull();
  });

  it('refuses a market materially WORSE than published', () => {
    const plan = planLegs({
      signal: SIGNAL,
      quote: { bid: 4341.0, ask: 4341.3 }, // $3 above entry: adverse for a SELL
      constraints: CONSTRAINTS,
      maxAdverseUsd: 1.5,
    });
    expect(plan.legs).toBeNull();
    expect(plan.refusal).toBe('TELEGRAM_ADVERSE_ENTRY_DEVIATION');
    expect(plan.favourable).toBe(false);
  });

  it('accepts adverse movement inside the bound', () => {
    const plan = planLegs({
      signal: SIGNAL,
      quote: { bid: 4339.0, ask: 4339.3 }, // $1 adverse, under the $1.50 bound
      constraints: CONSTRAINTS,
      maxAdverseUsd: 1.5,
    });
    expect(plan.legs).not.toBeNull();
    expect(plan.deviationUsd).toBeCloseTo(1, 6);
  });

  it('mirrors for a BUY: above entry is favourable and now refused too, below is adverse', () => {
    const buy = parse('Gold buy now 4331\nSL 4321\nTP 4338\nTP 4350');
    const better = planLegs({
      signal: buy,
      quote: { bid: 4333.7, ask: 4334.0 }, // BUY fills at ask: $3 above entry
      constraints: CONSTRAINTS,
      maxAdverseUsd: 1.5,
    });
    expect(better.legs).toBeNull();
    expect(better.refusal).toBe('TELEGRAM_ADVERSE_ENTRY_DEVIATION');
    expect(better.favourable).toBe(true);

    const worse = planLegs({
      signal: buy,
      quote: { bid: 4327.7, ask: 4328.0 }, // $3 below entry
      constraints: CONSTRAINTS,
      maxAdverseUsd: 1.5,
    });
    expect(worse.refusal).toBe('TELEGRAM_ADVERSE_ENTRY_DEVIATION');
  });

  it('measures against the side the order actually fills at', () => {
    // A SELL fills at the bid, so the bid is what is compared. Here the bid
    // is $1.10 favourable (outside the $1 allowance) while the ask is not.
    const plan = planLegs({
      signal: SIGNAL,
      quote: { bid: 4336.9, ask: 4340.0 },
      constraints: CONSTRAINTS,
      maxAdverseUsd: 1.5,
    });
    expect(plan.executablePrice).toBe(4336.9);
    expect(plan.legs).toBeNull();
    expect(plan.favourable).toBe(true);
  });
});

describe('a leg the broker would reject refuses the whole signal', () => {
  it('refuses rather than opening the far leg alone', () => {
    // A 500-point (= $5) minimum stop distance: the near target at 4329 sits
    // $9 away and is fine, but tighten the requirement past it and the whole
    // signal goes.
    const plan = planLegs({
      signal: SIGNAL,
      quote: QUOTE,
      constraints: { ...CONSTRAINTS, stopLevelPoints: 1500 }, // $15
    });
    expect(plan.legs).toBeNull();
    expect(plan.refusal).toBe('TELEGRAM_BROKER_STOPS_REFUSED');
    expect(plan.detail).toMatch(/whole signal is refused|NOT widened/i);
  });

  it('never widens the published stop to fit the broker minimum', () => {
    const plan = planLegs({ signal: SIGNAL, quote: QUOTE, constraints: { ...CONSTRAINTS, stopLevelPoints: 1500 } });
    expect(plan.detail).toMatch(/NOT widened/);
  });

  it('refuses an unusable point size rather than guessing one', () => {
    const plan = planLegs({ signal: SIGNAL, quote: QUOTE, constraints: { ...CONSTRAINTS, pointSize: 0 } });
    expect(plan.refusal).toBe('TELEGRAM_INVALID_CONSTRAINTS');
  });
});

describe('volume', () => {
  it('accepts the 0.01 leg size', () => {
    expect(validateLegVolume(0.01)).toBeNull();
  });

  it.each([
    ['below the broker minimum', 0.005],
    ['off the broker step', 0.015],
    ['above the broker maximum', 500],
    ['not a number', Number.NaN],
  ])('refuses a volume %s rather than rounding it into range', (_label, lots) => {
    expect(validateLegVolume(lots)).not.toBeNull();
  });
});

describe('margin is checked for the group, not per leg', () => {
  const legs = planLegs({ signal: SIGNAL, quote: QUOTE, constraints: CONSTRAINTS }).legs!;

  it('computes margin from the leg using MT5’s own formula', () => {
    // Two 0.01 legs, so the group margin is the sum of both.
    const margin = groupMarginRequired(legs, 100, 4338, 100);
    expect(margin).toBeCloseTo((2 * 0.01 * 100 * 4338) / 100, 6);
  });

  it('returns Infinity on unknown leverage, so the comparison refuses', () => {
    expect(groupMarginRequired(legs, 100, 4338, null)).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns Infinity on an unknown contract size', () => {
    expect(groupMarginRequired(legs, 0, 4338, 100)).toBe(Number.POSITIVE_INFINITY);
  });
});
