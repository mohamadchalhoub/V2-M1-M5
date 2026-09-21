/**
 * §15.6 — brackets, risk caps and the final pre-send gate.
 *
 * Two properties dominate: nothing is ever adjusted to make an order
 * acceptable, and the combined cap genuinely spans both timeframes including
 * risk that is reserved but not yet filled.
 */
import { describe, expect, it } from 'vitest';
import {
  bracketsFor,
  entryDriftPoints,
  roundToTick,
  verifyBracketDistances,
  type BrokerStopConstraints,
} from '../../src/xauusd-m1m5/brackets';
import { evaluateRisk, preSendCheck, type PreSendInput, type RiskInput } from '../../src/xauusd-m1m5/risk';
import {
  V2_COMBINED_RISK_CAP_PCT,
  V2_MAX_ENTRY_DEVIATION_POINTS,
  V2_MAX_SIGNAL_AGE_SECONDS,
  V2_SL_USD,
  V2_STOP_RISK_CAP_PCT,
  V2_TP_USD,
} from '../../src/xauusd-m1m5/safety-constants';

const GOLD: BrokerStopConstraints = { pointSize: 0.01, stopLevelPoints: 0, freezeLevelPoints: 0, tickSize: 0.01 };
const NOW = Date.UTC(2026, 8, 21, 10, 0, 0);

describe('§7 the $5 brackets, on the correct side of the spread', () => {
  it('SELL at 4450 gives TP 4445 and SL 4455', () => {
    const r = bracketsFor('SELL', { bid: 4450, ask: 4450.5 }, GOLD);
    expect(r.brackets).toMatchObject({ entryPrice: 4450, takeProfit: 4445, stopLoss: 4455 });
  });

  it('BUY at 4450 gives TP 4455 and SL 4445', () => {
    const r = bracketsFor('BUY', { bid: 4449.5, ask: 4450 }, GOLD);
    expect(r.brackets).toMatchObject({ entryPrice: 4450, takeProfit: 4455, stopLoss: 4445 });
  });

  it('fills BUY at the ask and SELL at the bid', () => {
    const quote = { bid: 4450, ask: 4450.8 };
    expect(bracketsFor('BUY', quote, GOLD).brackets?.entryPrice).toBe(4450.8);
    expect(bracketsFor('SELL', quote, GOLD).brackets?.entryPrice).toBe(4450);
  });

  it('applies the same $5 distances on both timeframes and both directions', () => {
    for (const direction of ['BUY', 'SELL'] as const) {
      const b = bracketsFor(direction, { bid: 4450, ask: 4450.1 }, GOLD).brackets!;
      expect(b.takeProfitDistance).toBe(V2_TP_USD);
      expect(b.stopLossDistance).toBe(V2_SL_USD);
      expect(Math.abs(b.takeProfit - b.entryPrice)).toBeCloseTo(5, 9);
      expect(Math.abs(b.stopLoss - b.entryPrice)).toBeCloseTo(5, 9);
    }
  });

  it('refuses an unusable or crossed quote', () => {
    expect(bracketsFor('BUY', { bid: 0, ask: 4450 }, GOLD).refusal).toBe('INVALID_QUOTE');
    expect(bracketsFor('BUY', { bid: Number.NaN, ask: 4450 }, GOLD).refusal).toBe('INVALID_QUOTE');
    expect(bracketsFor('BUY', { bid: 4451, ask: 4450 }, GOLD).refusal).toBe('CROSSED_QUOTE');
  });

  it('refuses an implausible broker point size rather than misplacing the stop', () => {
    const wrong = bracketsFor('BUY', { bid: 4450, ask: 4450.1 }, { ...GOLD, pointSize: 1 });
    expect(wrong.refusal).toBe('IMPLAUSIBLE_POINT_SIZE');
    expect(wrong.detail).toMatch(/orders of magnitude/i);
  });

  it('refuses rather than widening a bracket to satisfy a broker stop level', () => {
    // $5 at 0.01 point size is 500 points; a broker demanding 600 cannot be
    // satisfied without changing the rule, so the order is refused.
    const r = bracketsFor('SELL', { bid: 4450, ask: 4450.1 }, { ...GOLD, stopLevelPoints: 600 });
    expect(r.refusal).toBe('BRACKET_BELOW_BROKER_STOP_LEVEL');
    expect(r.detail).toMatch(/NOT widened/i);
  });

  it('refuses a bracket inside the broker freeze level', () => {
    const r = bracketsFor('SELL', { bid: 4450, ask: 4450.1 }, { ...GOLD, freezeLevelPoints: 600 });
    expect(r.refusal).toBe('BRACKET_INSIDE_FREEZE_LEVEL');
  });

  it('rounds protective levels to the broker tick without leaving float dust', () => {
    expect(roundToTick(4445.000000000001, 0.01)).toBe(4445);
    expect(roundToTick(4445.017, 0.01)).toBe(4445.02);
    expect(roundToTick(4445.017, 0)).toBe(4445.017);
  });
});

