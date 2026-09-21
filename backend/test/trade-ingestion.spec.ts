import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app';
import { resetDatabase } from './helpers/db';
import { setupAccountWithToken, validDealPayload } from './helpers/factories';
import { request } from './helpers/http';

describe('trade (deal) ingestion', () => {
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

  async function pushTrades(token: string, accountId: string, deals: unknown[]) {
    return request(app, {
      method: 'POST',
      url: '/collector/trades',
      headers: { authorization: `Bearer ${token}` },
      payload: { accountId, deals },
    });
  }

  it('inserts a new trade', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const res = await pushTrades(token, account.id, [validDealPayload({ externalTradeId: '5001' })]);

    expect(res.statusCode).toBe(201);
    const rows = await prisma.trade.findMany({ where: { accountId: account.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].externalTradeId).toBe('5001');
  });

  it('submitting the same trade twice results in exactly one row', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const deal = validDealPayload({ externalTradeId: '5002' });

    await pushTrades(token, account.id, [deal]);
    await pushTrades(token, account.id, [deal]);

    const rows = await prisma.trade.findMany({ where: { accountId: account.id, externalTradeId: '5002' } });
    expect(rows).toHaveLength(1);
  });

  it('handles multiple trades in one push', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await pushTrades(token, account.id, [
      validDealPayload({ externalTradeId: 'A' }),
      validDealPayload({ externalTradeId: 'B' }),
      validDealPayload({ externalTradeId: 'C' }),
    ]);

    const rows = await prisma.trade.findMany({ where: { accountId: account.id } });
    expect(rows).toHaveLength(3);
  });

  it('scopes trade identity by account — the same externalTradeId on two accounts creates two independent rows', async () => {
    const acct1 = await setupAccountWithToken(prisma);
    const acct2 = await setupAccountWithToken(prisma);

    await pushTrades(acct1.token, acct1.account.id, [validDealPayload({ externalTradeId: 'SAME-TICKET' })]);
    await pushTrades(acct2.token, acct2.account.id, [validDealPayload({ externalTradeId: 'SAME-TICKET' })]);

    const total = await prisma.trade.count({ where: { externalTradeId: 'SAME-TICKET' } });
    expect(total).toBe(2);
  });

  it('rejects a deal with an invalid side, and persists nothing from that request', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const res = await pushTrades(token, account.id, [validDealPayload({ side: 'HOLD' })]);

    expect(res.statusCode).toBe(400);
    expect(await prisma.trade.count({ where: { accountId: account.id } })).toBe(0);
  });

  it('rejects a deal with an invalid dealEntry', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const res = await pushTrades(token, account.id, [validDealPayload({ dealEntry: 'SIDEWAYS' })]);

    expect(res.statusCode).toBe(400);
    expect(await prisma.trade.count({ where: { accountId: account.id } })).toBe(0);
  });
});
