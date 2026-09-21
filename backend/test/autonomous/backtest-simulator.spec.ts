import { describe, expect, it } from 'vitest';
import { runBacktest, runBacktestNoLookahead, runBacktestWithConfirmation, resolveOutcomeSideAware, OpenPosition } from '../../src/autonomous/backtest-simulator';
import { AutonomousRulesConfig } from '../../src/autonomous/autonomous-rules.config';
import { CandleData } from '../../src/market-data/historical-candle.service';

function candle(openTime: string, high: number, low: number, close?: number): CandleData {
  return { openTime: new Date(openTime), open: (high + low) / 2, high, low, close: close ?? (high + low) / 2, volume: null };
}

function config(overrides: Partial<AutonomousRulesConfig> = {}): AutonomousRulesConfig {
  return {
    referenceTimeframe: 'H4',
    takeProfitPoints: 180,
    stopLossPoints: 180,
    entryRetracePoints: 50,
    levelBreakOvershootPoints: 50,
    volatilityFilterMaxPoints: 500,
    volatilityFilterWindowHours: 2,
    confluenceTolerancePoints: 50,
    maxOrdersPerDay: 1,
    ...overrides,
  };
}

// Reference week 2026-08-31 .. 2026-09-07 (exclusive): H4 sets support=1.099/resistance=1.105;
// D1 sets a confirming level within tolerance on both sides.
const h4 = [candle('2026-09-02T00:00:00Z', 1.105, 1.099)];
const d1Confirming = [candle('2026-09-02T00:00:00Z', 1.10505, 1.09902)];
const d1NonConfirming = [candle('2026-09-02T00:00:00Z', 1.2, 1.0)];

// Touch support, then retrace 50pt above it — READY at the second candle.
const touchAndRetraceSupport: CandleData[] = [
  candle('2026-09-07T08:00:00Z', 1.0993, 1.0989, 1.0991),
  candle('2026-09-07T08:15:00Z', 1.0996, 1.0994, 1.0995),
];

