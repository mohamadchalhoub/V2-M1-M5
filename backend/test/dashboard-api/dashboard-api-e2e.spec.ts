// End-to-end tests for the Phase 9 read-only dashboard endpoints: real
// Postgres, real HTTP layer (Fastify inject), data seeded directly via
// Prisma (same pattern as health-e2e.spec.ts) rather than through the
// collector's authenticated ingestion path, since these endpoints don't
// care how the data got there.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { createDashboardToken, createTradingAccount, createUser } from '../helpers/factories';
import { request } from '../helpers/http';

describe('Phase 9 — dashboard read endpoints (end-to-end)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = new PrismaClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  describe('GET /accounts', () => {
    it('lists accounts across users, newest-created-last', async () => {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id);
      const { plaintext: token } = await createDashboardToken(prisma, account.id);

      const res = await request(app, {
        method: 'GET',
        url: '/accounts',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const found = res.body.find((a: any) => a.id === account.id);
      expect(found).toBeDefined();
      expect(found).not.toHaveProperty('userId'); // select excludes FK/internal fields
    });

    // A dashboard token can only ever request its own bound account (an
    // ApiCredential.accountId FK, so a token can't even be minted against a
    // nonexistent one) — DashboardTokenGuard rejects any other accountId
    // with 403 before the controller's own not-found lookup ever runs, so
    // an unknown-to-this-token account now reads as 403, not 404.
    it("GET /accounts/:id returns 403 for an account the token isn't bound to", async () => {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id);
      const { plaintext: token } = await createDashboardToken(prisma, account.id);

      const res = await request(app, {
        method: 'GET',
        url: '/accounts/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('trading-data read endpoints', () => {
    it('returns the latest snapshot, open positions, and paginated trades', async () => {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id);
      const { plaintext: token } = await createDashboardToken(prisma, account.id);

      await prisma.accountSnapshot.create({
        data: {
          accountId: account.id,
          balance: 1000,
          equity: 1000,
          margin: 0,
          freeMargin: 1000,
          profit: 0,
          capturedAt: new Date(Date.now() - 60_000),
        },
      });
      await prisma.accountSnapshot.create({
        data: {
          accountId: account.id,
          balance: 1050,
          equity: 1050,
          margin: 0,
          freeMargin: 1050,
          profit: 50,
          capturedAt: new Date(),
        },
      });
      await prisma.position.create({
        data: {
          accountId: account.id,
          platform: 'MT5',
          externalPositionId: 'p1',
          symbol: 'EURUSD',
          side: 'BUY',
          volume: 0.1,
          openPrice: 1.1,
          profit: 0,
          swap: 0,
          status: 'OPEN',
          openedAt: new Date(),
        },
      });
      for (let i = 0; i < 3; i++) {
        await prisma.trade.create({
          data: {
            accountId: account.id,
            platform: 'MT5',
            externalTradeId: `t${i}`,
            symbol: 'EURUSD',
            side: 'SELL',
            dealEntry: 'OUT',
            volume: 0.1,
            price: 1.1,
            profit: 5,
            executedAt: new Date(Date.now() - i * 1000),
          },
        });
      }

      const snapshot = await request(app, {
        method: 'GET',
        url: `/accounts/${account.id}/snapshots/latest`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(snapshot.statusCode).toBe(200);
      expect(Number(snapshot.body.balance)).toBe(1050);

      const positions = await request(app, {
        method: 'GET',
        url: `/accounts/${account.id}/positions`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(positions.statusCode).toBe(200);
      expect(positions.body).toHaveLength(1);

      const trades = await request(app, {
        method: 'GET',
        url: `/accounts/${account.id}/trades?limit=2`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(trades.statusCode).toBe(200);
      expect(trades.body.trades).toHaveLength(2);
      expect(trades.body.total).toBe(3);
      expect(trades.body.limit).toBe(2);
    });

    // Same guard-before-controller reasoning as the accounts-controller
    // test above: a token can only be minted bound to a real account, so
    // requesting an account it isn't bound to now fails closed at 403.
    it("403s trading-data reads for an account the token isn't bound to", async () => {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id);
      const { plaintext: token } = await createDashboardToken(prisma, account.id);

      const res = await request(app, {
        method: 'GET',
        url: '/accounts/00000000-0000-0000-0000-000000000000/trades',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /accounts/:accountId/rules', () => {
    it('lists rules with their current run state', async () => {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id);
      const { plaintext: token } = await createDashboardToken(prisma, account.id);
      await prisma.$transaction(async (tx) => {
        const rule = await tx.ruleDefinition.create({
          data: {
            accountId: account.id,
            name: 'Daily loss limit',
            ruleType: 'DAILY_LOSS_LIMIT',
            parameters: { max_daily_loss_pct: 5 },
          },
        });
        await tx.ruleState.create({ data: { ruleId: rule.id, accountId: account.id, state: 'INACTIVE' } });
      });

      const res = await request(app, {
        method: 'GET',
        url: `/accounts/${account.id}/rules`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('Daily loss limit');
      expect(res.body[0].state).toBe('INACTIVE');
    });
  });

  describe('GET /accounts/:accountId/alerts', () => {
    it('lists alerts newest-first with rule and delivery context joined in', async () => {
      const user = await createUser(prisma);
      const account = await createTradingAccount(prisma, user.id);
      const { plaintext: token } = await createDashboardToken(prisma, account.id);
      const rule = await prisma.ruleDefinition.create({
        data: {
          accountId: account.id,
          name: 'Drawdown',
          ruleType: 'DRAWDOWN',
          parameters: { max_drawdown_pct: 10 },
        },
      });
      const alert = await prisma.alert.create({
        data: {
          ruleId: rule.id,
          accountId: account.id,
          triggerValues: { drawdownPct: 12 },
          baselineSnapshot: { peakEquity: 1000 },
          ruleSnapshot: { max_drawdown_pct: 10 },
        },
      });
      await prisma.alertDelivery.create({
        data: { alertId: alert.id, status: 'SENT', sentAt: new Date() },
      });

      const res = await request(app, {
        method: 'GET',
        url: `/accounts/${account.id}/alerts`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.alerts).toHaveLength(1);
      expect(res.body.alerts[0].rule.name).toBe('Drawdown');
      expect(res.body.alerts[0].delivery.status).toBe('SENT');
      expect(res.body.total).toBe(1);
    });
  });
});
