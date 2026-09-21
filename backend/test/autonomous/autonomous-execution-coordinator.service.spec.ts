import { describe, expect, it, vi } from 'vitest';
import { AutonomousExecutionCoordinatorService } from '../../src/autonomous/autonomous-execution-coordinator.service';
import { AutonomousRulesConfig } from '../../src/autonomous/autonomous-rules.config';

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

const holdAiResult = {
  mechanical: { decision: { action: 'HOLD' } } as any,
  ai: { aiDecision: null, aiRejected: false, aiRejectionReason: null, aiRawResponse: null, aiProvider: null, aiModel: null },
};

function buyAiResult() {
  return {
    mechanical: { decision: { action: 'OPEN_BUY', levelUsed: 'SUPPORT', referenceWeekStart: new Date('2026-08-31T00:00:00Z'), reasoning: 'mechanical' } } as any,
    ai: {
      aiDecision: { action: 'OPEN_BUY', confidence: 0.9, entryPrice: 1.1, stopLoss: 1.0982, takeProfit: 1.1018, positionSize: 0.01, reasoning: 'ai confirmed' },
      aiRejected: false,
      aiRejectionReason: null,
      aiRawResponse: { action: 'OPEN_BUY' },
      aiProvider: 'gemini',
      aiModel: null,
    },
  };
}

function buildService(overrides: { evaluate?: any; snapshot?: unknown; count?: number } = {}) {
  // 'snapshot' in overrides (not `??`) — a test deliberately passing `snapshot: null`
  // (meaning "no row found") must not be silently replaced by the default.
  const snapshot = 'snapshot' in overrides ? overrides.snapshot : { tradeMode: 'DEMO' };
  const aiDecisionService = { evaluate: overrides.evaluate ?? vi.fn().mockResolvedValue(holdAiResult) };
  const logger = { logAiAssisted: vi.fn().mockResolvedValue({ id: 'decision-1' }) };
  const prisma = {
    autonomousDecision: { count: vi.fn().mockResolvedValue(overrides.count ?? 0) },
    accountSnapshot: { findFirst: vi.fn().mockResolvedValue(snapshot) },
  };
  const service = new AutonomousExecutionCoordinatorService(aiDecisionService as any, logger as any, prisma as any, config());
  return { service, aiDecisionService, logger, prisma };
}

describe('AutonomousExecutionCoordinatorService', () => {
  it('never checks the risk manager when no trade was confirmed (mechanical or AI HOLD)', async () => {
    const { service, logger } = buildService();
    const result = await service.run(new Date(), 'acct-1');
    expect(result.riskManager).toBeNull();
    expect(logger.logAiAssisted).toHaveBeenCalledWith(expect.anything(), expect.anything(), null, 'acct-1', expect.anything());
  });

  it('approves a confirmed trade on a real demo account with no orders placed today', async () => {
    const { service, logger } = buildService({ evaluate: vi.fn().mockResolvedValue(buyAiResult()), count: 0, snapshot: { tradeMode: 'DEMO' } });
    const result = await service.run(new Date(), 'acct-1');
    expect(result.riskManager?.approved).toBe(true);
    const loggedRiskManager = logger.logAiAssisted.mock.calls[0][2];
    expect(loggedRiskManager.approved).toBe(true);
  });

  it('rejects a confirmed trade when the latest snapshot says the account is REAL', async () => {
    const { service } = buildService({ evaluate: vi.fn().mockResolvedValue(buyAiResult()), snapshot: { tradeMode: 'REAL' } });
    const result = await service.run(new Date(), 'acct-1');
    expect(result.riskManager?.approved).toBe(false);
    expect(result.riskManager?.rejectionReason).toMatch(/REAL/);
  });

  it('fails closed (treated as REAL, rejected) when there is no snapshot at all for the account', async () => {
    const { service } = buildService({ evaluate: vi.fn().mockResolvedValue(buyAiResult()), snapshot: null });
    const result = await service.run(new Date(), 'acct-1');
    expect(result.riskManager?.approved).toBe(false);
  });

  it('fails closed when the snapshot exists but never recorded a trade_mode', async () => {
    const { service } = buildService({ evaluate: vi.fn().mockResolvedValue(buyAiResult()), snapshot: { tradeMode: null } });
    const result = await service.run(new Date(), 'acct-1');
    expect(result.riskManager?.approved).toBe(false);
  });

  it("rejects when the friend's one-order-per-day limit is already used today, using the real count from the database", async () => {
    const { service, prisma } = buildService({ evaluate: vi.fn().mockResolvedValue(buyAiResult()), count: 1 });
    const result = await service.run(new Date(), 'acct-1');
    expect(result.riskManager?.approved).toBe(false);
    expect(result.riskManager?.rejectionReason).toMatch(/Rule 3/);
    expect(prisma.autonomousDecision.count).toHaveBeenCalled();
  });

  it("passes today's real order count through to the AI decision service too (so the AI itself also knows)", async () => {
    const { service, aiDecisionService } = buildService({ evaluate: vi.fn().mockResolvedValue(holdAiResult), count: 1 });
    await service.run(new Date(), 'acct-1');
    expect(aiDecisionService.evaluate).toHaveBeenCalledWith(expect.any(Date), 1);
  });
});
