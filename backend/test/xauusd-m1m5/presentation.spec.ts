/**
 * §15.6/§15.7 — dashboard and Telegram presentation.
 *
 * These assert labelling, which sounds cosmetic and is not. Two of the
 * specification's rules exist purely at this layer: 98.5 and 1.5 must never
 * appear as entry thresholds, and a message from this bot must be
 * impossible to confuse with one from the bot that is still running on the
 * same broker, the same symbol and the same machine.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDashboardView,
  describeNextEligibility,
  type BuildViewInput,
  type LockStateInput,
} from '../../src/xauusd-m1m5/dashboard-view';
import { createCrossingState } from '../../src/xauusd-m1m5/crossing';
import { createEngineState } from '../../src/xauusd-m1m5/engine';
import { evaluateEntryEligibility, type RuntimeGates } from '../../src/xauusd-m1m5/schedule';
import { evaluateReadiness } from '../../src/xauusd-m1m5/mt5-readiness';
import {
  closedMessage,
  filledMessage,
  lockActivatedMessage,
  lockReleasedMessage,
  liquidationFailedMessage,
  rejectedMessage,
  signalMessage,
  skippedMessage,
  submittedMessage,
  uncertainMessage,
} from '../../src/xauusd-m1m5/telegram-messages';
import { SPEC, XAUUSD_M1M5_STRATEGY_VERSION, type Timeframe } from '../../src/xauusd-m1m5/spec';
import { V2_MAGIC_M1, V2_MAGIC_M5 } from '../../src/xauusd-m1m5/safety-constants';

/** Wednesday 10:00 Beirut — outside both pauses. */
const WED_1000 = Date.UTC(2026, 8, 23, 7, 0, 0);
const CTX = { accountLabel: 'DEMO 12345678' };

const OPEN_GATES: RuntimeGates = {
  brokerSessionOpen: true,
  dataFresh: true,
  recoveryComplete: true,
  killSwitchEngaged: false,
  executionBlockers: [],
};

const READY = evaluateReadiness({
  snapshot: {
    capturedAtMs: WED_1000 - 1000,
    loginId: '12345678',
    tradeMode: 'DEMO',
    terminalConnected: true,
    terminalTradeAllowed: true,
    terminalTradeApiDisabled: false,
    accountTradeAllowed: true,
    accountTradeExpert: true,
    marginMode: 'RETAIL_HEDGING',
  },
  expectedLoginId: '12345678',
  nowMs: WED_1000,
});

function view(over: Partial<BuildViewInput> = {}) {
  const base: BuildViewInput = {
    buildCommit: 'abc1234',
    accountLabel: 'DEMO 12345678',
    executionMode: 'OFF',
    engines: { M1: createEngineState('M1'), M5: createEngineState('M5') },
    crossings: { M1: createCrossingState('M1', 'hash'), M5: createCrossingState('M5', 'hash') },
    occupancy: { M1: null, M5: null },
    locks: [],
    eligibility: evaluateEntryEligibility(WED_1000, OPEN_GATES),
    readiness: READY,
    liquidation: { underway: false, confirmedFlat: false, deadlineMissed: false },
    observationLimitations: [],
    ...over,
  };
  return buildDashboardView(base);
}

function lock(over: Partial<LockStateInput> & { timeframe: Timeframe; direction: 'SELL' | 'BUY' }): LockStateInput {
  return {
    active: true,
    losingPositionId: 'pos-1',
    netRealized: -12.5,
    activatedAt: new Date(WED_1000 - 60_000),
    unlockCondition: null,
    unlockRsi: null,
    unlockedAt: null,
    ...over,
  };
}

