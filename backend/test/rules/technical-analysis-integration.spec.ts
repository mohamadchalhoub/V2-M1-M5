// User's custom EURUSD trading rules — real end-to-end wiring: seeded
// HistoricalCandle rows (real DB rows, not fixture arrays) -> RuleEngineService
// -> technical-analysis services -> a deterministic Alert with rich
// triggerValues. Complements the pure-function unit tests in
// test/technical-analysis/ and test/rules/evaluators/, which cover the
// calculation logic in isolation; this proves buildExtras actually wires
// real candle data into it.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';
import { RuleDefinitionsService } from '../../src/rules/rule-definitions.service';
import { RuleEngineService } from '../../src/alerts/rule-engine.service';

const NOW = new Date('2026-01-05T10:00:00Z');

async function seedCandle(prisma: PrismaClient, timeframe: string, openTime: Date, high: number, low: number, close?: number) {
  await prisma.historicalCandle.create({
    data: { symbol: 'EURUSD', timeframe: timeframe as any, openTime, open: (high + low) / 2, high, low, close: close ?? (high + low) / 2, source: 'MT5' },
  });
}

async function seedFlatSeries(prisma: PrismaClient, timeframe: string, count: number, hourStepMs: number, high: number, low: number, startTime: Date) {
  for (let i = 0; i < count; i++) {
    await seedCandle(prisma, timeframe, new Date(startTime.getTime() + i * hourStepMs), high, low);
  }
}