describe('§7 bracket re-verification before submission', () => {
  it('accepts correctly placed brackets', () => {
    expect(verifyBracketDistances('SELL', 4450, 4455, 4445, 0.01).ok).toBe(true);
    expect(verifyBracketDistances('BUY', 4450, 4445, 4455, 0.01).ok).toBe(true);
  });

  it('rejects a bracket at the wrong distance', () => {
    const r = verifyBracketDistances('SELL', 4450, 4460, 4445, 0.01);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/Stop loss/);
  });

  it('rejects inverted brackets, which would turn a stop into a target', () => {
    expect(verifyBracketDistances('SELL', 4450, 4445, 4455, 0.01).ok).toBe(false);
    expect(verifyBracketDistances('BUY', 4450, 4455, 4445, 0.01).ok).toBe(false);
  });

  it('tolerates rounding of at most one point', () => {
    expect(verifyBracketDistances('SELL', 4450, 4455.01, 4445, 0.01).ok).toBe(true);
    expect(verifyBracketDistances('SELL', 4450, 4455.05, 4445, 0.01).ok).toBe(false);
  });
});

describe('§7 risk caps', () => {
  const base: RiskInput = {
    account: { equity: 10_000, freeMargin: 5_000, dayLoss: 0, drawdown: 0 },
    candidateStopRisk: 40, // 0.4% of 10k
    candidateMarginRequired: 1_000,
    committed: [],
  };

  it('approves an order inside every cap', () => {
    const v = evaluateRisk(base);
    expect(v.approved).toBe(true);
    expect(v.evidence.candidateStopRiskPct).toBeCloseTo(0.4, 6);
  });

  it('refuses when equity cannot be read, rather than assuming', () => {
    const v = evaluateRisk({ ...base, account: { ...base.account, equity: null } });
    expect(v.refusal).toBe('NO_EQUITY');
    expect(v.detail).toMatch(/never proceeding on an assumed|rather than proceeding on an assumed/i);
  });

  it('enforces the per-trade stop-risk cap without reducing volume', () => {
    const v = evaluateRisk({ ...base, candidateStopRisk: 60 }); // 0.6% > 0.5%
    expect(v.refusal).toBe('STOP_RISK_CAP');
    expect(v.detail).toMatch(/NOT reduced to fit/i);
  });

  it('enforces the daily-loss cap', () => {
    const v = evaluateRisk({ ...base, account: { ...base.account, dayLoss: 250 } }); // 2.5% > 2%
    expect(v.refusal).toBe('DAILY_LOSS_CAP');
  });

  it('enforces the drawdown cap, and reports it ahead of narrower caps', () => {
    const v = evaluateRisk({
      ...base,
      candidateStopRisk: 999,
      account: { ...base.account, drawdown: 600, dayLoss: 300 },
    });
    expect(v.refusal).toBe('DRAWDOWN_CAP');
  });

  it('refuses when free margin is short, or unreadable', () => {
    expect(evaluateRisk({ ...base, candidateMarginRequired: 9_000 }).refusal).toBe('INSUFFICIENT_MARGIN');
    expect(evaluateRisk({ ...base, account: { ...base.account, freeMargin: null } }).refusal).toBe(
      'INSUFFICIENT_MARGIN',
    );
  });

  it('exposes the numbers the decision was made on', () => {
    const v = evaluateRisk({ ...base, account: { ...base.account, dayLoss: 100, drawdown: 200 } });
    expect(v.evidence.dayLossPct).toBeCloseTo(1, 6);
    expect(v.evidence.drawdownPct).toBeCloseTo(2, 6);
    expect(v.evidence.equity).toBe(10_000);
  });
});

describe('§7 the combined cap spans both timeframes and includes reserved risk', () => {
  const account = { equity: 10_000, freeMargin: 9_000, dayLoss: 0, drawdown: 0 };

  it('sums an open position on the other timeframe', () => {
    const v = evaluateRisk({
      account,
      candidateStopRisk: 45, // 0.45%, under the per-trade cap
      candidateMarginRequired: 100,
      committed: [{ timeframe: 'M5', stopRisk: 60, reserved: false }], // 0.6%
    });
    // 1.05% combined, above the 1% cap.
    expect(v.refusal).toBe('COMBINED_RISK_CAP');
    expect(v.evidence.combinedStopRiskPct).toBeCloseTo(1.05, 6);
  });

  it('counts a RESERVED but unfilled order, which is the race this closes', () => {
    // Two orders submitted a second apart would each pass the per-trade cap
    // and together breach the combined one, unless the reservation counts.
    const v = evaluateRisk({
      account,
      candidateStopRisk: 49,
      candidateMarginRequired: 100,
      committed: [{ timeframe: 'M1', stopRisk: 49, reserved: true }],
    });
    expect(v.approved).toBe(true); // 0.98%, just inside

    const breach = evaluateRisk({
      account,
      candidateStopRisk: 50,
      candidateMarginRequired: 100,
      committed: [{ timeframe: 'M1', stopRisk: 51, reserved: true }],
    });
    expect(breach.refusal).toBe('COMBINED_RISK_CAP');
    expect(breach.detail).toMatch(/1 reserved but not yet filled/);
  });

  it('permits two positions that together stay inside the cap', () => {
    const v = evaluateRisk({
      account,
      candidateStopRisk: 40,
      candidateMarginRequired: 100,
      committed: [{ timeframe: 'M5', stopRisk: 40, reserved: false }],
    });
    expect(v.approved).toBe(true);
    expect(v.evidence.combinedStopRiskPct).toBeCloseTo(0.8, 6);
  });

  it('uses the documented cap values', () => {
    expect(V2_STOP_RISK_CAP_PCT).toBe(0.5);
    expect(V2_COMBINED_RISK_CAP_PCT).toBe(1);
  });
});