describe('§12 98.5 and 1.5 are never entry thresholds', () => {
  it('publishes only 91 and 8.9 as entry thresholds', () => {
    const v = view();
    expect(v.entryThresholds).toEqual({ sell: 91, buy: 8.9 });
    expect(Object.values(v.entryThresholds)).not.toContain(98.5);
    expect(Object.values(v.entryThresholds)).not.toContain(1.5);
  });

  it('mentions 98.5 and 1.5 only inside unlock conditions', () => {
    const v = view();
    for (const l of v.locks) {
      if (l.direction === 'SELL') {
        expect(l.unlockCondition).toBe('Waiting for RSI <=25 OR RSI >=98.5.');
      } else {
        expect(l.unlockCondition).toBe('Waiting for RSI >=75 OR RSI <=1.5.');
      }
    }
    // Serialised whole, the only places those numbers occur are unlock text.
    const serialised = JSON.stringify(v);
    const occurrences = (needle: string) => serialised.split(needle).length - 1;
    expect(occurrences('98.5')).toBe(occurrences('RSI >=98.5'));
    expect(occurrences('1.5')).toBeGreaterThan(0);
  });

  it('never displays removed peak/trough/retest/extreme state as active', () => {
    const serialised = JSON.stringify(view()).toLowerCase();
    for (const gone of ['peak', 'trough', 'retest', 'pullback', 'extreme_sell', 'extreme_buy']) {
      expect(serialised, `dashboard mentions removed concept: ${gone}`).not.toContain(gone);
    }
  });
});

describe('§12 all four locks are always shown', () => {
  it('shows four locks even when none has ever fired', () => {
    const v = view();
    expect(v.locks).toHaveLength(4);
    expect(v.locks.every((l) => l.state === 'INACTIVE')).toBe(true);
    expect(v.locks.map((l) => `${l.timeframe}:${l.direction}`)).toEqual([
      'M1:SELL',
      'M1:BUY',
      'M5:SELL',
      'M5:BUY',
    ]);
  });

  it('shows activation evidence on an active lock', () => {
    const v = view({ locks: [lock({ timeframe: 'M1', direction: 'SELL' })] });
    const m1Sell = v.locks.find((l) => l.timeframe === 'M1' && l.direction === 'SELL')!;
    expect(m1Sell.state).toBe('ACTIVE');
    expect(m1Sell.causingTrade).toBe('pos-1');
    expect(m1Sell.netRealizedLoss).toBe(-12.5);
    expect(m1Sell.activatedAt).not.toBeNull();
  });

  it('states that a lock does not affect the other three', () => {
    const v = view({ locks: [lock({ timeframe: 'M1', direction: 'SELL' })] });
    const m1Sell = v.locks.find((l) => l.timeframe === 'M1' && l.direction === 'SELL')!;
    expect(m1Sell.scope).toMatch(/M1 BUY, M5 SELL and M5 BUY are unaffected/);
    expect(m1Sell.scope).toMatch(/subject to its own locks/i);
  });

  it('reports the last unlock once released', () => {
    const v = view({
      locks: [
        lock({
          timeframe: 'M5',
          direction: 'BUY',
          active: false,
          unlockCondition: 'RSI_AT_OR_ABOVE',
          unlockRsi: 76,
          unlockedAt: new Date(WED_1000),
        }),
      ],
    });
    const m5Buy = v.locks.find((l) => l.timeframe === 'M5' && l.direction === 'BUY')!;
    expect(m5Buy.state).toBe('INACTIVE');
    expect(m5Buy.lastUnlock).toMatch(/RSI_AT_OR_ABOVE at RSI 76/);
  });
});

describe('§12 schedule states are distinct', () => {
  const at = (utcMs: number, over: Partial<BuildViewInput> = {}) =>
    view({ eligibility: evaluateEntryEligibility(utcMs, OPEN_GATES), ...over }).schedule.state;

  it('distinguishes the two daily pauses', () => {
    expect(at(WED_1000)).toBe('ELIGIBLE');
    expect(at(Date.UTC(2026, 8, 23, 12, 0, 0))).toBe('AFTERNOON_PAUSE'); // 15:00 Beirut
    expect(at(Date.UTC(2026, 8, 23, 21, 0, 0))).toBe('OVERNIGHT_PAUSE'); // 00:00 Beirut next day
  });

  it('reports a missed deadline ahead of the weekend', () => {
    const fridayLate = Date.UTC(2026, 8, 25, 20, 45, 0);
    expect(at(fridayLate, { liquidation: { underway: true, confirmedFlat: false, deadlineMissed: true } })).toBe(
      'DEADLINE_MISSED',
    );
  });

  it('reports liquidation underway, then confirmed', () => {
    const fridayLate = Date.UTC(2026, 8, 25, 20, 15, 0);
    expect(at(fridayLate, { liquidation: { underway: true, confirmedFlat: false, deadlineMissed: false } })).toBe(
      'FRIDAY_LIQUIDATION_UNDERWAY',
    );
    expect(at(fridayLate, { liquidation: { underway: false, confirmedFlat: true, deadlineMissed: false } })).toBe(
      'LIQUIDATION_CONFIRMED',
    );
  });

  it('reports an unknown reopening honestly rather than predicting one', () => {
    const saturday = Date.UTC(2026, 8, 26, 12, 0, 0);
    const v = view({ eligibility: evaluateEntryEligibility(saturday, OPEN_GATES) });
    expect(v.schedule.nextEligibleT).toBeNull();
    expect(describeNextEligibility(null)).toBe('Awaiting confirmed broker reopening.');
  });

  it('separates an execution blocker from a schedule block', () => {
    const blocked = evaluateEntryEligibility(WED_1000, { ...OPEN_GATES, killSwitchEngaged: true });
    expect(view({ eligibility: blocked }).schedule.state).toBe('OTHER_EXECUTION_BLOCKER');
  });
});

