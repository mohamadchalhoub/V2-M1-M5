import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app';
import { resetDatabase } from './helpers/db';
import { setupAccountWithToken, validDealPayload } from './helpers/factories';
import { request } from './helpers/http';

describe('sync cursor', () => {
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
  async function getCursor(token: string, accountId: string) {
    const res = await request(app, {
      method: 'GET',
      url: `/collector/cursor/${accountId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return res.body as { lastSyncedAt: string | null; lastDealTicket: string | null };
  }

  it('returns a null cursor before any trade has ever been synced', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const cursor = await getCursor(token, account.id);
    expect(cursor.lastSyncedAt).toBeNull();
    expect(cursor.lastDealTicket).toBeNull();
  });

  it('advances after a successful trade push', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await pushTrades(token, account.id, [validDealPayload({ externalTradeId: '42' })]);

    const cursor = await getCursor(token, account.id);
    expect(cursor.lastSyncedAt).not.toBeNull();
    expect(cursor.lastDealTicket).toBe('42');
  });

  it('keeps the highest deal ticket seen, even if a later push includes a lower one', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await pushTrades(token, account.id, [validDealPayload({ externalTradeId: '100' })]);
    await pushTrades(token, account.id, [validDealPayload({ externalTradeId: '50' })]);

    const cursor = await getCursor(token, account.id);
    expect(cursor.lastDealTicket).toBe('100');
  });

  it('does not 500 when a ticket id is non-numeric, on a second push after a cursor already exists', async () => {
    // Regression test: the ticket-comparison logic used to call BigInt()
    // unconditionally once a prior cursor existed, crashing the whole
    // request with a 500 for any non-numeric externalTradeId. Real MT5
    // tickets are always numeric, but the schema doesn't enforce that, so
    // this must degrade gracefully rather than fail the request.
    const { account, token } = await setupAccountWithToken(prisma);
    await pushTrades(token, account.id, [validDealPayload({ externalTradeId: 'NUMERIC-LOOKING-1' })]);
    const res = await pushTrades(token, account.id, [validDealPayload({ externalTradeId: 'NUMERIC-LOOKING-2' })]);

    expect(res.statusCode).toBe(201);
    expect(await prisma.trade.count({ where: { accountId: account.id } })).toBe(2);
  });

  it('does NOT advance when the request is rejected by validation', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await pushTrades(token, account.id, [validDealPayload({ externalTradeId: '1' })]);
    const before = await getCursor(token, account.id);

    const res = await pushTrades(token, account.id, [validDealPayload({ side: 'HOLD' })]);
    expect(res.statusCode).toBe(400);

    const after = await getCursor(token, account.id);
    expect(after.lastSyncedAt).toBe(before.lastSyncedAt);
    expect(after.lastDealTicket).toBe(before.lastDealTicket);
  });

  it('replaying the same overlapping time window stays idempotent', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const d1 = validDealPayload({ externalTradeId: 'D1' });
    const d2 = validDealPayload({ externalTradeId: 'D2' });

    await pushTrades(token, account.id, [d1, d2]);
    const cursorAfterFirst = await getCursor(token, account.id);

    // Simulate a collector restart re-querying the same overlapping window.
    await pushTrades(token, account.id, [d1, d2]);
    const cursorAfterReplay = await getCursor(token, account.id);

    expect(await prisma.trade.count({ where: { accountId: account.id } })).toBe(2);
    expect(cursorAfterReplay.lastDealTicket).toBe(cursorAfterFirst.lastDealTicket);
  });
});
