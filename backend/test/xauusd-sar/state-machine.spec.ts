import { describe, expect, it } from 'vitest';
import {
  applyTrailing,
  captureSessionReference,
  closeForDay,
  evaluateInitialDirection,
  initialSessionState,
  openInitialCycle,
  openReversalCycle,
  resolveUnknown,
  startNewSession,
  updateBuyTrailing,
  updateSellTrailing,
  type SarSessionState,
} from '../../src/xauusd-sar/state-machine';

const DATE = '2026-09-24';
const NOW = Date.UTC(2026, 8, 23, 22, 0); // 01:00 Beirut (UTC+3 in September)

describe('session reference capture', () => {
  it('is the mid of bid/ask, not biased toward either side', () => {
    const s = captureSessionReference(initialSessionState(DATE), { bid: 4499.8, ask: 4500.2 }, NOW);
    expect(s.sessionReference).toBeCloseTo(4500.0, 6);
    expect(s.state).toBe('WAIT_INITIAL_DIRECTION');
  });

  it('sets BUY trigger above and SELL trigger below by exactly the reversal distance', () => {
    const s = captureSessionReference(initialSessionState(DATE), { bid: 4500, ask: 4500 }, NOW);
    expect(s.initialBuyTrigger).toBeCloseTo(4500.5, 6);
    expect(s.initialSellTrigger).toBeCloseTo(4499.5, 6);
  });

  it('does not move as price wobbles before a direction fires — the reference is fixed, not trailing', () => {
    const s = captureSessionReference(initialSessionState(DATE), { bid: 4500, ask: 4500 }, NOW);
    for (const p of [4500.2, 4500.35, 4500.1, 4499.9]) {
      const outcome = evaluateInitialDirection(s, { bid: p, ask: p });
      expect(outcome.direction).toBeNull();
    }
    expect(s.initialBuyTrigger).toBe(4500.5);
    expect(s.initialSellTrigger).toBe(4499.5);
  });
});

describe('initial direction discovery', () => {
  const s = captureSessionReference(initialSessionState(DATE), { bid: 4500, ask: 4500 }, NOW);

  it('BUY fires when the ASK reaches the buy trigger — the side a BUY actually fills at', () => {
    const outcome = evaluateInitialDirection(s, { bid: 4500.3, ask: 4500.5 });
    expect(outcome.direction).toBe('BUY');
    expect(outcome.fillPrice).toBe(4500.5);
  });

  it('SELL fires when the BID reaches the sell trigger', () => {
    const outcome = evaluateInitialDirection(s, { bid: 4499.5, ask: 4499.7 });
    expect(outcome.direction).toBe('SELL');
    expect(outcome.fillPrice).toBe(4499.5);
  });

  it('a gap straight past the trigger still fires — no exact-equality requirement', () => {
    const outcome = evaluateInitialDirection(s, { bid: 4501.2, ask: 4501.4 });
    expect(outcome.direction).toBe('BUY');
    expect(outcome.fillPrice).toBe(4501.4);
  });

  it('exact equality counts', () => {
    expect(evaluateInitialDirection(s, { bid: 4499.5, ask: 4499.8 }).direction).toBe('SELL');
    expect(evaluateInitialDirection(s, { bid: 4500.2, ask: 4500.5 }).direction).toBe('BUY');
  });

  it('is inert outside WAIT_INITIAL_DIRECTION', () => {
    const active: SarSessionState = { ...s, state: 'ACTIVE_BUY' };
    expect(evaluateInitialDirection(active, { bid: 9999, ask: 9999 }).direction).toBeNull();
  });

  it('never fabricates a fill at the logical trigger price', () => {
    const outcome = evaluateInitialDirection(s, { bid: 4500.3, ask: 4500.53 });
    expect(outcome.fillPrice).toBe(4500.53);
    expect(outcome.fillPrice).not.toBe(s.initialBuyTrigger);
  });
});