describe('§12 per-timeframe display', () => {
  it('shows each timeframe with its own magic number', () => {
    const v = view();
    expect(v.timeframes.find((t) => t.timeframe === 'M1')?.magicNumber).toBe(V2_MAGIC_M1);
    expect(v.timeframes.find((t) => t.timeframe === 'M5')?.magicNumber).toBe(V2_MAGIC_M5);
  });

  it('describes occupancy and ownership', () => {
    const v = view({ occupancy: { M1: { magicNumber: V2_MAGIC_M1, detail: 'ticket 55' }, M5: null } });
    expect(v.timeframes.find((t) => t.timeframe === 'M1')?.occupancy).toMatch(/M1 path/);
    expect(v.timeframes.find((t) => t.timeframe === 'M5')?.occupancy).toMatch(/Free/);
  });

  it('describes arming state per direction', () => {
    const v = view();
    const m1 = v.timeframes.find((t) => t.timeframe === 'M1')!;
    expect(m1.sellArming).toMatch(/must return below 91/);
    expect(m1.buyArming).toMatch(/must return above 8.9/);
  });

  it('names the indicator and its per-timeframe independence', () => {
    expect(view().indicator).toMatch(/RSI\(5\), CLOSE, WILDER smoothing, computed independently per timeframe/);
  });

  it('surfaces observation limitations rather than hiding them', () => {
    const v = view({ observationLimitations: ['Sampled intrabar: crossings between samples may be missed.'] });
    expect(v.observationLimitations[0]).toMatch(/sampled intrabar/i);
  });
});

describe('§13 every trade message identifies bot, account and timeframe', () => {
  const messages = [
    signalMessage(CTX, { timeframe: 'M1', direction: 'SELL', rsi: 92, previousRsi: 90, price: 4450 }),
    skippedMessage(CTX, { timeframe: 'M5', direction: 'BUY', reason: 'TIMEFRAME_OCCUPIED', detail: 'held' }),
    submittedMessage(CTX, {
      timeframe: 'M1',
      direction: 'SELL',
      volumeLots: 0.5,
      requestedPrice: 4450,
      stopLoss: 4455,
      takeProfit: 4445,
    }),
    filledMessage(CTX, {
      timeframe: 'M5',
      direction: 'BUY',
      ticket: '99',
      volumeLots: 0.5,
      requestedPrice: 4450,
      fillPrice: 4450.2,
      brokerStopLoss: 4445,
      brokerTakeProfit: 4455,
    }),
    uncertainMessage(CTX, { timeframe: 'M1', direction: 'SELL', detail: 'timeout' }),
    closedMessage(CTX, {
      timeframe: 'M1',
      direction: 'SELL',
      ticket: '99',
      netRealized: -3,
      closureReason: 'SL',
      classification: 'LOSS',
    }),
    lockActivatedMessage(CTX, {
      timeframe: 'M1',
      direction: 'SELL',
      netRealized: -3,
      ticket: '99',
      closureReason: 'SL',
    }),
    lockReleasedMessage(CTX, {
      timeframe: 'M1',
      direction: 'SELL',
      rsi: 20,
      condition: 'RSI_AT_OR_BELOW',
      threshold: 25,
    }),
  ];

  it.each(messages.map((m, i) => [i, m]))('message %i names the strategy, account and timeframe', (_i, message) => {
    const text = message as string;
    expect(text).toContain(XAUUSD_M1M5_STRATEGY_VERSION);
    expect(text).toContain('DEMO 12345678');
    expect(text).toMatch(/M1|M5/);
  });

  it('puts the identity on the first line, where it is read first', () => {
    for (const message of messages) {
      expect((message as string).split('\n')[0]).toContain(XAUUSD_M1M5_STRATEGY_VERSION);
    }
  });
});