describe('runBacktest', () => {
  it('opens a BUY after touch-and-retrace with D1 confluence, and resolves as a WIN', () => {
    const m15 = [...touchAndRetraceSupport, candle('2026-09-07T08:30:00Z', 1.1015, 1.0998)]; // hits TP (~1.1013), not SL (~1.0977)
    const result = runBacktest(h4, d1Confirming, m15, config(), 0);
    expect(result.totalTrades).toBe(1);
    expect(result.trades[0].action).toBe('OPEN_BUY');
    expect(result.trades[0].outcome).toBe('WIN');
    expect(result.trades[0].openedAt.toISOString()).toBe('2026-09-07T08:15:00.000Z');
  });

  it('resolves as a LOSS when SL is hit first', () => {
    const m15 = [...touchAndRetraceSupport, candle('2026-09-07T08:30:00Z', 1.0999, 1.0975)]; // hits SL (~1.0977), not TP
    const result = runBacktest(h4, d1Confirming, m15, config(), 0);
    expect(result.trades[0].outcome).toBe('LOSS');
  });

  it('never opens a trade when the H4 level has no D1 confluence', () => {
    const m15 = [...touchAndRetraceSupport, candle('2026-09-07T08:30:00Z', 1.1015, 1.0998)];
    const result = runBacktest(h4, d1NonConfirming, m15, config(), 0);
    expect(result.totalTrades).toBe(0);
  });

  it('never opens a trade during a volatility spike, even with a valid touch-and-retrace', () => {
    const m15 = [
      // A 510pt move BEFORE the touch/retrace, staying clear of both levels (safely below
      // resistance=1.105, well above support=1.099) so it doesn't itself trigger a touch —
      // its only job is to sit inside the 2h lookback window and register as a spike.
      candle('2026-09-07T07:00:00Z', 1.1047, 1.1045, 1.1046),
      ...touchAndRetraceSupport, // otherwise-valid touch (08:00) + retrace (08:15), both within 2h of the candle above
    ];
    const result = runBacktest(h4, d1Confirming, m15, config(), 0);
    expect(result.totalTrades).toBe(0);
  });

  it('never opens a second trade on the same calendar day, even after the first one already closed', () => {
    const m15 = [
      ...touchAndRetraceSupport, // opens BUY #1 at 08:15
      candle('2026-09-07T08:30:00Z', 1.1015, 1.0998), // closes it as a WIN
      candle('2026-09-07T09:00:00Z', 1.0993, 1.0989, 1.0995), // a fresh touch+retrace, same day — must NOT open
      candle('2026-09-08T08:00:00Z', 1.0993, 1.0989, 1.0991), // next day — allowed again
      candle('2026-09-08T08:15:00Z', 1.0996, 1.0994, 1.0995),
      candle('2026-09-08T08:30:00Z', 1.1015, 1.0998),
    ];
    const result = runBacktest(h4, d1Confirming, m15, config(), 0);
    expect(result.totalTrades).toBe(2);
    expect(result.trades[0].openedAt.toISOString().slice(0, 10)).toBe('2026-09-07');
    expect(result.trades[1].openedAt.toISOString().slice(0, 10)).toBe('2026-09-08');
  });

  it("does not trade a level once it's broken, per the friend's Rule 5", () => {
    const m15 = [
      candle('2026-09-07T08:00:00Z', 1.0993, 1.0985, 1.0987), // 50pt undershoot = broken, not just touched
      candle('2026-09-07T08:15:00Z', 1.0996, 1.0994, 1.0995), // would otherwise look like a retrace
    ];
    const result = runBacktest(h4, d1Confirming, m15, config(), 0);
    expect(result.totalTrades).toBe(0);
  });

  it('marks a still-open position at the end of the data as OPEN_AT_END', () => {
    const result = runBacktest(h4, d1Confirming, touchAndRetraceSupport, config(), 0);
    expect(result.totalTrades).toBe(1);
    expect(result.trades[0].outcome).toBe('OPEN_AT_END');
    expect(result.wins).toBe(0);
    expect(result.losses).toBe(0);
  });

  it('computes win rate and profit factor across a two-trade sequence', () => {
    const m15 = [
      ...touchAndRetraceSupport,
      candle('2026-09-07T08:30:00Z', 1.1015, 1.0998), // WIN
      candle('2026-09-08T08:00:00Z', 1.0993, 1.0989, 1.0991),
      candle('2026-09-08T08:15:00Z', 1.0996, 1.0994, 1.0995),
      candle('2026-09-08T08:30:00Z', 1.0999, 1.0975), // LOSS
    ];
    const result = runBacktest(h4, d1Confirming, m15, config(), 0);
    expect(result.totalTrades).toBe(2);
    expect(result.winRate).toBeCloseTo(0.5, 5);
    expect(result.profitFactor as number).toBeGreaterThan(0);
  });

  it('applies the assumed spread only to the entry price, widening the effective risk', () => {
    const m15 = [...touchAndRetraceSupport, candle('2026-09-07T08:30:00Z', 1.1015, 1.0998)];
    const zeroSpread = runBacktest(h4, d1Confirming, m15, config(), 0);
    const withSpread = runBacktest(h4, d1Confirming, m15, config(), 20);
    expect(zeroSpread.trades[0].entryPrice).not.toBe(withSpread.trades[0].entryPrice);
  });
});

/**
 * Reconciliation audit, 2nd pass — regression coverage for the two
 * confirmed defects in the legacy `runBacktest` (see its own doc comment):
 * look-ahead (signal bar's own close used as the fill price) and short-side
 * pricing (one OHLC series used for both directions' exit checks).
 */