describe('the BUY cycle', () => {
  function buyAt(entry: number): SarSessionState {
    return openInitialCycle(initialSessionState(DATE), 'BUY', entry, 'cycle-1', '900001');
  }

  it('opens with the trailing high at the entry price and the reversal $0.50 below it', () => {
    const s = buyAt(4500.5);
    expect(s.extremeSinceEntry).toBe(4500.5);
    expect(s.reversalLevel).toBe(4500.0);
    expect(s.state).toBe('ACTIVE_BUY');
  });

  it('a new high raises the extreme and the reversal level by the same amount', () => {
    let s = buyAt(4500.5);
    const u1 = updateBuyTrailing(s, { bid: 4501.0, ask: 4501.2 });
    expect(u1.extremeSinceEntry).toBe(4501.0);
    expect(u1.reversalLevel).toBe(4500.5);
    expect(u1.reversalTriggered).toBe(false);
    s = applyTrailing(s, u1);

    const u2 = updateBuyTrailing(s, { bid: 4503.0, ask: 4503.2 });
    expect(u2.extremeSinceEntry).toBe(4503.0);
    expect(u2.reversalLevel).toBe(4502.5);
  });

  it('retracement does NOT loosen the reversal level — it stays exactly where the high left it', () => {
    let s = buyAt(4500.5);
    s = applyTrailing(s, updateBuyTrailing(s, { bid: 4503.0, ask: 4503.2 }));
    expect(s.reversalLevel).toBe(4502.5);

    for (const bid of [4502.9, 4502.7, 4502.55]) {
      const u = updateBuyTrailing(s, { bid, ask: bid + 0.2 });
      expect(u.reversalLevel).toBe(4502.5); // unchanged
      expect(u.extremeSinceEntry).toBe(4503.0); // unchanged
      expect(u.reversalTriggered).toBe(false);
    }
  });

  it('only a NEW high can move the reversal level; it can never decrease', () => {
    let s = buyAt(4500.5);
    s = applyTrailing(s, updateBuyTrailing(s, { bid: 4503.0, ask: 4503.2 }));
    // Retrace down, then make a new high above the old one.
    s = applyTrailing(s, updateBuyTrailing(s, { bid: 4502.6, ask: 4502.8 }));
    expect(s.reversalLevel).toBe(4502.5);
    s = applyTrailing(s, updateBuyTrailing(s, { bid: 4504.0, ask: 4504.2 }));
    expect(s.reversalLevel).toBe(4503.5);
  });

  it('fires exactly at the reversal level (inclusive)', () => {
    let s = buyAt(4500.5);
    s = applyTrailing(s, updateBuyTrailing(s, { bid: 4503.0, ask: 4503.2 }));
    const u = updateBuyTrailing(s, { bid: 4502.5, ask: 4502.7 });
    expect(u.reversalTriggered).toBe(true);
  });

  it('a gap straight through the reversal level still fires', () => {
    let s = buyAt(4500.5);
    s = applyTrailing(s, updateBuyTrailing(s, { bid: 4503.0, ask: 4503.2 }));
    const u = updateBuyTrailing(s, { bid: 4500.0, ask: 4500.2 }); // gapped well past 4502.5
    expect(u.reversalTriggered).toBe(true);
  });

  it('reverses into a brand new SELL cycle that does NOT inherit the BUY high', () => {
    let s = buyAt(4500.5);
    s = applyTrailing(s, updateBuyTrailing(s, { bid: 4503.0, ask: 4503.2 }));
    const reversed = openReversalCycle(s, 'SELL', 4502.5, 'cycle-2', '900002');
    expect(reversed.state).toBe('ACTIVE_SELL');
    expect(reversed.direction).toBe('SELL');
    expect(reversed.cycleId).toBe('cycle-2');
    expect(reversed.extremeSinceEntry).toBe(4502.5); // reset to the new entry, not 4503
    expect(reversed.reversalLevel).toBe(4503.0);
  });
});

