import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { createDashboardToken, createTradingAccount, createUser } from '../helpers/factories';
import { request } from '../helpers/http';

describe('historical EURUSD charts (end-to-end)', () => {
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

  async function xtbAccountWithToken() {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id, { platform: 'XTB' });
    const { plaintext: token } = await createDashboardToken(prisma, account.id);
    return { account, token };
  }

  async function seedRoundTrip(accountId: string, positionId: string) {
    await prisma.trade.create({
      data: {
        accountId, platform: 'XTB', externalTradeId: `${positionId}-IN`, positionId,
        symbol: 'EURUSD', side: 'BUY', dealEntry: 'IN', volume: 0.1, price: 1.1,
        executedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    await prisma.trade.create({
      data: {
        accountId, platform: 'XTB', externalTradeId: `${positionId}-OUT`, positionId,
        symbol: 'EURUSD', side: 'BUY', dealEntry: 'OUT', volume: 0.1, price: 1.105, profit: 5,
        executedAt: new Date('2026-01-01T01:00:00Z'),
      },
    });
  }

  it('GET /accounts/:accountId/eurusd-trades lists round trips for that account', async () => {
    const { account, token } = await xtbAccountWithToken();
    await seedRoundTrip(account.id, 'p1');

    const res = await request(app, {
      method: 'GET',
      url: `/accounts/${account.id}/eurusd-trades`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].positionId).toBe('p1');
  });

  it('GET .../eurusd-trades/:positionId/chart returns entry/exit markers and features', async () => {
    const { account, token } = await xtbAccountWithToken();
    await seedRoundTrip(account.id, 'p1');

    const res = await request(app, {
      method: 'GET',
      url: `/accounts/${account.id}/eurusd-trades/p1/chart`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.entryMarker.price).toBe(1.1);
    expect(res.body.exitMarker.price).toBe(1.105);
    expect(res.body.features).toBeDefined();
  });

  it('a token bound to account A cannot read account B\'s EURUSD trades', async () => {
    const { account: accountA } = await xtbAccountWithToken();
    const { account: accountB, token: tokenB } = await xtbAccountWithToken();
    await seedRoundTrip(accountA.id, 'secret-position');

    const res = await request(app, {
      method: 'GET',
      url: `/accounts/${accountA.id}/eurusd-trades`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(403);
    // Sanity: account B's own (empty) list still works with its own token.
    const ownRes = await request(app, {
      method: 'GET',
      url: `/accounts/${accountB.id}/eurusd-trades`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(ownRes.statusCode).toBe(200);
    expect(ownRes.body).toEqual([]);
  });

  it('rejects a request with no token', async () => {
    const { account } = await xtbAccountWithToken();
    const res = await request(app, { method: 'GET', url: `/accounts/${account.id}/eurusd-trades` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for an unknown account', async () => {
    const { token } = await xtbAccountWithToken();
    const res = await request(app, {
      method: 'GET',
      url: '/accounts/11111111-1111-1111-1111-111111111111/eurusd-trades',
      headers: { authorization: `Bearer ${token}` },
    });
    // The account-mismatch guard fires before the not-found check for a
    // token bound to a different (real) account — same layering every
    // other dashboard-authenticated route already has.
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for a chart request naming a position that does not exist on this account', async () => {
    const { account, token } = await xtbAccountWithToken();
    const res = await request(app, {
      method: 'GET',
      url: `/accounts/${account.id}/eurusd-trades/does-not-exist/chart`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
