/**
 * The risk gate (spec §10).
 *
 * The rule under test throughout is that this gate REJECTS rather than
 * adjusts. Every case below checks that a problem produces a refusal, not a
 * quietly resized order, a widened stop, or a trade sized down to fit a cap.
 */
import { describe, expect, it } from 'vitest';
import { buildRsiBracket, evaluateRsiRiskManager, RsiRiskManagerInput } from '../../src/xauusd-rsi/risk-manager';
import { RSI_GOLD_POINT_SIZE, RSI_SL_POINTS, RSI_TP_POINTS } from '../../src/xauusd-rsi/safety-constants';

const ENTRY = 4345.0;

/** A healthy baseline: DEMO, ample equity, real broker limits, nothing blocking. */
function baseInput(overrides: Partial<RsiRiskManagerInput> = {}): RsiRiskManagerInput {
  const { stopLoss, takeProfit } = buildRsiBracket('OPEN_SELL', ENTRY, 5, 5);
  return {
    candidate: {
      action: 'OPEN_SELL',
      entryPrice: ENTRY,
      stopLoss,
      takeProfit,
      stopLossDistancePoints: RSI_SL_POINTS,
      takeProfitDistancePoints: RSI_TP_POINTS,
    },
    accountInfo: {
      tradeMode: 'DEMO',
      marginMode: 'RETAIL_HEDGING',
      equity: 49998.54,
      accountCurrency: 'EUR',
      profitCurrency: 'USD',
      profitCurrencyToAccountCurrencyRate: 1 / 1.15336,
      contractSize: 100,
      existingCombinedRiskAmount: 0,
      todaysLossAmount: 0,
      currentDrawdownPct: 0,
    },
    occupancy: { hasExistingXauusdExposure: false, exposureDescription: null },
    constraints: { minLots: 0.01, maxLots: 100, stepLots: 0.01, stopsLevelPoints: 0, freezeLevelPoints: 0, tickSize: 0.01 },
    killSwitchActive: false,
    entriesBlockedReason: null,
    entryDeviationPoints: 0,
    maxEntryDeviationPoints: 100,
    requestedVolumeLots: 0.5,
    pointSize: RSI_GOLD_POINT_SIZE,
    otherFamilySlotHeld: false,
    ...overrides,
  };
}

describe('The happy path', () => {
  it('approves a correctly-formed order on a DEMO account', () => {
    const v = evaluateRsiRiskManager(baseInput());
    expect(v.approved).toBe(true);
    expect(v.volumeLots).toBe(0.5);
    expect(v.rejectionReason).toBeNull();
  });

  it('sizes stop risk from the real contract size, not a points approximation', () => {
    // $5 x 100 oz x 0.5 lots = $250, converted to EUR at ~1.15336 = ~E216.76
    const v = evaluateRsiRiskManager(baseInput());
    expect(v.stopRiskAmount).toBeCloseTo(216.76, 1);
    expect(v.stopRiskPct).toBeCloseTo(0.4335, 3);
  });

  it("confirms the 0.5 lot default sits inside the preserved 0.5% per-trade cap at this account's equity", () => {
    // Recorded deliberately: this is the fact that makes the specified
    // default volume usable at all. At materially lower equity it would be
    // rejected, and that rejection would be correct.
    const v = evaluateRsiRiskManager(baseInput());
    expect(v.approved).toBe(true);
    expect(v.stopRiskPct!).toBeLessThan(0.5);
  });
});

describe('The DEMO gate', () => {
  it('refuses a REAL account outright', () => {
    const v = evaluateRsiRiskManager(baseInput({ accountInfo: { ...baseInput().accountInfo, tradeMode: 'REAL' } }));
    expect(v.approved).toBe(false);
    expect(v.rejectionReason).toMatch(/not DEMO/);
  });

  it('refuses a CONTEST account too', () => {
    const v = evaluateRsiRiskManager(baseInput({ accountInfo: { ...baseInput().accountInfo, tradeMode: 'CONTEST' } }));
    expect(v.approved).toBe(false);
  });
});

describe('Controls and occupancy', () => {
  it('refuses while the kill switch is active', () => {
    const v = evaluateRsiRiskManager(baseInput({ killSwitchActive: true }));
    expect(v.rejectionReason).toMatch(/Kill switch/);
  });

  it('refuses while any control blocks entries, preserving the reason', () => {
    const v = evaluateRsiRiskManager(baseInput({ entriesBlockedReason: 'STOP NEW ENTRIES is active (file X).' }));
    expect(v.rejectionReason).toMatch(/STOP NEW ENTRIES/);
  });

  it('refuses when the occupancy resolver reports this family’s slot unavailable', () => {
    const v = evaluateRsiRiskManager(
      baseInput({ occupancy: { hasExistingXauusdExposure: true, exposureDescription: 'foreign position (magic 999)' } }),
    );
    expect(v.approved).toBe(false);
    expect(v.rejectionReason).toMatch(/foreign position/);
  });
});

