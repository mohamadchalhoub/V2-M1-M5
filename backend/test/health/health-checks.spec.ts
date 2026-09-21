import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  checkAiProvider,
  checkCollectorAndMt5,
  checkDatabase,
  checkTelegram,
  checkXtbImport,
} from '../../src/health/health-checks';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';

describe('health-checks (pure functions against a real Postgres, no mocks)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  describe('checkDatabase', () => {
    it('returns OK against a reachable database', async () => {
      const result = await checkDatabase(prisma as any);
      expect(result.status).toBe('OK');
    });
  });

  describe('checkCollectorAndMt5', () => {
    it('DEGRADED for both when no collector has ever reported (no accounts configured yet)', async () => {
      const { collector, mt5 } = await checkCollectorAndMt5(prisma as any, 300);
      expect(collector.status).toBe('DEGRADED');
      expect(mt5.status).toBe('DEGRADED');
    });

    it('OK/OK for a fresh heartbeat with MT5 connected', async () => {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id);
      await prisma.collectorHeartbeat.create({
        data: { accountId: account.id, lastHeartbeatAt: new Date(), mt5Connected: true },
      });

      const { collector, mt5 } = await checkCollectorAndMt5(prisma as any, 300);
      expect(collector.status).toBe('OK');
      expect(mt5.status).toBe('OK');
    });

    it('DOWN for COLLECTOR when the heartbeat is older than the stale threshold', async () => {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id);
      await prisma.collectorHeartbeat.create({
        data: {
          accountId: account.id,
          lastHeartbeatAt: new Date(Date.now() - 10 * 60_000), // 10 minutes ago
          mt5Connected: true,
        },
      });

      const { collector } = await checkCollectorAndMt5(prisma as any, 300); // 5-minute threshold
      expect(collector.status).toBe('DOWN');
    });

    it('MT5_TERMINAL is DOWN independently of a fresh, healthy collector heartbeat', async () => {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id);
      await prisma.collectorHeartbeat.create({
        data: { accountId: account.id, lastHeartbeatAt: new Date(), mt5Connected: false, lastError: 'terminal disconnected' },
      });

      const { collector, mt5 } = await checkCollectorAndMt5(prisma as any, 300);
      expect(collector.status).toBe('OK'); // collector itself is fine — still pushing
      expect(mt5.status).toBe('DOWN'); // but MT5 login dropped
    });

    it('DEGRADED (not DOWN) when only SOME accounts are unhealthy', async () => {
      const user = await createUser(prisma);
      const accountA = await createTradingAccount(prisma, user.id);
      const accountB = await createTradingAccount(prisma, user.id);
      await prisma.collectorHeartbeat.create({
        data: { accountId: accountA.id, lastHeartbeatAt: new Date(), mt5Connected: true },
      });
      await prisma.collectorHeartbeat.create({
        data: { accountId: accountB.id, lastHeartbeatAt: new Date(), mt5Connected: false },
      });

      const { mt5 } = await checkCollectorAndMt5(prisma as any, 300);
      expect(mt5.status).toBe('DEGRADED');
    });
  });

  describe('checkAiProvider', () => {
    it('OK with detail {enabled:false} when AI is disabled — off is not a failure', async () => {
      const result = await checkAiProvider(prisma as any, {
        enabled: false,
        provider: '',
        model: '',
        apiKey: '',
        requestTimeoutMs: 1000,
      });
      expect(result.status).toBe('OK');
      expect(result.detail).toEqual({ enabled: false });
    });

    it('OK when enabled with no recent failures', async () => {
      const result = await checkAiProvider(prisma as any, {
        enabled: true,
        provider: 'anthropic',
        model: 'm',
        apiKey: 'k',
        requestTimeoutMs: 1000,
      });
      expect(result.status).toBe('OK');
    });

    async function seedAnalyses(prisma: PrismaClient, statuses: Array<'READY' | 'FAILED'>) {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id);
      const rule = await prisma.ruleDefinition.create({
        data: { accountId: account.id, name: 'r', ruleType: 'DRAWDOWN', parameters: { threshold_pct: 0.03 } },
      });
      // statuses[0] is the OLDEST, statuses[last] is the MOST RECENT — explicit
      // updatedAt makes the "consecutive from most recent" ordering deterministic.
      const base = Date.now() - statuses.length * 60_000;
      for (let i = 0; i < statuses.length; i++) {
        const alert = await prisma.alert.create({
          data: { ruleId: rule.id, accountId: account.id, triggerValues: {}, baselineSnapshot: {}, ruleSnapshot: {} },
        });
        await prisma.aiAnalysis.create({
          data: { alertId: alert.id, status: statuses[i], updatedAt: new Date(base + i * 60_000) },
        });
      }
    }

    const aiConfig = { enabled: true, provider: 'anthropic', model: 'm', apiKey: 'k', requestTimeoutMs: 1000 };

    it('an old failure followed by a recent success is OK — a single blip does not degrade it', async () => {
      await seedAnalyses(prisma, ['FAILED', 'READY']); // most recent is READY
      const result = await checkAiProvider(prisma as any, aiConfig);
      expect(result.status).toBe('OK');
    });

    it('DEGRADED after 2 consecutive failures (the most recent two), not after just 1', async () => {
      await seedAnalyses(prisma, ['READY', 'FAILED']); // 1 consecutive failure — not enough
      expect((await checkAiProvider(prisma as any, aiConfig)).status).toBe('OK');

      await resetDatabase(prisma);
      await seedAnalyses(prisma, ['READY', 'FAILED', 'FAILED']); // 2 consecutive — enough
      expect((await checkAiProvider(prisma as any, aiConfig)).status).toBe('DEGRADED');
    });

    it('DOWN after 5 consecutive failures', async () => {
      await seedAnalyses(prisma, ['READY', 'FAILED', 'FAILED', 'FAILED', 'FAILED', 'FAILED']);
      const result = await checkAiProvider(prisma as any, aiConfig);
      expect(result.status).toBe('DOWN');
      expect((result.detail as any).consecutiveFailures).toBe(5);
    });
  });

  describe('checkTelegram', () => {
    const reachableBot = { checkConnectivity: async () => true } as any;
    const unreachableBot = { checkConnectivity: async () => false } as any;

    it('DOWN when getMe fails twice in a row, regardless of delivery history', async () => {
      const result = await checkTelegram(unreachableBot, prisma as any);
      expect(result.status).toBe('DOWN');
      expect(result.detail).toEqual({ reason: 'Telegram getMe unreachable (failed twice)' });
    });

    it('a single getMe blip does not flip this to DOWN — one retry recovers it, same "no single-blip degrade" reasoning as the delivery-streak check below', async () => {
      let calls = 0;
      const flakyOnceBot = {
        checkConnectivity: async () => {
          calls += 1;
          return calls > 1; // fails the first call only, succeeds every call after
        },
      } as any;
      const result = await checkTelegram(flakyOnceBot, prisma as any);
      expect(result.status).toBe('OK');
      expect(calls).toBe(2);
    });

    it('OK when reachable with no delivery history yet', async () => {
      const result = await checkTelegram(reachableBot, prisma as any);
      expect(result.status).toBe('OK');
    });

    async function seedDeliveries(prisma: PrismaClient, statuses: Array<'SENT' | 'DEAD'>) {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id);
      const rule = await prisma.ruleDefinition.create({
        data: { accountId: account.id, name: 'r', ruleType: 'DRAWDOWN', parameters: { threshold_pct: 0.03 } },
      });
      // statuses[0] is the OLDEST, statuses[last] is the MOST RECENT — explicit
      // updatedAt makes the "consecutive from most recent" ordering deterministic.
      const base = Date.now() - statuses.length * 60_000;
      for (let i = 0; i < statuses.length; i++) {
        const alert = await prisma.alert.create({
          data: { ruleId: rule.id, accountId: account.id, triggerValues: {}, baselineSnapshot: {}, ruleSnapshot: {} },
        });
        await prisma.alertDelivery.create({
          data: { alertId: alert.id, status: statuses[i], updatedAt: new Date(base + i * 60_000) },
        });
      }
    }

    it('an old DEAD followed by a recent SENT is OK — a single blip does not degrade it', async () => {
      await seedDeliveries(prisma, ['DEAD', 'SENT']); // most recent is SENT
      const result = await checkTelegram(reachableBot, prisma as any);
      expect(result.status).toBe('OK');
    });

    it('DEGRADED after 2 consecutive DEAD deliveries (the most recent two), not after just 1', async () => {
      await seedDeliveries(prisma, ['SENT', 'DEAD']); // 1 consecutive DEAD — not enough
      expect((await checkTelegram(reachableBot, prisma as any)).status).toBe('OK');

      await resetDatabase(prisma);
      await seedDeliveries(prisma, ['SENT', 'DEAD', 'DEAD']); // 2 consecutive — enough
      expect((await checkTelegram(reachableBot, prisma as any)).status).toBe('DEGRADED');
    });

    it('DOWN after 5 consecutive DEAD deliveries', async () => {
      await seedDeliveries(prisma, ['SENT', 'DEAD', 'DEAD', 'DEAD', 'DEAD', 'DEAD']);
      const result = await checkTelegram(reachableBot, prisma as any);
      expect(result.status).toBe('DOWN');
      expect((result.detail as any).consecutiveDead).toBe(5);
    });

    it('PENDING/FAILED (still-retrying) deliveries are not terminal and are ignored', async () => {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id);
      const rule = await prisma.ruleDefinition.create({
        data: { accountId: account.id, name: 'r', ruleType: 'DRAWDOWN', parameters: { threshold_pct: 0.03 } },
      });
      const alert = await prisma.alert.create({
        data: { ruleId: rule.id, accountId: account.id, triggerValues: {}, baselineSnapshot: {}, ruleSnapshot: {} },
      });
      await prisma.alertDelivery.create({ data: { alertId: alert.id, status: 'FAILED' } }); // still retrying, not terminal
      const result = await checkTelegram(reachableBot, prisma as any);
      expect(result.status).toBe('OK');
    });
  });

  describe('checkXtbImport', () => {
    it('is OK by default — no import activity is not a failure', async () => {
      const result = await checkXtbImport(prisma as any);
      expect(result.status).toBe('OK');
    });

    it('is OK when the most recent batch completed', async () => {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id, { platform: 'XTB' });
      await prisma.importBatch.create({
        data: { accountId: account.id, fileSha256: 'a'.repeat(64), status: 'COMPLETED' },
      });
      const result = await checkXtbImport(prisma as any);
      expect(result.status).toBe('OK');
    });

    it('is DOWN when the most recent batch failed', async () => {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id, { platform: 'XTB' });
      await prisma.importBatch.create({
        data: { accountId: account.id, fileSha256: 'a'.repeat(64), status: 'FAILED', error: 'boom' },
      });
      const result = await checkXtbImport(prisma as any);
      expect(result.status).toBe('DOWN');
      expect(result.detail).toMatchObject({ error: 'boom' });
    });

    it('reflects only the most recent batch, not an older failure', async () => {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id, { platform: 'XTB' });
      await prisma.importBatch.create({
        data: { accountId: account.id, fileSha256: 'a'.repeat(64), status: 'FAILED', error: 'old failure' },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await prisma.importBatch.create({
        data: { accountId: account.id, fileSha256: 'b'.repeat(64), status: 'COMPLETED' },
      });
      const result = await checkXtbImport(prisma as any);
      expect(result.status).toBe('OK');
    });
  });
});
