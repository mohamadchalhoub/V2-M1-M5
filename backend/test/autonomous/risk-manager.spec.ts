import { describe, expect, it } from 'vitest';
import { evaluateRiskManager, RiskManagerAccountInfo, RiskManagerInput } from '../../src/autonomous/risk-manager';
import { AutonomousAiDecision } from '../../src/autonomous/autonomous-ai-decision.types';
import { AutonomousRulesConfig } from '../../src/autonomous/autonomous-rules.config';

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

function demoAccount(overrides: Partial<RiskManagerAccountInfo> = {}): RiskManagerAccountInfo {
  return { tradeMode: 'DEMO', ...overrides };
}

function buyDecision(overrides: Partial<AutonomousAiDecision> = {}): AutonomousAiDecision {
  return {
    action: 'OPEN_BUY',
    confidence: 0.8,
    entryPrice: 1.1,
    stopLoss: 1.1 - 0.0018,
    takeProfit: 1.1 + 0.0018,
    positionSize: 0.01,
    reasoning: 'valid setup',
    ...overrides,
  };
}

function holdDecision(): AutonomousAiDecision {
  return { action: 'HOLD', confidence: 0.2, entryPrice: null, stopLoss: null, takeProfit: null, positionSize: null, reasoning: 'no setup' };
}

function input(overrides: Partial<RiskManagerInput> = {}): RiskManagerInput {
  return {
    decision: buyDecision(),
    accountInfo: demoAccount(),
    ordersPlacedToday: 0,
    killSwitchActive: false,
    config: config(),
    ...overrides,
  };
}

describe('evaluateRiskManager', () => {
  it('approves a well-formed OPEN_BUY on a demo account with no orders placed today', () => {
    const verdict = evaluateRiskManager(input());
    expect(verdict.approved).toBe(true);
    expect(verdict.rejectionReason).toBeNull();
  });

  it('approves a HOLD unconditionally (nothing to validate, no order to place)', () => {
    const verdict = evaluateRiskManager(input({ decision: holdDecision() }));
    expect(verdict.approved).toBe(true);
  });

  it('rejects everything, including a HOLD, when the kill switch is active', () => {
    expect(evaluateRiskManager(input({ killSwitchActive: true })).approved).toBe(false);
    expect(evaluateRiskManager(input({ killSwitchActive: true, decision: holdDecision() })).approved).toBe(false);
  });

  it('rejects a real-money account outright — the single most safety-critical check', () => {
    const verdict = evaluateRiskManager(input({ accountInfo: demoAccount({ tradeMode: 'REAL' }) }));
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/REAL/);
  });

  it('rejects a CONTEST-mode account too — only DEMO is ever acceptable', () => {
    const verdict = evaluateRiskManager(input({ accountInfo: demoAccount({ tradeMode: 'CONTEST' }) }));
    expect(verdict.approved).toBe(false);
  });

  it("rejects when the friend's one-order-per-day limit is already used", () => {
    const verdict = evaluateRiskManager(input({ ordersPlacedToday: 1 }));
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/Rule 3/);
  });

  it('rejects an order with a position size other than the hardcoded 0.01 max, even if the AI somehow produced one', () => {
    const verdict = evaluateRiskManager(input({ decision: buyDecision({ positionSize: 1 }) }));
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/Position size/);
  });

  it('rejects an order with a stop-loss at the wrong distance, independently of AI-layer validation', () => {
    const verdict = evaluateRiskManager(input({ decision: buyDecision({ stopLoss: 1.1 - 0.005 }) }));
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/Stop-loss/);
  });

  it('rejects an order with a take-profit at the wrong distance', () => {
    const verdict = evaluateRiskManager(input({ decision: buyDecision({ takeProfit: 1.1 + 0.005 }) }));
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/Take-profit/);
  });

  it('rejects an OPEN_SELL whose stop-loss/take-profit are on the wrong side of entry', () => {
    const verdict = evaluateRiskManager(input({ decision: buyDecision({ action: 'OPEN_SELL', stopLoss: 1.1 - 0.0018, takeProfit: 1.1 + 0.0018 }) }));
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/OPEN_SELL/);
  });

  it('rejects an order missing a required field', () => {
    const verdict = evaluateRiskManager(input({ decision: buyDecision({ stopLoss: null }) }));
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/missing/);
  });

  it('respects a differently-configured SL/TP distance', () => {
    const decision = buyDecision({ stopLoss: 1.1 - 0.001, takeProfit: 1.1 + 0.001 });
    const verdict = evaluateRiskManager(input({ decision, config: config({ stopLossPoints: 100, takeProfitPoints: 100 }) }));
    expect(verdict.approved).toBe(true);
  });

  it('the kill switch and demo-account checks take priority over everything else, including on a HOLD', () => {
    // Even a HOLD must not be "approved" on a non-demo account — approval here would be a
    // meaningless no-op today, but the check must never depend on the requested action.
    const verdict = evaluateRiskManager(input({ decision: holdDecision(), accountInfo: demoAccount({ tradeMode: 'REAL' }) }));
    expect(verdict.approved).toBe(false);
  });
});
