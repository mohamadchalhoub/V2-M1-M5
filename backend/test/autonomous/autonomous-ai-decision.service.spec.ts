import { describe, expect, it, vi } from 'vitest';
import { AutonomousAiDecisionService } from '../../src/autonomous/autonomous-ai-decision.service';
import { AutonomousRulesConfig } from '../../src/autonomous/autonomous-rules.config';
import { AutonomousEvaluationResult } from '../../src/autonomous/autonomous-rule-engine.service';

function config(): AutonomousRulesConfig {
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
  };
}

function holdResult(): AutonomousEvaluationResult {
  return {
    decision: { action: 'HOLD', symbol: 'EURUSD', entryPrice: null, stopLoss: null, takeProfit: null, levelUsed: null, referenceWeekStart: null, reasoning: 'no setup' },
    h4Levels: null,
    d1Levels: null,
    currentPrice: null,
    supportState: null,
    resistanceState: null,
  };
}

function buyCandidateResult(): AutonomousEvaluationResult {
  return {
    decision: {
      action: 'OPEN_BUY',
      symbol: 'EURUSD',
      entryPrice: 1.1002,
      stopLoss: 1.0984,
      takeProfit: 1.102,
      levelUsed: 'SUPPORT',
      referenceWeekStart: new Date('2026-08-31T00:00:00Z'),
      reasoning: 'mechanical candidate',
    },
    h4Levels: { referenceWeekStart: new Date('2026-08-31T00:00:00Z'), referenceWeekEnd: new Date('2026-09-07T00:00:00Z'), resistance: 1.105, support: 1.099, candleCount: 30 },
    d1Levels: { referenceWeekStart: new Date('2026-08-31T00:00:00Z'), referenceWeekEnd: new Date('2026-09-07T00:00:00Z'), resistance: 1.10505, support: 1.09902, candleCount: 5 },
    currentPrice: { bid: 1.1, ask: 1.1002 },
    supportState: 'READY',
    resistanceState: 'NOT_TOUCHED',
  };
}

function buildService(overrides: { evaluate?: ReturnType<typeof vi.fn>; decide?: ReturnType<typeof vi.fn> } = {}) {
  const ruleEngine = { evaluate: overrides.evaluate ?? vi.fn().mockResolvedValue(holdResult()) };
  const historicalPattern = { build: vi.fn().mockResolvedValue({ symbol: 'EURUSD', buy: { sampleSize: 0, winRate: null, averagePnl: null, confidence: 'LOW' }, sell: { sampleSize: 0, winRate: null, averagePnl: null, confidence: 'LOW' } }) };
  const marketEvents = { findUpcomingHighImpactEvents: vi.fn().mockResolvedValue([]), findRecentNews: vi.fn().mockResolvedValue([]) };
  const aiProvider = { decide: overrides.decide ?? vi.fn() };
  const service = new AutonomousAiDecisionService(ruleEngine as any, historicalPattern as any, marketEvents as any, aiProvider as any, config());
  return { service, ruleEngine, historicalPattern, marketEvents, aiProvider };
}

describe('AutonomousAiDecisionService', () => {
  it('never invokes the AI when the mechanical engine itself says HOLD', async () => {
    const { service, historicalPattern, marketEvents, aiProvider } = buildService();
    const { ai } = await service.evaluate(new Date(), 0);
    expect(ai.aiDecision).toBeNull();
    expect(ai.aiRejected).toBe(false);
    expect(historicalPattern.build).not.toHaveBeenCalled();
    expect(marketEvents.findUpcomingHighImpactEvents).not.toHaveBeenCalled();
    expect(aiProvider.decide).not.toHaveBeenCalled();
  });

  it('invokes the AI with the mechanical context when a candidate exists, and returns its validated decision', async () => {
    const decide = vi.fn().mockResolvedValue({
      action: 'OPEN_BUY',
      confidence: 0.9,
      entry_price: 1.1002,
      stop_loss: 1.1002 - 0.0018,
      take_profit: 1.1002 + 0.0018,
      position_size: 0.01,
      reasoning: 'Confirmed: touched support, retraced, D1 confluence holds.',
    });
    const { service, aiProvider } = buildService({ evaluate: vi.fn().mockResolvedValue(buyCandidateResult()), decide });
    const { ai } = await service.evaluate(new Date(), 0);

    expect(aiProvider.decide).toHaveBeenCalledTimes(1);
    const contextArg = decide.mock.calls[0][0];
    expect(contextArg.mechanicalCandidateLevel).toBe('SUPPORT');
    expect(contextArg.supportState).toBe('READY');

    expect(ai.aiRejected).toBe(false);
    expect(ai.aiDecision!.action).toBe('OPEN_BUY');
  });

  it('marks the result rejected when the AI vetoes with an invalid response, without throwing', async () => {
    const decide = vi.fn().mockResolvedValue({ action: 'HOLD' }); // missing confidence/reasoning — invalid
    const { service } = buildService({ evaluate: vi.fn().mockResolvedValue(buyCandidateResult()), decide });
    const { ai } = await service.evaluate(new Date(), 0);
    expect(ai.aiRejected).toBe(true);
    expect(ai.aiDecision).toBeNull();
    expect(ai.aiRejectionReason).toMatch(/confidence/);
  });

  it('marks the result rejected when the AI provider itself throws a non-transient error', async () => {
    // Deliberately NOT a transient-error pattern (retry.ts's isTransientAiError) — a message
    // like "returned 500" would trigger real retry delays and slow this test down for nothing.
    const decide = vi.fn().mockRejectedValue(new Error('Gemini response was not valid JSON'));
    const { service } = buildService({ evaluate: vi.fn().mockResolvedValue(buyCandidateResult()), decide });
    const { ai } = await service.evaluate(new Date(), 0);
    expect(ai.aiRejected).toBe(true);
    expect(ai.aiRejectionReason).toMatch(/Gemini/);
  });

  it('a valid AI HOLD veto is reported as a non-rejected decision, not a rejection', async () => {
    const decide = vi.fn().mockResolvedValue({ action: 'HOLD', confidence: 0.4, reasoning: 'News risk too high right now.' });
    const { service } = buildService({ evaluate: vi.fn().mockResolvedValue(buyCandidateResult()), decide });
    const { ai } = await service.evaluate(new Date(), 0);
    expect(ai.aiRejected).toBe(false);
    expect(ai.aiDecision!.action).toBe('HOLD');
  });
});
