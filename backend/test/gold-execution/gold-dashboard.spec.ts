import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { setupAccountWithDashboardToken } from '../helpers/factories';
import { request } from '../helpers/http';

describe('Gold execution dashboard', () => {
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

  it('reports OFF mode by default (GOLD_EXECUTION_MODE unset) and the EURUSD-inactive banner', async () => {
    const { token } = await setupAccountWithDashboardToken(prisma);
    const res = await request(app, {
      method: 'GET', url: '/research/gold-execution-status',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.body.accountMode).toBe('OFF');
    expect(res.body.eurusd.status).toBe('INACTIVE');
    expect(res.body.settings.volumeLots).toBe(0.01);
    expect(res.body.settings.magicNumber).toBe(262610181);
  });

  it('reports fixed-volume/risk settings and fails-closed data freshness when nothing has been synced', async () => {
    const { token } = await setupAccountWithDashboardToken(prisma);
    const res = await request(app, {
      method: 'GET', url: '/research/gold-execution-status',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.body.dataFreshness.accountSnapshotStale).toBe(true);
    expect(res.body.dataFreshness.symbolMetadataStale).toBe(true);
    expect(res.body.accountTradeMode).toBeNull();
  });

  it('reports an open XAUUSD position with floating P&L and no EURUSD position leaking in', async () => {
    const { account, token } = await setupAccountWithDashboardToken(prisma);
    await prisma.position.create({
      data: {
        accountId: account.id, platform: 'MT5', externalPositionId: 'g-1', symbol: 'XAUUSD',
        side: 'BUY', volume: 0.01, openPrice: 2650, currentPrice: 2655, profit: 5,
        status: 'OPEN', openedAt: new Date(),
      },
    });
    await prisma.position.create({
      data: {
        accountId: account.id, platform: 'MT5', externalPositionId: 'e-1', symbol: 'EURUSD',
        side: 'BUY', volume: 0.12, openPrice: 1.1, profit: -2, status: 'OPEN', openedAt: new Date(),
      },
    });
    const res = await request(app, {
      method: 'GET', url: '/research/gold-execution-status',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.body.openPositions).toHaveLength(1);
    expect(res.body.openPositions[0].ticket).toBe('g-1');
    expect(res.body.openPositions[0].floatingPnl).toBe(5);
    expect(res.body.occupancy.hasExistingXauusdExposure).toBe(true);
  });
});
