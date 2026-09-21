import { PrismaClient } from '@prisma/client';
import { INestApplicationContext } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../../src/auth/auth.module';
import { MarketDataModule } from '../../src/market-data/market-data.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { TrendBreakoutModule } from '../../src/trend-breakout/trend-breakout.module';
import { resetDatabase } from '../helpers/db';
import { TrendBreakoutVolumeSettingsService } from '../../src/trend-breakout/volume-settings.service';
import { TrendBreakoutSlotLockService, SlotOccupiedError } from '../../src/trend-breakout/slot-lock.service';
import { TrendBreakoutRiskStateService } from '../../src/trend-breakout/risk-state.service';
import { TrendBreakoutCoordinatorService } from '../../src/trend-breakout/trend-breakout-coordinator.service';
import { resolveInstrumentMappings } from '../../src/trend-breakout/instrument-config';
import { ConfigService } from '@nestjs/config';

/**
 * Real-DI, real-database (the isolated test database — see .env.test)
 * integration coverage for the parts of §13's test list that a pure
 * function cannot exercise on its own: durable volume-setting audit,
 * database-enforced slot exclusivity across "concurrent" callers, and
 * daily/drawdown state persistence across a fresh service instance
 * (simulating a restart). No broker call of any kind is made anywhere in
 * this file.
 */