describe('runBacktestNoLookahead', () => {
  it('fills at the NEXT bar\'s open, never at the signal bar\'s own close (unlike legacy runBacktest)', async () => {
    const signalBars = touchAndRetraceSupport; // touch @08:00, retrace confirmed via 08:15's close (1.0995)
    const fillBar = candle('2026-09-07T08:30:00Z', 1.101, 1.1); // open = 1.1005 — deliberately far from 08:15's close
    const m15 = [...signalBars, fillBar];

    const legacy = runBacktest(h4, d1Confirming, m15, config(), 0);
    const corrected = await runBacktestNoLookahead(h4, d1Confirming, m15, config(), 0);

    // Legacy: opens AT the retrace candle itself, priced off ITS close.
    expect(legacy.trades[0].openedAt.toISOString()).toBe('2026-09-07T08:15:00.000Z');
    expect(legacy.trades[0].entryPrice).toBeCloseTo(1.0995, 6);

    // Corrected: opens at the FOLLOWING candle, priced off ITS open — the
    // earliest price actually available once the signal bar is complete.
    expect(corrected.trades[0].openedAt.toISOString()).toBe('2026-09-07T08:30:00.000Z');
    expect(corrected.trades[0].entryPrice).toBeCloseTo(1.1005, 6);
    expect(corrected.trades[0].entryPrice).not.toBeCloseTo(legacy.trades[0].entryPrice, 4);
  });

  it('never opens a trade at all if the signal bar is the LAST bar of the data — a queued signal with no fill bar is dropped, not fabricated', async () => {
    const m15 = [...touchAndRetraceSupport]; // ends right at the retrace/signal bar — no bar left to fill at
    const result = await runBacktestNoLookahead(h4, d1Confirming, m15, config(), 0);
    expect(result.totalTrades).toBe(0);
  });

  it('regression: a decision already locked in through the fill bar is byte-identical regardless of what data comes after it', async () => {
    const throughFill = [...touchAndRetraceSupport, candle('2026-09-07T08:30:00Z', 1.101, 1.1)];

    // Two futures that could not be more different — one immediately hits
    // stop, the other immediately hits target — appended AFTER the fill bar.
    const futureA = [candle('2026-09-07T08:45:00Z', 1.0999, 1.0975)]; // would hit SL
    const futureB = [candle('2026-09-07T10:00:00Z', 1.13, 1.12)]; // would hit TP, much later

    const resultA = await runBacktestNoLookahead(h4, d1Confirming, [...throughFill, ...futureA], config(), 0);
    const resultB = await runBacktestNoLookahead(h4, d1Confirming, [...throughFill, ...futureB], config(), 0);

    // The ENTRY itself — action, price, timing — must be identical: it was
    // already fully determined by data through the fill bar, before either
    // future existed.
    expect(resultA.trades[0].action).toBe(resultB.trades[0].action);
    expect(resultA.trades[0].entryPrice).toBe(resultB.trades[0].entryPrice);
    expect(resultA.trades[0].openedAt.toISOString()).toBe(resultB.trades[0].openedAt.toISOString());
    // Only the OUTCOME (which depends on data after the fill, correctly) differs.
    expect(resultA.trades[0].outcome).toBe('LOSS');
    expect(resultB.trades[0].outcome).toBe('WIN');
  });

  it('the daily-order-limit gate is keyed off the FILL day, not the signal day, when a signal queues right before midnight', async () => {
    // Signal confirmed at 23:45 (still 09-07); the only bar left to fill at
    // crosses into 09-08. The fill — and the day it consumes — must be
    // attributed to 09-08, not 09-07.
    const m15 = [
      candle('2026-09-07T23:15:00Z', 1.0993, 1.0989, 1.0991), // touch
      candle('2026-09-07T23:45:00Z', 1.0996, 1.0994, 1.0995), // retrace confirmed (signal queued)
      candle('2026-09-08T00:00:00Z', 1.101, 1.1), // fill bar — already the next day
    ];
    const result = await runBacktestNoLookahead(h4, d1Confirming, m15, config(), 0);
    expect(result.trades[0].openedAt.toISOString().slice(0, 10)).toBe('2026-09-08');
  });

  describe('resolveOutcomeSideAware — short-side exit pricing', () => {
    const shortPosition: OpenPosition = {
      action: 'OPEN_SELL',
      entryPrice: 1.1,
      stopLoss: 1.102, // above entry — correct side for a short
      takeProfit: 1.098, // below entry — correct side for a short
      levelUsed: 'RESISTANCE',
      referenceWeekStart: new Date('2026-09-02T00:00:00Z'),
      openedAt: new Date('2026-09-07T08:30:00Z'),
    };
    // A wide bar that dips toward TP and rises toward (but not quite to,
    // on the raw series) SL.
    const wideBar = candle('2026-09-07T08:45:00Z', 1.1017, 1.0975);

    it('with zero spread, the raw series alone resolves it as a WIN (TP reached)', () => {
      const result = resolveOutcomeSideAware(shortPosition, wideBar, 0);
      expect(result?.outcome).toBe('WIN');
    });

    it('adding spread shifts the synthetic ask series enough to trigger SL instead — same candle, opposite outcome', () => {
      const result = resolveOutcomeSideAware(shortPosition, wideBar, 0.0004); // 40pt
      // ask_high = 1.1017+0.0004=1.1021 >= SL(1.102) — now also triggers SL;
      // stop-first convention on a same-bar dual-hit resolves it as LOSS.
      expect(result?.outcome).toBe('LOSS');
    });

    it('a BUY position is unaffected by the ask adjustment — its exit checks the raw series regardless of spread', () => {
      const longPosition: OpenPosition = { ...shortPosition, action: 'OPEN_BUY', stopLoss: 1.098, takeProfit: 1.102 };
      const noSpread = resolveOutcomeSideAware(longPosition, wideBar, 0);
      const withSpread = resolveOutcomeSideAware(longPosition, wideBar, 0.0004);
      expect(noSpread).toEqual(withSpread);
    });
  });

  it('still respects confluence, volatility, break, and daily-limit gating identically to the legacy engine\'s rules (only timing/pricing changed)', async () => {
    const m15 = [...touchAndRetraceSupport, candle('2026-09-07T08:30:00Z', 1.101, 1.1)];
    expect((await runBacktestNoLookahead(h4, d1NonConfirming, m15, config(), 0)).totalTrades).toBe(0);

    const brokenLevel = [
      candle('2026-09-07T08:00:00Z', 1.0993, 1.0985, 1.0987), // 50pt undershoot = broken
      candle('2026-09-07T08:15:00Z', 1.0996, 1.0994, 1.0995),
      candle('2026-09-07T08:30:00Z', 1.101, 1.1),
    ];
    expect((await runBacktestNoLookahead(h4, d1Confirming, brokenLevel, config(), 0)).totalTrades).toBe(0);
  });

  it('parity regression: runBacktestWithConfirmation with an approve-all hook is byte-identical to the plain mechanical wrapper', async () => {
    const m15 = [...touchAndRetraceSupport, candle('2026-09-07T08:30:00Z', 1.101, 1.1), candle('2026-09-07T08:45:00Z', 1.1035, 1.102)];
    const mechanical = await runBacktestNoLookahead(h4, d1Confirming, m15, config(), 15);
    const withApproveAllHook = await runBacktestWithConfirmation(h4, d1Confirming, m15, config(), 15, async () => true);
    expect(withApproveAllHook).toEqual(mechanical);
  });

  it('a confirmation hook that VETOES every candidate produces zero trades, and does not re-ask on every subsequent candle the same day', async () => {
    let calls = 0;
    const rejectAll = async () => {
      calls++;
      return false;
    };
    // A candidate that stays valid (in the retraced zone) across several
    // M15 candles within the same day — the exact shape that caused the
    // real ~1,900-call bug in an earlier session when this "already asked
    // today" gate didn't exist for a vetoed (not just a filled) candidate.
    const m15 = [
      ...touchAndRetraceSupport, // touch @08:00, retrace confirmed @08:15
      candle('2026-09-07T08:30:00Z', 1.0997, 1.0994, 1.0996), // still sitting in the retraced zone
      candle('2026-09-07T08:45:00Z', 1.0997, 1.0994, 1.0996),
      candle('2026-09-07T09:00:00Z', 1.0997, 1.0994, 1.0996),
    ];
    const result = await runBacktestWithConfirmation(h4, d1Confirming, m15, config(), 0, rejectAll);
    expect(result.totalTrades).toBe(0);
    expect(calls).toBe(1); // asked once for the day, not once per candle
  });
});
