// End-to-end Phase 11 tests: real Postgres + real Redis, same "force one
// tick" pattern as health-e2e.spec.ts (DataIntegrityProcessor.runCheck()
// exposed for exactly this — DATA_INTEGRITY_CHECK_INTERVAL_SECONDS=604800
// in .env.test so the real weekly schedule never fires mid-test-file).
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { createDashboardToken, createTradingAccount, createUser } from '../helpers/factories';
import { request } from '../helpers/http';
import { DataIntegrityProcessor } from '../../src/health/data-integrity.processor';

describe('Phase 11 — data integrity audit (end-to-end)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;
  let processor: DataIntegrityProcessor;
  let dashboardToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = new PrismaClient();
    processor = app.get(DataIntegrityProcessor);
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    // /health is system-wide, not account-scoped — any valid, unrevoked
    // dashboard token is accepted (see health-e2e.spec.ts for the same setup).
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    ({ plaintext: dashboardToken } = await createDashboardToken(prisma, account.id));
  });

  it('a clean database reports DATA_INTEGRITY: OK via GET /health', async () => {
    await processor.runCheck();

    const res = await request(app, {
      method: 'GET',
      url: '/health',
      headers: { authorization: `Bearer ${dashboardToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.DATA_INTEGRITY.status).toBe('OK');
  });

  it('a negative-volume trade opens a DATA_INTEGRITY incident; fixing it closes the incident on the next run', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const bad = await prisma.trade.create({
      data: {
        accountId: account.id,
        platform: 'MT5',
        externalTradeId: 'bad-e2e-1',
        symbol: 'EURUSD',
        side: 'BUY',
        dealEntry: 'OUT',
        volume: -1,
        price: 1.1,
        profit: 0,
        executedAt: new Date(),
      },
    });

    await processor.runCheck();
    let res = await request(app, {
      method: 'GET',
      url: '/health',
      headers: { authorization: `Bearer ${dashboardToken}` },
    });
    expect(res.body.DATA_INTEGRITY.status).toBe('DOWN');

    let incidents = await prisma.healthIncident.findMany({ where: { component: 'DATA_INTEGRITY' } });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].resolvedAt).toBeNull();

    // Fix the drift, same as an operator would after being paged.
    await prisma.trade.update({ where: { id: bad.id }, data: { volume: 1 } });
    await processor.runCheck();

    res = await request(app, {
      method: 'GET',
      url: '/health',
      headers: { authorization: `Bearer ${dashboardToken}` },
    });
    expect(res.body.DATA_INTEGRITY.status).toBe('OK');

    incidents = await prisma.healthIncident.findMany({
      where: { component: 'DATA_INTEGRITY' },
      orderBy: { openedAt: 'asc' },
    });
    expect(incidents).toHaveLength(1); // closed, not a second one opened
    expect(incidents[0].resolvedAt).not.toBeNull();
  });

  it('repeated runs with the same finding never create duplicate incidents', async () => {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    await prisma.trade.create({
      data: {
        accountId: account.id,
        platform: 'MT5',
        externalTradeId: 'bad-e2e-2',
        symbol: 'EURUSD',
        side: 'BUY',
        dealEntry: 'OUT',
        volume: -1,
        price: 1.1,
        profit: 0,
        executedAt: new Date(),
      },
    });

    await processor.runCheck();
    await processor.runCheck();
    await processor.runCheck();

    const incidents = await prisma.healthIncident.findMany({ where: { component: 'DATA_INTEGRITY' } });
    expect(incidents).toHaveLength(1);
  });
});