describe('§13 nothing is reported from an acknowledgement alone', () => {
  it('a submitted order says explicitly that it is not filled', () => {
    const text = submittedMessage(CTX, {
      timeframe: 'M1',
      direction: 'SELL',
      volumeLots: 0.5,
      requestedPrice: 4450,
      stopLoss: 4455,
      takeProfit: 4445,
    });
    expect(text).toMatch(/Submitted, not filled/i);
  });

  it('an uncertain submission says it may or may not be a position', () => {
    const text = uncertainMessage(CTX, { timeframe: 'M1', direction: 'SELL', detail: 'response lost' });
    expect(text).toMatch(/may or may not be a live position/i);
    expect(text).toMatch(/No second order will be sent/i);
  });

  it('a fill reports slippage and warns when protection is missing', () => {
    const text = filledMessage(CTX, {
      timeframe: 'M1',
      direction: 'SELL',
      ticket: '7',
      volumeLots: 0.5,
      requestedPrice: 4450,
      fillPrice: 4449.8,
      brokerStopLoss: null,
      brokerTakeProfit: null,
    });
    expect(text).toMatch(/slippage -0\.20/);
    expect(text).toMatch(/WARNING/);
  });

  it('a closure states the result is broker-confirmed and net of costs', () => {
    const text = closedMessage(CTX, {
      timeframe: 'M5',
      direction: 'BUY',
      ticket: '8',
      netRealized: 4.25,
      closureReason: 'TP',
      classification: 'WIN',
    });
    expect(text).toMatch(/Broker-confirmed net realized \+4\.25/);
    expect(text).toMatch(/commission, swap and fees/i);
  });

  it('distinguishes terminal-side from broker-side rejection', () => {
    expect(
      rejectedMessage(CTX, { timeframe: 'M1', direction: 'SELL', origin: 'TERMINAL', detail: 'algo off' }),
    ).toMatch(/corrected locally/i);
    expect(
      rejectedMessage(CTX, { timeframe: 'M1', direction: 'SELL', origin: 'BROKER', detail: 'no permission' }),
    ).toMatch(/cannot be corrected from the terminal/i);
  });

  it('an incomplete liquidation never reads as flat', () => {
    expect(liquidationFailedMessage(CTX, { remaining: -1, detail: 'x' })).toMatch(/not a flat state/i);
    expect(liquidationFailedMessage(CTX, { remaining: 2, detail: 'x' })).toMatch(/2 owned item\(s\) remain/);
  });
});

describe('§13 an unlock message never reads as a trade', () => {
  it('states that no order was placed and a fresh crossing is required', () => {
    const text = lockReleasedMessage(CTX, {
      timeframe: 'M1',
      direction: 'SELL',
      rsi: 99,
      condition: 'RSI_AT_OR_ABOVE',
      threshold: 98.5,
    });
    expect(text).toMatch(/changes eligibility only/i);
    expect(text).toMatch(/No order has been placed/i);
    expect(text).toMatch(/is not replayed/i);
    expect(text).toMatch(/must return below 91 and then cross up through it again/i);
  });

  it('describes the BUY rearm path correctly', () => {
    const text = lockReleasedMessage(CTX, {
      timeframe: 'M5',
      direction: 'BUY',
      rsi: 1,
      condition: 'RSI_AT_OR_BELOW',
      threshold: 1.5,
    });
    expect(text).toMatch(/must return above 8.9 and then cross down through it again/i);
  });

  it('a lock activation names the unlock condition and the unaffected three', () => {
    const text = lockActivatedMessage(CTX, {
      timeframe: 'M5',
      direction: 'BUY',
      netRealized: -8,
      ticket: '12',
      closureReason: 'Friday liquidation',
    });
    expect(text).toMatch(/Waiting for RSI >=75 OR RSI <=1\.5\./);
    expect(text).toMatch(/M5 SELL, M1 BUY and M1 SELL are unaffected/);
  });

  it('uses the entry thresholds from the spec, not hardcoded copies', () => {
    expect(SPEC.thresholds.sellCross).toBe(91);
    expect(SPEC.thresholds.buyCross).toBe(8.9);
  });
});