describe('the SELL cycle (mirror of BUY)', () => {
  function sellAt(entry: number): SarSessionState {
    return openInitialCycle(initialSessionState(DATE), 'SELL', entry, 'cycle-1', '900001');
  }

  it('opens with the trailing low at the entry price and the reversal $0.50 above it', () => {
    const s = sellAt(4500.0);
    expect(s.extremeSinceEntry).toBe(4500.0);
    expect(s.reversalLevel).toBe(4500.5);
  });

  it('a new low lowers the extreme and the reversal level by the same amount', () => {
    let s = sellAt(4500.0);
    s = applyTrailing(s, updateSellTrailing(s, { bid: 4494.8, ask: 4495.0 }));
    expect(s.extremeSinceEntry).toBe(4495.0);
    expect(s.reversalLevel).toBe(4495.5);
  });

  it('a rebound does NOT loosen the reversal level', () => {
    let s = sellAt(4500.0);
    s = applyTrailing(s, updateSellTrailing(s, { bid: 4489.8, ask: 4490.0 }));
    expect(s.reversalLevel).toBe(4490.5);
    for (const ask of [4490.1, 4490.3, 4490.45]) {
      const u = updateSellTrailing(s, { bid: ask - 0.2, ask });
      expect(u.reversalLevel).toBe(4490.5);
      expect(u.reversalTriggered).toBe(false);
    }
  });

  it('only a new low can move the reversal level lower', () => {
    let s = sellAt(4500.0);
    s = applyTrailing(s, updateSellTrailing(s, { bid: 4489.8, ask: 4490.0 }));
    s = applyTrailing(s, updateSellTrailing(s, { bid: 4489.9, ask: 4490.1 })); // rebound, no change
    expect(s.reversalLevel).toBe(4490.5);
    s = applyTrailing(s, updateSellTrailing(s, { bid: 4484.8, ask: 4485.0 })); // new low
    expect(s.reversalLevel).toBe(4485.5);
  });

  it('fires exactly at, or gapped through, the reversal level', () => {
    let s = sellAt(4500.0);
    s = applyTrailing(s, updateSellTrailing(s, { bid: 4489.8, ask: 4490.0 }));
    expect(updateSellTrailing(s, { bid: 4490.3, ask: 4490.5 }).reversalTriggered).toBe(true);
    expect(updateSellTrailing(s, { bid: 4492.8, ask: 4493.0 }).reversalTriggered).toBe(true); // gap through
  });

  it('reverses into a brand new BUY cycle', () => {
    let s = sellAt(4500.0);
    s = applyTrailing(s, updateSellTrailing(s, { bid: 4489.8, ask: 4490.0 }));
    const reversed = openReversalCycle(s, 'BUY', 4490.5, 'cycle-2', '900002');
    expect(reversed.state).toBe('ACTIVE_BUY');
    expect(reversed.extremeSinceEntry).toBe(4490.5);
    expect(reversed.reversalLevel).toBe(4490.0);
  });
});

describe('multi-cycle continuity', () => {
  it('BUY -> SELL -> BUY -> SELL -> BUY always leaves exactly one active direction', () => {
    let s = openInitialCycle(initialSessionState(DATE), 'BUY', 4500, 'c1', 't1');
    s = openReversalCycle(s, 'SELL', 4499.5, 'c2', 't2');
    s = openReversalCycle(s, 'BUY', 4500.0, 'c3', 't3');
    s = openReversalCycle(s, 'SELL', 4499.5, 'c4', 't4');
    s = openReversalCycle(s, 'BUY', 4500.0, 'c5', 't5');
    expect(s.state).toBe('ACTIVE_BUY');
    expect(s.cycleId).toBe('c5');
    expect(s.direction).toBe('BUY');
  });
});

describe('UNKNOWN resolution', () => {
  it('resolves to the direction before the attempt when the broker never received the order', () => {
    const active = openInitialCycle(initialSessionState(DATE), 'BUY', 4500.5, 'c1', 't1');
    const unknown: SarSessionState = { ...active, state: 'REVERSAL_UNKNOWN' };
    const resolved = resolveUnknown(unknown, { filled: false });
    expect(resolved.state).toBe('ACTIVE_BUY');
  });

  it('opens the new cycle once reconciliation confirms the fill', () => {
    const active = openInitialCycle(initialSessionState(DATE), 'BUY', 4500.5, 'c1', 't1');
    const unknown: SarSessionState = { ...active, state: 'REVERSAL_UNKNOWN' };
    const resolved = resolveUnknown(unknown, {
      filled: true,
      direction: 'SELL',
      fillPrice: 4500.0,
      ticket: 't2',
      cycleId: 'c2',
    });
    expect(resolved.state).toBe('ACTIVE_SELL');
    expect(resolved.cycleId).toBe('c2');
  });
});

describe('daily close and new session', () => {
  it('closeForDay always lands on DAILY_CLOSED, flat, whatever the prior state', () => {
    const active = openInitialCycle(initialSessionState(DATE), 'BUY', 4500.5, 'c1', 't1');
    const closed = closeForDay(active);
    expect(closed.state).toBe('DAILY_CLOSED');
    expect(closed.direction).toBeNull();
    expect(closed.cycleId).toBeNull();
    expect(closed.brokerTicket).toBeNull();
  });

  it('a new session starts completely flat, with a new date and no memory of the prior extreme', () => {
    const s = startNewSession('2026-09-25');
    expect(s.state).toBe('WAIT_MARKET_OPEN');
    expect(s.sessionDate).toBe('2026-09-25');
    expect(s.sessionReference).toBeNull();
    expect(s.extremeSinceEntry).toBeNull();
  });
});
