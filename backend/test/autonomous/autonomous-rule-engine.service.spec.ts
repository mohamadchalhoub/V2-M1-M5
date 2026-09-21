import { describe, expect, it } from 'vitest';
import { AutonomousRuleInput, evaluateAutonomousRule } from '../../src/autonomous/autonomous-rule-engine.service';
import { AutonomousRulesConfig } from '../../src/autonomous/autonomous-rules.config';
import { WeeklyRangeLevels } from '../../src/autonomous/weekly-range-levels.service';
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

function h4Levels(overrides: Partial<WeeklyRangeLevels> = {}): WeeklyRangeLevels {
  return {
    referenceWeekStart: new Date('2026-08-31T00:00:00Z'),
    referenceWeekEnd: new Date('2026-09-07T00:00:00Z'),
    resistance: 1.105,
    support: 1.099,
    candleCount: 30,
    ...overrides,
  };
}

function d1LevelsConfirming(overrides: Partial<WeeklyRangeLevels> = {}): WeeklyRangeLevels {
  // Within confluenceTolerancePoints (50) of h4Levels() on both sides by default.
  return { ...h4Levels(), resistance: 1.10505, support: 1.09902, ...overrides };
}

// A touch-and-50pt-retrace-up from support, with no volatility spike.
const supportReadyCandles: CandleData[] = [
  candle('2026-09-07T08:00:00Z', 1.0995, 1.0989, 1.0992), // touches support (low <= 1.099)
  candle('2026-09-07T08:15:00Z', 1.0996, 1.0994, 1.0995), // retraced 50pt above support
];

function baseInput(overrides: Partial<AutonomousRuleInput> = {}): AutonomousRuleInput {
  return {
    h4Levels: h4Levels(),
    d1Levels: d1LevelsConfirming(),
    activeCandles: supportReadyCandles,
    recentIntradayCandles: supportReadyCandles,
    now: new Date('2026-09-07T08:15:00Z'),
    currentPrice: { bid: 1.0995, ask: 1.09952 },
    ordersPlacedToday: 0,
    config: config(),
    ...overrides,
  };
}

describe('evaluateAutonomousRule', () => {
  it('opens a BUY when the support level is touched-and-retraced with D1 confluence', () => {
    const decision = evaluateAutonomousRule(baseInput());
    expect(decision.action).toBe('OPEN_BUY');
    expect(decision.levelUsed).toBe('SUPPORT');
    expect(decision.entryPrice).toBe(1.09952); // buys at ask
    expect(decision.stopLoss).toBeCloseTo(1.09952 - 0.0018, 6);
    expect(decision.takeProfit).toBeCloseTo(1.09952 + 0.0018, 6);
  });

  it("HOLDs when the friend's one-order-per-day limit (Rule 3) is already used", () => {
    const decision = evaluateAutonomousRule(baseInput({ ordersPlacedToday: 1 }));
    expect(decision.action).toBe('HOLD');
    expect(decision.reasoning).toMatch(/Rule 3/);
  });

  it('HOLDs when there are no H4 levels to evaluate against', () => {
    const decision = evaluateAutonomousRule(baseInput({ h4Levels: null }));
    expect(decision.action).toBe('HOLD');
  });

  it('HOLDs when there is no current price available', () => {
    const decision = evaluateAutonomousRule(baseInput({ currentPrice: null }));
    expect(decision.action).toBe('HOLD');
  });

  it("HOLDs on the friend's volatility filter when price moved too hard recently", () => {
    const spikeCandles = [candle('2026-09-07T06:30:00Z', 1.0995, 1.099, 1.0995), candle('2026-09-07T08:15:00Z', 1.106, 1.104, 1.105)]; // 550pt close-to-close move
    const decision = evaluateAutonomousRule(baseInput({ recentIntradayCandles: spikeCandles }));
    expect(decision.action).toBe('HOLD');
    expect(decision.reasoning).toMatch(/volatility/i);
  });

  it('HOLDs when the level lacks D1 confluence, even if the H4 touch-and-retrace is otherwise valid', () => {
    const decision = evaluateAutonomousRule(baseInput({ d1Levels: null }));
    expect(decision.action).toBe('HOLD');
  });

  it('HOLDs when the level has only been touched, not yet retraced enough (TOUCHED_WAITING)', () => {
    const waitingCandles = [candle('2026-09-07T08:00:00Z', 1.0995, 1.0989, 1.09895)]; // touched, barely retraced
    const decision = evaluateAutonomousRule(baseInput({ activeCandles: waitingCandles, recentIntradayCandles: waitingCandles, currentPrice: { bid: 1.09895, ask: 1.09897 } }));
    expect(decision.action).toBe('HOLD');
  });

  it("HOLDs (does not trade) once a level has broken, per the friend's Rule 5", () => {
    const brokenCandles = [candle('2026-09-07T08:00:00Z', 1.0995, 1.0985, 1.0995)]; // 50pt undershoot = broken
    const decision = evaluateAutonomousRule(baseInput({ activeCandles: brokenCandles, recentIntradayCandles: brokenCandles }));
    expect(decision.action).toBe('HOLD');
  });

  it('opens a SELL when the resistance level is touched-and-retraced with D1 confluence', () => {
    const resistanceCandles = [
      candle('2026-09-07T08:00:00Z', 1.1051, 1.1045, 1.1048), // touches resistance
      candle('2026-09-07T08:15:00Z', 1.1046, 1.1044, 1.1045), // retraced 50pt below resistance
    ];
    const decision = evaluateAutonomousRule(
      baseInput({ activeCandles: resistanceCandles, recentIntradayCandles: resistanceCandles, currentPrice: { bid: 1.10444, ask: 1.10446 } }), // mid retraced 55pt below resistance
    );
    expect(decision.action).toBe('OPEN_SELL');
    expect(decision.levelUsed).toBe('RESISTANCE');
    expect(decision.entryPrice).toBe(1.10444); // sells at bid
  });

  it("every decision's reasoning is non-empty", () => {
    const scenarios: AutonomousRuleInput[] = [baseInput({ ordersPlacedToday: 1 }), baseInput({ h4Levels: null }), baseInput({ d1Levels: null }), baseInput()];
    for (const scenario of scenarios) {
      expect(evaluateAutonomousRule(scenario).reasoning.length).toBeGreaterThan(0);
    }
  });
});