describe('Hedging vs netting — the second concurrent position', () => {
  it('allows a second concurrent position on a RETAIL_HEDGING account', () => {
    const v = evaluateRsiRiskManager(baseInput({ otherFamilySlotHeld: true }));
    expect(v.approved).toBe(true);
  });

  it('refuses a second concurrent position on a NETTING account, rather than emulating it', () => {
    const v = evaluateRsiRiskManager(
      baseInput({ otherFamilySlotHeld: true, accountInfo: { ...baseInput().accountInfo, marginMode: 'RETAIL_NETTING' } }),
    );
    expect(v.approved).toBe(false);
    expect(v.rejectionReason).toMatch(/RETAIL_NETTING/);
    expect(v.rejectionReason).toMatch(/merge with, reduce or reverse/);
  });

  it('refuses when the margin mode could not be established, and says so distinctly', () => {
    const v = evaluateRsiRiskManager(
      baseInput({ otherFamilySlotHeld: true, accountInfo: { ...baseInput().accountInfo, marginMode: 'UNKNOWN' } }),
    );
    expect(v.approved).toBe(false);
    expect(v.rejectionReason).toMatch(/could not be established/);
    expect(v.rejectionReason).not.toMatch(/RETAIL_NETTING/);
  });

  it('does not apply the hedging requirement to the FIRST position', () => {
    // With no other slot held, a netting account is perfectly able to open one
    // position, so the check must not fire.
    const v = evaluateRsiRiskManager(
      baseInput({ otherFamilySlotHeld: false, accountInfo: { ...baseInput().accountInfo, marginMode: 'RETAIL_NETTING' } }),
    );
    expect(v.approved).toBe(true);
  });
});