describe('§7/§9.2 the final pre-send gate', () => {
  const base: PreSendInput = {
    timeframe: 'M1',
    direction: 'SELL',
    signalObservedAtMs: NOW - 2000,
    signalPrice: 4450,
    freshQuote: { bid: 4450, ask: 4450.2, tickAtMs: NOW - 500 },
    entryPrice: 4450,
    stopLoss: 4455,
    takeProfit: 4445,
    pointSize: 0.01,
    nowMs: NOW,
    scheduleAllowsEntries: true,
    scheduleDetail: 'Clock permits new entries.',
    entriesBlockedReason: null,
  };

  it('passes a well-formed, fresh candidate', () => {
    expect(preSendCheck(base)).toEqual({ ok: true, refusal: null, detail: null });
  });

  it('rechecks the schedule at the boundary, ahead of everything else', () => {
    const v = preSendCheck({
      ...base,
      scheduleAllowsEntries: false,
      scheduleDetail: 'Friday entry cutoff reached (23:00 Beirut).',
      signalObservedAtMs: NOW - 999_999, // also too old; schedule still wins
    });
    expect(v.refusal).toBe('SCHEDULE_CLOSED');
    expect(v.detail).toMatch(/Friday entry cutoff/);
  });

  it('honours a kill switch engaged after the decision was made', () => {
    const v = preSendCheck({ ...base, entriesBlockedReason: 'Kill switch is active.' });
    expect(v.refusal).toBe('ENTRIES_BLOCKED');
  });

  it('drops a signal older than the limit rather than submitting it late', () => {
    const atLimit = preSendCheck({ ...base, signalObservedAtMs: NOW - V2_MAX_SIGNAL_AGE_SECONDS * 1000 });
    expect(atLimit.ok).toBe(true);

    const v = preSendCheck({ ...base, signalObservedAtMs: NOW - (V2_MAX_SIGNAL_AGE_SECONDS * 1000 + 1) });
    expect(v.refusal).toBe('SIGNAL_TOO_OLD');
    expect(v.detail).toMatch(/no longer the event the rules described/i);
  });

  it('refuses a stale quote', () => {
    const v = preSendCheck({ ...base, freshQuote: { ...base.freshQuote, tickAtMs: NOW - 31_000 } });
    expect(v.refusal).toBe('QUOTE_STALE');
  });

  it('refuses a future-dated quote, which signals a wrong conversion', () => {
    const v = preSendCheck({ ...base, freshQuote: { ...base.freshQuote, tickAtMs: NOW + 10_000 } });
    expect(v.refusal).toBe('QUOTE_FUTURE_DATED');
    expect(v.detail).toMatch(/wrong timestamp conversion/i);
  });

  it('skips rather than chases an entry that has drifted too far', () => {
    // 100 points at 0.01 is $1.00 of price.
    const atLimit = preSendCheck({ ...base, freshQuote: { ...base.freshQuote, bid: 4451 } });
    expect(atLimit.ok).toBe(true);

    const v = preSendCheck({ ...base, freshQuote: { ...base.freshQuote, bid: 4451.01 } });
    expect(v.refusal).toBe('ENTRY_DRIFT_EXCEEDED');
    expect(v.detail).toMatch(/never chased/i);
  });

  it('measures drift against the side the order actually fills at', () => {
    // A SELL fills at the bid, so a wide ask must not count as drift.
    const v = preSendCheck({ ...base, freshQuote: { bid: 4450, ask: 4460, tickAtMs: NOW - 500 } });
    expect(v.ok).toBe(true);
  });

  it('refuses brackets that no longer describe the required distances', () => {
    const v = preSendCheck({ ...base, stopLoss: 4460 });
    expect(v.refusal).toBe('BRACKETS_INVALID');
  });

  it('uses the documented drift limit', () => {
    expect(V2_MAX_ENTRY_DEVIATION_POINTS).toBe(100);
    expect(entryDriftPoints(4450, 4451, 0.01)).toBeCloseTo(100, 6);
  });
});
