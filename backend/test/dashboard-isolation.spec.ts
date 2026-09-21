// Dashboard authentication account isolation (production-readiness review —
// Option B). NON-NEGOTIABLE per the review: a dashboard token bound to
// account A must never reach account B's data, on ANY dashboard-guarded
// route, and GET /accounts must never leak every account in the system.
// Mirrors test/isolation.spec.ts's structure (the collector's own
// equivalent) for every route DashboardTokenGuard now protects.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app';
import { resetDatabase } from './helpers/db';
import { setupAccountWithDashboardToken } from './helpers/factories';
import { request } from './helpers/http';

const XTB_HEADER = 'Order,Symbol,Type,Volume,Open Time,Open Price,Close Time,Close Price,Commission,Swap,Profit,Comment';

describe('dashboard token account isolation', () => {
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
    it("returns only the authenticated token's own account, never every account", async () => {
      const a = await setupAccountWithDashboardToken(prisma);
      await setupAccountWithDashboardToken(prisma); // a second, unrelated account+token

      const res = await request(app, {
        method: 'GET',
        url: '/accounts',
        headers: { authorization: `Bearer ${a.token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(a.account.id);
    });
  });

  describe('GET /accounts/:id', () => {
    it('A -> A succeeds, A -> B returns 403', async () => {
      const a = await setupAccountWithDashboardToken(prisma);
      const b = await setupAccountWithDashboardToken(prisma);

      const toA = await request(app, {
        method: 'GET',
        url: `/accounts/${a.account.id}`,
        headers: { authorization: `Bearer ${a.token}` },
      });
      const toB = await request(app, {
        method: 'GET',
        url: `/accounts/${b.account.id}`,
        headers: { authorization: `Bearer ${a.token}` },
      });

      expect(toA.statusCode).toBe(200);
      expect(toB.statusCode).toBe(403);
    });
  });

  describe('GET /accounts/:accountId/alerts', () => {
    it('A -> A succeeds, A -> B returns 403', async () => {
      const a = await setupAccountWithDashboardToken(prisma);
      const b = await setupAccountWithDashboardToken(prisma);

      const toA = await request(app, {
        method: 'GET',
        url: `/accounts/${a.account.id}/alerts`,
        headers: { authorization: `Bearer ${a.token}` },
      });
      const toB = await request(app, {
        method: 'GET',
        url: `/accounts/${b.account.id}/alerts`,
        headers: { authorization: `Bearer ${a.token}` },
      });

      expect(toA.statusCode).toBe(200);
      expect(toB.statusCode).toBe(403);
    });
  });

  describe('GET /accounts/:accountId/rules', () => {
    it('A -> A succeeds, A -> B returns 403', async () => {
      const a = await setupAccountWithDashboardToken(prisma);
      const b = await setupAccountWithDashboardToken(prisma);

      const toA = await request(app, {
        method: 'GET',
        url: `/accounts/${a.account.id}/rules`,
        headers: { authorization: `Bearer ${a.token}` },
      });
      const toB = await request(app, {
        method: 'GET',
        url: `/accounts/${b.account.id}/rules`,
        headers: { authorization: `Bearer ${a.token}` },
      });

      expect(toA.statusCode).toBe(200);
      expect(toB.statusCode).toBe(403);
    });
  });

  describe('trading-data routes', () => {
    const routes = ['snapshots/latest', 'positions', 'trades'];

    for (const route of routes) {
      it(`GET /accounts/:accountId/${route} — A -> A succeeds, A -> B returns 403`, async () => {
        const a = await setupAccountWithDashboardToken(prisma);
        const b = await setupAccountWithDashboardToken(prisma);

        const toA = await request(app, {
          method: 'GET',
          url: `/accounts/${a.account.id}/${route}`,
          headers: { authorization: `Bearer ${a.token}` },
        });
        const toB = await request(app, {
          method: 'GET',
          url: `/accounts/${b.account.id}/${route}`,
          headers: { authorization: `Bearer ${a.token}` },
        });

        expect(toA.statusCode).toBe(200);
        expect(toB.statusCode).toBe(403);
      });
    }
  });

  describe('POST /xtb-import', () => {
    it("a token bound to account A cannot import data into account B's accountId", async () => {
      const a = await setupAccountWithDashboardToken(prisma, { platform: 'XTB' });
      const b = await setupAccountWithDashboardToken(prisma, { platform: 'XTB' });
      const csvContent = `${XTB_HEADER}\n1,EURUSD,BUY,1,2026-01-01,1.1,2026-01-02,1.2,,,10,`;

      const toOwnAccount = await request(app, {
        method: 'POST',
        url: '/xtb-import',
        headers: { authorization: `Bearer ${a.token}` },
        payload: { accountId: a.account.id, csvContent },
      });
      const toOtherAccount = await request(app, {
        method: 'POST',
        url: '/xtb-import',
        headers: { authorization: `Bearer ${a.token}` }, // A's token
        payload: { accountId: b.account.id, csvContent }, // B's account
      });

      expect(toOwnAccount.statusCode).toBe(201);
      expect(toOtherAccount.statusCode).toBe(403);
      // The rejected request must never have written anything for B.
      const bTrades = await prisma.trade.count({ where: { accountId: b.account.id } });
      expect(bTrades).toBe(0);
    });
  });

  describe('GET /xtb-import/batches/:accountId', () => {
    it('A -> A succeeds, A -> B returns 403', async () => {
      const a = await setupAccountWithDashboardToken(prisma, { platform: 'XTB' });
      const b = await setupAccountWithDashboardToken(prisma, { platform: 'XTB' });

      const toA = await request(app, {
        method: 'GET',
        url: `/xtb-import/batches/${a.account.id}`,
        headers: { authorization: `Bearer ${a.token}` },
      });
      const toB = await request(app, {
        method: 'GET',
        url: `/xtb-import/batches/${b.account.id}`,
        headers: { authorization: `Bearer ${a.token}` },
      });

      expect(toA.statusCode).toBe(200);
      expect(toB.statusCode).toBe(403);
    });
  });
});