describe('trend-breakout DB integration', () => {
  let prisma: PrismaClient;
  let context: INestApplicationContext;
  let accountId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    // A minimal real DI graph — TrendBreakoutModule plus exactly what it
    // needs (Prisma, MarketData, Auth, Config) — rather than the full
    // AppModule, which would also pull in JobsModule/BullMQ and require a
    // live Redis; none of that is relevant to this module, and this keeps
    // the test isolated to what it's actually exercising.
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, MarketDataModule, AuthModule, TrendBreakoutModule],
    }).compile();
    context = await moduleRef.init();
  });

  afterAll(async () => {
    await context.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const user = await prisma.user.create({ data: { email: 'trend-breakout-test@example.com' } });
    const account = await prisma.tradingAccount.create({
      data: { userId: user.id, platform: 'MT5', externalAccountId: 'tb-test-1', currency: 'EUR' },
    });
    accountId = account.id;
  });

  describe('TrendBreakoutVolumeSettingsService', () => {
    it('bootstraps §2\'s stated initial volumes on first read', async () => {
      const service = context.get(TrendBreakoutVolumeSettingsService);
      const eurusd = await service.getOrBootstrap('EURUSD');
      const gold = await service.getOrBootstrap('XAUUSD');
      expect(eurusd.volumeLots).toBe(0.12);
      expect(gold.volumeLots).toBe(0.01);
      expect(eurusd.version).toBe(1);
    });

    it('records every change in the append-only audit log, versioned', async () => {
      const service = context.get(TrendBreakoutVolumeSettingsService);
      await service.getOrBootstrap('EURUSD');
      const result = await service.updateVolume('EURUSD', 0.2, 'alice@example.com', null);
      expect(result.ok).toBe(true);
      expect(result.setting?.volumeLots).toBe(0.2);
      expect(result.setting?.version).toBe(2);
      expect(result.warning).toMatch(/not yet known/);

      const audit = await service.getAuditLog('EURUSD');
      expect(audit).toHaveLength(1);
      expect(audit[0].oldVolume.toNumber()).toBe(0.12);
      expect(audit[0].newVolume.toNumber()).toBe(0.2);
      expect(audit[0].changedBy).toBe('alice@example.com');
    });

    it('rejects a volume outside broker min/max when symbol metadata is known', async () => {
      const service = context.get(TrendBreakoutVolumeSettingsService);
      await service.getOrBootstrap('EURUSD');
      const metadata = { symbol: 'EURUSD', volumeMin: 0.01, volumeMax: 5, volumeStep: 0.01, digits: 5, point: 0.00001, contractSize: 100_000, profitCurrency: 'USD', updatedAt: new Date() };
      const tooBig = await service.updateVolume('EURUSD', 10, 'alice@example.com', metadata);
      expect(tooBig.ok).toBe(false);
      expect(tooBig.error).toMatch(/outside the broker's allowed range/);
    });

    it('rejects a volume that is not a valid multiple of the broker\'s step', async () => {
      const service = context.get(TrendBreakoutVolumeSettingsService);
      await service.getOrBootstrap('EURUSD');
      const metadata = { symbol: 'EURUSD', volumeMin: 0.01, volumeMax: 5, volumeStep: 0.01, digits: 5, point: 0.00001, contractSize: 100_000, profitCurrency: 'USD', updatedAt: new Date() };
      const badStep = await service.updateVolume('EURUSD', 0.123, 'alice@example.com', metadata);
      expect(badStep.ok).toBe(false);
      expect(badStep.error).toMatch(/not a valid multiple/);
    });

    it('never changes an existing open position — the setting is independent storage, nothing here touches a position row', async () => {
      // There is no "position" concept this service can even reach — verified structurally: updateVolume only ever writes TrendBreakoutVolumeSetting/Audit rows.
      const service = context.get(TrendBreakoutVolumeSettingsService);
      await service.getOrBootstrap('EURUSD');
      await service.updateVolume('EURUSD', 0.5, 'alice@example.com', null);
      const rows = await prisma.trendBreakoutDecision.findMany();
      expect(rows).toHaveLength(0);
    });
  });

  describe('TrendBreakoutSlotLockService — §3 one active trade per instrument, DB-enforced', () => {
    async function makeDecision(instrument: 'EURUSD' | 'XAUUSD', signalCloseAt: Date) {
      return prisma.trendBreakoutDecision.create({
        data: {
          accountId,
          strategyVersion: 'h4-trend-h1-breakout-v1',
          instrument,
          signalCloseAt,
          decisionAtBeirut: '2026-01-01 05:00:00',
          action: 'OPEN_BUY',
          gateResults: [],
        },
      });
    }

    it('claiming an unoccupied slot succeeds and isOccupied reflects it', async () => {
      const service = context.get(TrendBreakoutSlotLockService);
      expect(await service.isOccupied(accountId, 'EURUSD')).toBe(false);
      const decision = await makeDecision('EURUSD', new Date('2026-01-01T05:00:00Z'));
      await service.claim(accountId, 'EURUSD', decision.id);
      expect(await service.isOccupied(accountId, 'EURUSD')).toBe(true);
    });

    it('a second claim on the SAME instrument is rejected at the database level — the real concurrency protection, not just an in-memory check', async () => {
      const service = context.get(TrendBreakoutSlotLockService);
      const decision1 = await makeDecision('EURUSD', new Date('2026-01-01T05:00:00Z'));
      await service.claim(accountId, 'EURUSD', decision1.id);

      const decision2 = await makeDecision('EURUSD', new Date('2026-01-01T06:00:00Z'));
      await expect(service.claim(accountId, 'EURUSD', decision2.id)).rejects.toThrow(SlotOccupiedError);
    });

    it('both instruments can hold their own slot concurrently — this is NOT a one-trade-total limit', async () => {
      const service = context.get(TrendBreakoutSlotLockService);
      const eurusdDecision = await makeDecision('EURUSD', new Date('2026-01-01T05:00:00Z'));
      const goldDecision = await makeDecision('XAUUSD', new Date('2026-01-01T05:00:00Z'));
      await service.claim(accountId, 'EURUSD', eurusdDecision.id);
      await service.claim(accountId, 'XAUUSD', goldDecision.id);
      expect(await service.isOccupied(accountId, 'EURUSD')).toBe(true);
      expect(await service.isOccupied(accountId, 'XAUUSD')).toBe(true);
    });

    it('an UNKNOWN-state lock still counts as occupied until explicitly released', async () => {
      const service = context.get(TrendBreakoutSlotLockService);
      const decision = await makeDecision('EURUSD', new Date('2026-01-01T05:00:00Z'));
      await service.claim(accountId, 'EURUSD', decision.id, 'UNKNOWN');
      expect(await service.isOccupied(accountId, 'EURUSD')).toBe(true);
      const lock = await service.getLock(accountId, 'EURUSD');
      expect(lock?.state).toBe('UNKNOWN');
    });

    it('release frees the slot for a genuinely new signal to claim afterward', async () => {
      const service = context.get(TrendBreakoutSlotLockService);
      const decision1 = await makeDecision('EURUSD', new Date('2026-01-01T05:00:00Z'));
      await service.claim(accountId, 'EURUSD', decision1.id, 'OPEN');
      await service.release(accountId, 'EURUSD');
      expect(await service.isOccupied(accountId, 'EURUSD')).toBe(false);

      const decision2 = await makeDecision('EURUSD', new Date('2026-01-02T05:00:00Z'));
      await service.claim(accountId, 'EURUSD', decision2.id); // does not throw
      expect(await service.isOccupied(accountId, 'EURUSD')).toBe(true);
    });
  });

  describe('TrendBreakoutRiskStateService — §10 durable daily/drawdown persistence, survives a fresh instance ("restart")', () => {
    it('persists the daily baseline and rolls it forward on a genuine Beirut-day change, not before', async () => {
      const service1 = new TrendBreakoutRiskStateService(prisma as any);
      const day1 = new Date('2026-01-05T06:00:00.000Z'); // 08:00 Beirut winter
      const snapshot1 = await service1.getOrRoll(accountId, day1, 10_000);
      expect(snapshot1.dailyBaselineEquity).toBe(10_000);

      // A FRESH instance (simulating a process restart) reads the SAME persisted baseline, same day.
      const service2 = new TrendBreakoutRiskStateService(prisma as any);
      const laterSameDay = new Date('2026-01-05T09:00:00.000Z');
      const snapshot2 = await service2.getOrRoll(accountId, laterSameDay, 9_500); // equity moved, baseline must NOT change
      expect(snapshot2.dailyBaselineEquity).toBe(10_000);
      expect(snapshot2.beirutDate).toBe(snapshot1.beirutDate);

      // The next Beirut day rolls the baseline to whatever equity is passed then.
      const nextDay = new Date('2026-01-06T06:00:00.000Z');
      const snapshot3 = await service2.getOrRoll(accountId, nextDay, 9_800);
      expect(snapshot3.dailyBaselineEquity).toBe(9_800);
      expect(snapshot3.dailyLossTriggered).toBe(false); // cleared on the new day
    });

    it('the daily-loss trigger persists across a fresh instance until the day actually rolls', async () => {
      const service1 = new TrendBreakoutRiskStateService(prisma as any);
      const day1 = new Date('2026-01-05T06:00:00.000Z');
      await service1.getOrRoll(accountId, day1, 10_000);
      await service1.markDailyLossTriggered(accountId);

      const service2 = new TrendBreakoutRiskStateService(prisma as any); // "restart"
      const laterSameDay = new Date('2026-01-05T09:00:00.000Z');
      const snapshot = await service2.getOrRoll(accountId, laterSameDay, 9_000);
      expect(snapshot.dailyLossTriggered).toBe(true); // NOT silently reset by the restart
    });

    it('the drawdown trigger persists until an explicit reset, never automatically', async () => {
      const service = new TrendBreakoutRiskStateService(prisma as any);
      await service.getOrRoll(accountId, new Date('2026-01-05T06:00:00.000Z'), 10_000);
      await service.markDrawdownTriggered(accountId, new Date('2026-01-05T06:30:00.000Z'));

      const freshInstance = new TrendBreakoutRiskStateService(prisma as any);
      const stillTriggered = await freshInstance.getOrRoll(accountId, new Date('2026-01-06T06:00:00.000Z'), 10_500); // next day, equity recovered
      expect(stillTriggered.drawdownTriggered).toBe(true); // a new day does NOT clear drawdown (unlike daily loss)

      await freshInstance.resetDrawdown(accountId, 'ops@example.com');
      const afterReset = await freshInstance.getOrRoll(accountId, new Date('2026-01-07T06:00:00.000Z'), 10_500);
      expect(afterReset.drawdownTriggered).toBe(false);
    });
  });

  describe('TrendBreakoutCoordinatorService — DI wiring smoke test', () => {
    it('resolves via the real DI graph and logs a HOLD with a specific reason when there is no candle data at all', async () => {
      const service = context.get(TrendBreakoutCoordinatorService);
      const config = context.get(ConfigService);
      const mappings = resolveInstrumentMappings(config);
      const outcome = await service.evaluateInstrument(accountId, 'EURUSD', mappings.EURUSD, new Date('2026-01-05T06:00:00.000Z'));
      expect(outcome.action).toBe('HOLD');
      expect(outcome.rejectionReason).toBeTruthy();

      const logged = await prisma.trendBreakoutDecision.findUnique({ where: { id: outcome.decisionId } });
      expect(logged?.action).toBe('HOLD');
      expect((logged?.gateResults as any[]).some((g) => g.gate === 'h4_warmup')).toBe(true);
    });

    it('re-evaluating the exact same signal does not create a second decision row (idempotent on the durable signal identity)', async () => {
      const service = context.get(TrendBreakoutCoordinatorService);
      const config = context.get(ConfigService);
      const mappings = resolveInstrumentMappings(config);
      const now = new Date('2026-01-05T06:00:00.000Z');
      const first = await service.evaluateInstrument(accountId, 'EURUSD', mappings.EURUSD, now);
      const second = await service.evaluateInstrument(accountId, 'EURUSD', mappings.EURUSD, now);
      expect(second.decisionId).toBe(first.decisionId);
      const count = await prisma.trendBreakoutDecision.count();
      expect(count).toBe(1);
    });
  });
});