describe('Volume validation — never resized', () => {
  it('refuses a volume below the broker minimum rather than raising it', () => {
    const v = evaluateRsiRiskManager(baseInput({ requestedVolumeLots: 0.005 }));
    expect(v.rejectionReason).toMatch(/never auto-resizing/);
    expect(v.volumeLots).toBeNull();
  });

  it('refuses a volume above the broker maximum rather than capping it', () => {
    const v = evaluateRsiRiskManager(baseInput({ requestedVolumeLots: 500 }));
    expect(v.rejectionReason).toMatch(/never auto-resizing/);
  });

  it('refuses a volume off the broker step rather than rounding it', () => {
    const v = evaluateRsiRiskManager(baseInput({ requestedVolumeLots: 0.505 }));
    expect(v.rejectionReason).toMatch(/not a multiple of the broker's step/);
  });

  it('refuses a non-finite volume before doing any risk arithmetic', () => {
    const v = evaluateRsiRiskManager(baseInput({ requestedVolumeLots: Number.NaN }));
    expect(v.rejectionReason).toMatch(/not a valid positive number/);
  });

  it('refuses when broker constraints are unavailable (fail-closed sentinel values)', () => {
    const v = evaluateRsiRiskManager(
      baseInput({ constraints: { minLots: Number.POSITIVE_INFINITY, maxLots: 0, stepLots: 1, stopsLevelPoints: null, freezeLevelPoints: null, tickSize: null } }),
    );
    expect(v.approved).toBe(false);
  });
});

describe('Bracket validation — the $5 stop is never widened', () => {
  it('refuses a stop distance that is not $5', () => {
    const input = baseInput();
    const v = evaluateRsiRiskManager({
      ...input,
      candidate: { ...input.candidate, stopLossDistancePoints: 1000 },
    });
    expect(v.rejectionReason).toMatch(/does not match the required/);
  });

  it('refuses when the broker stops level would swallow the $5 stop, instead of widening it', () => {
    // A broker demanding 600 points (= $6) minimum distance makes a $5 stop
    // illegal. The correct response is to refuse the trade entirely.
    const v = evaluateRsiRiskManager(
      baseInput({ constraints: { ...baseInput().constraints, stopsLevelPoints: 600 } }),
    );
    expect(v.approved).toBe(false);
    expect(v.rejectionReason).toMatch(/never widened/);
  });

  it('refuses when the broker stops level is unknown rather than assuming $5 is acceptable', () => {
    const v = evaluateRsiRiskManager(
      baseInput({ constraints: { ...baseInput().constraints, stopsLevelPoints: null } }),
    );
    expect(v.rejectionReason).toMatch(/stops level is unknown/);
  });

  it('refuses a bracket price the broker would round to its tick size', () => {
    const input = baseInput();
    const v = evaluateRsiRiskManager({
      ...input,
      candidate: { ...input.candidate, stopLoss: 4350.005 },
      constraints: { ...input.constraints, tickSize: 0.01 },
    });
    expect(v.rejectionReason).toMatch(/tick size/);
  });

  it('refuses a bracket on the wrong side of entry', () => {
    const input = baseInput();
    const v = evaluateRsiRiskManager({
      ...input,
      candidate: { ...input.candidate, action: 'OPEN_BUY', stopLoss: ENTRY + 5, takeProfit: ENTRY - 5 },
    });
    expect(v.rejectionReason).toMatch(/wrong side of entry/);
  });

  it('builds correct brackets for both directions, matching the specified examples', () => {
    // Spec §7: SELL at 4450 -> TP 4445, SL 4455; BUY at 4450 -> TP 4455, SL 4445.
    expect(buildRsiBracket('OPEN_SELL', 4450, 5, 5)).toEqual({ takeProfit: 4445, stopLoss: 4455 });
    expect(buildRsiBracket('OPEN_BUY', 4450, 5, 5)).toEqual({ takeProfit: 4455, stopLoss: 4445 });
  });
});

describe('Price drift', () => {
  it('refuses rather than chasing when the executable price has moved too far', () => {
    const v = evaluateRsiRiskManager(baseInput({ entryDeviationPoints: 150, maxEntryDeviationPoints: 100 }));
    expect(v.rejectionReason).toMatch(/skipping, not chasing/);
  });

  it('allows drift exactly at the limit', () => {
    const v = evaluateRsiRiskManager(baseInput({ entryDeviationPoints: 100, maxEntryDeviationPoints: 100 }));
    expect(v.approved).toBe(true);
  });
});

describe('Currency and equity', () => {
  it('refuses to assume 1:1 when a conversion is needed but unavailable', () => {
    const v = evaluateRsiRiskManager(
      baseInput({ accountInfo: { ...baseInput().accountInfo, profitCurrencyToAccountCurrencyRate: null } }),
    );
    expect(v.rejectionReason).toMatch(/never assuming 1:1/);
  });

  it('needs no conversion when the currencies already match, and a missing rate is then irrelevant', () => {
    // Equity is raised above the live account's figure on purpose. In USD the
    // same $250 stop against ~$50,000 is 0.50005% of equity, which is over the
    // 0.5% cap — the EUR account only clears it because the conversion shrinks
    // the risk to ~E216.76. That is a genuine property of the caps, not a
    // quirk of this test, so the case is isolated from it here.
    const v = evaluateRsiRiskManager(
      baseInput({ accountInfo: { ...baseInput().accountInfo, equity: 60000, accountCurrency: 'USD', profitCurrencyToAccountCurrencyRate: null } }),
    );
    expect(v.approved).toBe(true);
    expect(v.stopRiskAmount).toBeCloseTo(250, 6);
  });

  it('shows how close the 0.5 lot default sits to the per-trade cap in USD terms', () => {
    // Recorded because it matters operationally: at ~$50,000 equity the
    // specified 0.5 lot default is marginally OVER the preserved 0.5% cap
    // when no currency conversion applies, and is correctly refused.
    const v = evaluateRsiRiskManager(
      baseInput({ accountInfo: { ...baseInput().accountInfo, equity: 49998.54, accountCurrency: 'USD', profitCurrencyToAccountCurrencyRate: null } }),
    );
    expect(v.approved).toBe(false);
    expect(v.rejectionReason).toMatch(/per-trade cap/);
  });

  it('refuses when the contract size is unknown rather than assuming one', () => {
    const v = evaluateRsiRiskManager(baseInput({ accountInfo: { ...baseInput().accountInfo, contractSize: null } }));
    expect(v.rejectionReason).toMatch(/contract size is unavailable/);
  });

  it('refuses to size risk against non-positive equity', () => {
    const v = evaluateRsiRiskManager(baseInput({ accountInfo: { ...baseInput().accountInfo, equity: 0 } }));
    expect(v.rejectionReason).toMatch(/non-positive or unavailable account equity/);
  });
});

describe('Risk caps — the trade is skipped, never shrunk', () => {
  it('refuses when the per-trade stop risk exceeds the cap', () => {
    // Same 0.5 lots against a much smaller account.
    const v = evaluateRsiRiskManager(baseInput({ accountInfo: { ...baseInput().accountInfo, equity: 10000 } }));
    expect(v.approved).toBe(false);
    expect(v.rejectionReason).toMatch(/per-trade cap/);
    expect(v.rejectionReason).toMatch(/never reduced to fit|Volume is never reduced/);
  });

  it('refuses when combined open risk would exceed the cap', () => {
    const v = evaluateRsiRiskManager(
      baseInput({ accountInfo: { ...baseInput().accountInfo, existingCombinedRiskAmount: 400 } }),
    );
    expect(v.rejectionReason).toMatch(/combined cap/);
  });

  it("refuses once today's loss has reached the daily cap", () => {
    const v = evaluateRsiRiskManager(
      baseInput({ accountInfo: { ...baseInput().accountInfo, todaysLossAmount: 49998.54 * 0.02 } }),
    );
    expect(v.rejectionReason).toMatch(/daily cap/);
  });

  it('refuses once drawdown has reached the cap', () => {
    const v = evaluateRsiRiskManager(baseInput({ accountInfo: { ...baseInput().accountInfo, currentDrawdownPct: 5 } }));
    expect(v.rejectionReason).toMatch(/drawdown/);
  });
});