describe('technical-analysis rule types (real DB-seeded candles)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;
  let ruleDefinitions: RuleDefinitionsService;
  let ruleEngine: RuleEngineService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = new PrismaClient();
    ruleDefinitions = app.get(RuleDefinitionsService);
    ruleEngine = app.get(RuleEngineService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  async function account() {
    const user = await createUser(prisma);
    return createTradingAccount(prisma, user.id);
  }

  it('SUPPORT_RESISTANCE_PROXIMITY: INSUFFICIENT_DATA when there is no EURUSD candle data at all', async () => {
    const acc = await account();
    await ruleDefinitions.create(acc.id, { name: 'sr', ruleType: 'SUPPORT_RESISTANCE_PROXIMITY', parameters: {}, cooldownSeconds: 60 });

    await ruleEngine.evaluateAccount(acc.id, NOW);

    const alerts = await prisma.alert.findMany();
    expect(alerts).toHaveLength(0); // INSUFFICIENT_DATA never creates an Alert
  });

  it('SUPPORT_RESISTANCE_PROXIMITY: a real seeded pivot near the current price produces a TRIGGERED alert with rich triggerValues', async () => {
    const acc = await account();
    await ruleDefinitions.create(acc.id, { name: 'sr', ruleType: 'SUPPORT_RESISTANCE_PROXIMITY', parameters: {}, cooldownSeconds: 60 });

    // A clean H1 resistance pivot at 1.2000 (2 flat candles either side),
    // seeded far enough back to sit inside the H1 lookback window.
    const pivotTime = new Date(NOW.getTime() - 10 * 3600_000);
    await seedCandle(prisma, 'H1', new Date(pivotTime.getTime() - 2 * 3600_000), 1.1, 1.08);
    await seedCandle(prisma, 'H1', new Date(pivotTime.getTime() - 1 * 3600_000), 1.12, 1.09);
    await seedCandle(prisma, 'H1', pivotTime, 1.2, 1.15); // the pivot
    await seedCandle(prisma, 'H1', new Date(pivotTime.getTime() + 1 * 3600_000), 1.12, 1.09);
    await seedCandle(prisma, 'H1', new Date(pivotTime.getTime() + 2 * 3600_000), 1.1, 1.08);

    // Current EURUSD price (latest M5 close) 40 points below the 1.2000 pivot.
    await seedCandle(prisma, 'M5', new Date(NOW.getTime() - 5 * 60_000), 1.1997, 1.1995, 1.1996);

    await ruleEngine.evaluateAccount(acc.id, NOW);

    const alerts = await prisma.alert.findMany();
    expect(alerts).toHaveLength(1);
    const triggerValues = alerts[0].triggerValues as any;
    expect(triggerValues).toMatchObject({ symbol: 'EURUSD', timeframe: 'H1', levelType: 'RESISTANCE', levelPrice: 1.2, currentPrice: 1.1996 });
    expect(triggerValues.distancePoints).toBeCloseTo(40, 0);
    expect(triggerValues.trend).toBe('UNKNOWN'); // only one M5 candle in the 30-minute window — no prior price to compare
  });

  it('SUPPORT_RESISTANCE_PROXIMITY: trend is APPROACHING when a real earlier M5 candle shows price moving toward the level', async () => {
    const acc = await account();
    await ruleDefinitions.create(acc.id, { name: 'sr', ruleType: 'SUPPORT_RESISTANCE_PROXIMITY', parameters: {}, cooldownSeconds: 60 });

    const pivotTime = new Date(NOW.getTime() - 10 * 3600_000);
    await seedCandle(prisma, 'H1', new Date(pivotTime.getTime() - 2 * 3600_000), 1.1, 1.08);
    await seedCandle(prisma, 'H1', new Date(pivotTime.getTime() - 1 * 3600_000), 1.12, 1.09);
    await seedCandle(prisma, 'H1', pivotTime, 1.2, 1.15); // the pivot, resistance at 1.2000
    await seedCandle(prisma, 'H1', new Date(pivotTime.getTime() + 1 * 3600_000), 1.12, 1.09);
    await seedCandle(prisma, 'H1', new Date(pivotTime.getTime() + 2 * 3600_000), 1.1, 1.08);

    // Two M5 closes inside the 30-minute window: price moved from 1.1990 (100 points from the level) up to 1.1996 (40 points from the level) — approaching.
    await seedCandle(prisma, 'M5', new Date(NOW.getTime() - 10 * 60_000), 1.1991, 1.1989, 1.199);
    await seedCandle(prisma, 'M5', new Date(NOW.getTime() - 5 * 60_000), 1.1997, 1.1995, 1.1996);

    await ruleEngine.evaluateAccount(acc.id, NOW);

    const alerts = await prisma.alert.findMany();
    expect(alerts).toHaveLength(1);
    expect((alerts[0].triggerValues as any).trend).toBe('APPROACHING');
  });

  it('the normal snapshot-driven evaluateAccount call excludes DAILY_MARKET_ANALYSIS by default', async () => {
    const acc = await account();
    await ruleDefinitions.create(acc.id, { name: 'daily', ruleType: 'DAILY_MARKET_ANALYSIS', parameters: {}, cooldownSeconds: 60 });

    const results = await ruleEngine.evaluateAccount(acc.id, NOW); // no ruleTypeFilter — the snapshot-driven path
    expect(results).toHaveLength(0);
    expect(await prisma.alert.count()).toBe(0);
  });

  it('DAILY_MARKET_ANALYSIS: with ruleTypeFilter, produces a TRIGGERED alert carrying the full combined payload', async () => {
    const acc = await account();
    await ruleDefinitions.create(acc.id, { name: 'daily', ruleType: 'DAILY_MARKET_ANALYSIS', parameters: {}, cooldownSeconds: 60 });

    await seedCandle(prisma, 'M5', new Date(NOW.getTime() - 5 * 60_000), 1.1051, 1.1049, 1.105);
    // 60 D1 candles for Fibonacci/market-direction (well within the 90-day default lookback).
    for (let i = 0; i < 60; i++) {
      await seedCandle(prisma, 'D1', new Date(NOW.getTime() - (60 - i) * 86_400_000), 1.1 + i * 0.001, 1.09 + i * 0.001);
    }
    // A little H4 data too — insufficient for a full Ichimoku cloud (that's fine, expressed as null spanA/spanB, not a crash).
    for (let i = 0; i < 10; i++) {
      await seedCandle(prisma, 'H4', new Date(NOW.getTime() - (10 - i) * 4 * 3600_000), 1.1 + i * 0.001, 1.09 + i * 0.001);
    }

    const results = await ruleEngine.evaluateAccount(acc.id, NOW, { ruleTypeFilter: ['DAILY_MARKET_ANALYSIS'] as any });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('TRIGGERED');

    const alerts = await prisma.alert.findMany();
    expect(alerts).toHaveLength(1);
    const payload = alerts[0].triggerValues as any;
    expect(payload.symbol).toBe('EURUSD');
    expect(payload.currentPrice).toBe(1.105);
    expect(['BULLISH', 'BEARISH', 'NEUTRAL']).toContain(payload.marketBias);
    expect(payload.fibonacci).not.toBeNull();
    expect(Array.isArray(payload.supportResistance)).toBe(true);
    expect(Array.isArray(payload.ichimoku)).toBe(true);
  });

  describe('DAILY_MARKET_ANALYSIS — every real trigger is a fresh episode (AI narration every day, not just the first)', () => {
    async function seedDailyAnalysisData(prisma: PrismaClient, now: Date) {
      await seedCandle(prisma, 'M5', new Date(now.getTime() - 5 * 60_000), 1.1051, 1.1049, 1.105);
      for (let i = 0; i < 60; i++) {
        await seedCandle(prisma, 'D1', new Date(now.getTime() - (60 - i) * 86_400_000), 1.1 + i * 0.001, 1.09 + i * 0.001);
      }
      for (let i = 0; i < 10; i++) {
        await seedCandle(prisma, 'H4', new Date(now.getTime() - (10 - i) * 4 * 3600_000), 1.1 + i * 0.001, 1.09 + i * 0.001);
      }
    }

    it('a real trigger resets rule_state to INACTIVE immediately (not left ACTIVE like a continuous-condition rule)', async () => {
      const acc = await account();
      const rule = await ruleDefinitions.create(acc.id, { name: 'daily', ruleType: 'DAILY_MARKET_ANALYSIS', parameters: {}, cooldownSeconds: 82_800 });
      await seedDailyAnalysisData(prisma, NOW);

      await ruleEngine.evaluateAccount(acc.id, NOW, { ruleTypeFilter: ['DAILY_MARKET_ANALYSIS'] as any });

      const state = await prisma.ruleState.findUnique({ where: { ruleId: rule.id } });
      expect(state?.state).toBe('INACTIVE');
    });

    it('a real trigger creates an AiAnalysis row — the bug this fix closes (previously only the very first-ever trigger got one)', async () => {
      const acc = await account();
      await ruleDefinitions.create(acc.id, { name: 'daily', ruleType: 'DAILY_MARKET_ANALYSIS', parameters: {}, cooldownSeconds: 82_800 });
      await seedDailyAnalysisData(prisma, NOW);

      await ruleEngine.evaluateAccount(acc.id, NOW, { ruleTypeFilter: ['DAILY_MARKET_ANALYSIS'] as any });

      const alert = await prisma.alert.findFirstOrThrow();
      const aiAnalysis = await prisma.aiAnalysis.findUnique({ where: { alertId: alert.id } });
      expect(aiAnalysis).not.toBeNull();
    });

    it('evaluating again the SAME day does not create a second alert (same-day dedup, now that cooldown no longer gates this rule)', async () => {
      const acc = await account();
      await ruleDefinitions.create(acc.id, { name: 'daily', ruleType: 'DAILY_MARKET_ANALYSIS', parameters: {}, cooldownSeconds: 82_800 });
      await seedDailyAnalysisData(prisma, NOW);

      await ruleEngine.evaluateAccount(acc.id, NOW, { ruleTypeFilter: ['DAILY_MARKET_ANALYSIS'] as any });
      const laterSameDay = new Date(NOW.getTime() + 2 * 3600_000);
      const results = await ruleEngine.evaluateAccount(acc.id, laterSameDay, { ruleTypeFilter: ['DAILY_MARKET_ANALYSIS'] as any });

      expect(results[0].status).toBe('INSUFFICIENT_DATA');
      expect(await prisma.alert.count()).toBe(1);
    });

    it('evaluating the NEXT day creates a second alert with its OWN AiAnalysis row — the actual fix: every day gets AI narration, not just day one', async () => {
      const acc = await account();
      await ruleDefinitions.create(acc.id, { name: 'daily', ruleType: 'DAILY_MARKET_ANALYSIS', parameters: {}, cooldownSeconds: 82_800 });
      await seedDailyAnalysisData(prisma, NOW);

      await ruleEngine.evaluateAccount(acc.id, NOW, { ruleTypeFilter: ['DAILY_MARKET_ANALYSIS'] as any });

      // Only a fresh M5 "current price" candle for the new day — the D1/H4
      // history seeded above is still valid, real data for the next
      // evaluation too (re-seeding the same historical window would collide
      // on (symbol, timeframe, openTime), since it's genuinely the same
      // candles, not new ones).
      const nextDay = new Date(NOW.getTime() + 24 * 3600_000);
      await seedCandle(prisma, 'M5', new Date(nextDay.getTime() - 5 * 60_000), 1.1061, 1.1059, 1.106);
      const results = await ruleEngine.evaluateAccount(acc.id, nextDay, { ruleTypeFilter: ['DAILY_MARKET_ANALYSIS'] as any });

      expect(results[0].status).toBe('TRIGGERED');
      const alerts = await prisma.alert.findMany({ orderBy: { triggeredAt: 'asc' } });
      expect(alerts).toHaveLength(2);
      const secondAiAnalysis = await prisma.aiAnalysis.findUnique({ where: { alertId: alerts[1].id } });
      expect(secondAiAnalysis).not.toBeNull();
    });
  });
});
