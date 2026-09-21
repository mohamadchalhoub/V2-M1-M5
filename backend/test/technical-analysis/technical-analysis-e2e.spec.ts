import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { createDashboardToken, createTradingAccount, createUser } from '../helpers/factories';
import { request } from '../helpers/http';

describe('GET /accounts/:accountId/technical-analysis (end-to-end)', () => {
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

  async function accountWithToken() {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const { plaintext: token } = await createDashboardToken(prisma, account.id);
    return { account, token };
  }

  it('returns null when there is no EURUSD candle data at all — never fabricated', async () => {
    const { account, token } = await accountWithToken();
    const res = await request(app, {
      method: 'GET',
      url: `/accounts/${account.id}/technical-analysis`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeNull();
  });

  it('returns a full report once real candle data exists', async () => {
    const { account, token } = await accountWithToken();
    await prisma.historicalCandle.create({
      data: { symbol: 'EURUSD', timeframe: 'M5', openTime: new Date(), open: 1.1, high: 1.101, low: 1.099, close: 1.1005, source: 'MT5' },
    });

    const res = await request(app, {
      method: 'GET',
      url: `/accounts/${account.id}/technical-analysis`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body.symbol).toBe('EURUSD');
    expect(body.currentPrice).toBe(1.1005);
    expect(['BULLISH', 'BEARISH', 'NEUTRAL']).toContain(body.marketDirection.dailyBias);
    expect(Array.isArray(body.supportResistance)).toBe(true);
    expect(Array.isArray(body.ichimoku)).toBe(true);
  });

  it('rejects a request with no dashboard token', async () => {
    const { account } = await accountWithToken();
    const res = await request(app, { method: 'GET', url: `/accounts/${account.id}/technical-analysis` });
    expect(res.statusCode).toBe(401);
  });

  it('a token bound to account A cannot read account B\'s technical-analysis endpoint', async () => {
    const { account: accountA } = await accountWithToken();
    const { token: tokenB } = await accountWithToken();
    const res = await request(app, {
      method: 'GET',
      url: `/accounts/${accountA.id}/technical-analysis`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 for an unknown account — the account-mismatch guard fires before the not-found check, same layering as every other dashboard route', async () => {
    const { token } = await accountWithToken();
    const res = await request(app, {
      method: 'GET',
      url: `/accounts/00000000-0000-0000-0000-000000000000/technical-analysis`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
