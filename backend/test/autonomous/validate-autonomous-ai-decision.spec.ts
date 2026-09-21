import { describe, expect, it } from 'vitest';
import { validateAutonomousAiDecision } from '../../src/autonomous/validate-autonomous-ai-decision';
import { AutonomousRulesConfig } from '../../src/autonomous/autonomous-rules.config';
import { RawAutonomousAiDecision } from '../../src/autonomous/autonomous-ai-decision.types';

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

function validBuy(overrides: Partial<RawAutonomousAiDecision> = {}): RawAutonomousAiDecision {
  return {
    action: 'OPEN_BUY',
    confidence: 0.8,
    entry_price: 1.1,
    stop_loss: 1.1 - 0.0018,
    take_profit: 1.1 + 0.0018,
    position_size: 0.01,
    reasoning: 'Matches the friend\'s rules.',
    ...overrides,
  };
}

describe('validateAutonomousAiDecision', () => {
  it('accepts a well-formed OPEN_BUY with exact SL/TP distances', () => {
    const decision = validateAutonomousAiDecision(validBuy(), config());
    expect(decision.action).toBe('OPEN_BUY');
    expect(decision.entryPrice).toBe(1.1);
  });

  it('accepts a well-formed OPEN_SELL with exact SL/TP distances', () => {
    const raw = validBuy({ action: 'OPEN_SELL', stop_loss: 1.1 + 0.0018, take_profit: 1.1 - 0.0018 });
    const decision = validateAutonomousAiDecision(raw, config());
    expect(decision.action).toBe('OPEN_SELL');
  });

  it('accepts a well-formed HOLD with all price fields null', () => {
    const decision = validateAutonomousAiDecision({ action: 'HOLD', confidence: 0.3, reasoning: 'No valid setup.' }, config());
    expect(decision.action).toBe('HOLD');
    expect(decision.entryPrice).toBeNull();
  });

  it('tolerates tiny floating-point noise in the SL/TP distance', () => {
    const raw = validBuy({ stop_loss: 1.1 - 0.0018 + 0.0000001, take_profit: 1.1 + 0.0018 - 0.0000001 });
    expect(() => validateAutonomousAiDecision(raw, config())).not.toThrow();
  });

  it('rejects an unknown action', () => {
    expect(() => validateAutonomousAiDecision({ action: 'SELL_EVERYTHING', confidence: 0.5, reasoning: 'x' }, config())).toThrow(/action/);
  });

  it('rejects CLOSE_POSITION outright — no execution module exists to have a position to close', () => {
    expect(() => validateAutonomousAiDecision({ action: 'CLOSE_POSITION', confidence: 0.5, reasoning: 'x' }, config())).toThrow(/CLOSE_POSITION/);
  });

  it('rejects a confidence outside 0-1', () => {
    expect(() => validateAutonomousAiDecision(validBuy({ confidence: 1.5 }), config())).toThrow(/confidence/);
  });

  it('rejects empty reasoning', () => {
    expect(() => validateAutonomousAiDecision(validBuy({ reasoning: '   ' }), config())).toThrow(/reasoning/);
  });

  it('rejects a position_size other than exactly 0.01', () => {
    expect(() => validateAutonomousAiDecision(validBuy({ position_size: 0.1 }), config())).toThrow(/position_size/);
  });

  it('rejects a stop_loss at the wrong distance from entry', () => {
    expect(() => validateAutonomousAiDecision(validBuy({ stop_loss: 1.1 - 0.005 }), config())).toThrow(/stop_loss/);
  });

  it('rejects a take_profit at the wrong distance from entry', () => {
    expect(() => validateAutonomousAiDecision(validBuy({ take_profit: 1.1 + 0.005 }), config())).toThrow(/take_profit/);
  });

  it('rejects an OPEN_BUY whose stop_loss/take_profit are on the wrong side of entry despite the right distance', () => {
    // Distances are exactly right, but SL/TP are swapped — a BUY with SL above and TP below is nonsensical.
    const raw = validBuy({ stop_loss: 1.1 + 0.0018, take_profit: 1.1 - 0.0018 });
    expect(() => validateAutonomousAiDecision(raw, config())).toThrow(/OPEN_BUY/);
  });

  it('rejects a non-numeric entry_price when opening a position', () => {
    expect(() => validateAutonomousAiDecision(validBuy({ entry_price: 'high' }), config())).toThrow(/entry_price/);
  });

  it('respects a different configured SL/TP distance', () => {
    const raw = validBuy({ stop_loss: 1.1 - 0.001, take_profit: 1.1 + 0.001 });
    const decision = validateAutonomousAiDecision(raw, config({ stopLossPoints: 100, takeProfitPoints: 100 }));
    expect(decision.action).toBe('OPEN_BUY');
  });
});
