import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app';
import { resetDatabase } from './helpers/db';
import { setupAccountWithToken, validDealPayload, validPositionPayload, validSnapshotPayload } from './helpers/factories';
import { request } from './helpers/http';

// This file is the automated equivalent of the live manual verification
// performed against the real MT5 demo account during Phase 2 (hard kill,
// restart, confirm no duplicates). Some of these overlap individual
// assertions in the other spec files by design — this file exists to tell
// the whole DoD story end to end, in the trader's own terms, in one place.
describe('Phase 2 Definition of Done — idempotency', () => {
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

  it('1. submitting the same trade payload multiple times results in exactly one row', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const deal = validDealPayload({ externalTradeId: 'DOD-1' });

    for (let i = 0; i < 3; i++) {
      const res = await request(app, {
        method: 'POST', url: '/collector/trades',
        headers: { authorization: `Bearer ${token}` },
        payload: { accountId: account.id, deals: [deal] },
      });
      expect(res.statusCode).toBe(201);
    }

    expect(await prisma.trade.count({ where: { accountId: account.id } })).toBe(1);
  });

  it('2. submitting the same snapshot repeatedly does not create duplicates', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const capturedAt = new Date().toISOString();
    const payload = validSnapshotPayload(account.id, { capturedAt, balance: 1000 });

    for (let i = 0; i < 3; i++) {
      await request(app, {
        method: 'POST', url: '/collector/snapshot',
        headers: { authorization: `Bearer ${token}` }, payload,
      });
    }

    expect(await prisma.accountSnapshot.count({ where: { accountId: account.id } })).toBe(1);
  });

  it('3. submitting an updated snapshot for the same capturedAt updates the record instead of duplicating it', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const capturedAt = new Date().toISOString();

    await request(app, {
      method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${token}` },
      payload: validSnapshotPayload(account.id, { capturedAt, balance: 1000 }),
    });
    await request(app, {
      method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${token}` },
      payload: validSnapshotPayload(account.id, { capturedAt, balance: 2000 }),
    });

    const rows = await prisma.accountSnapshot.findMany({ where: { accountId: account.id } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].balance)).toBe(2000);
  });

  it('4. submitting an updated position for the same externalPositionId updates rather than duplicates', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const push = (positions: unknown[]) =>
      request(app, {
        method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${token}` },
        payload: validSnapshotPayload(account.id, { positions }),
      });

    await push([validPositionPayload({ externalPositionId: 'DOD-POS', profit: 0 })]);
    await push([validPositionPayload({ externalPositionId: 'DOD-POS', profit: 42 })]);

    const rows = await prisma.position.findMany({ where: { accountId: account.id } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].profit)).toBe(42);
  });

  it('5. a hard-restart-style replay of an overlapping trade window never produces duplicates', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const d1 = validDealPayload({ externalTradeId: 'DOD-D1' });
    const d2 = validDealPayload({ externalTradeId: 'DOD-D2' });
    const d3 = validDealPayload({ externalTradeId: 'DOD-D3' });

    await request(app, {
      method: 'POST', url: '/collector/trades', headers: { authorization: `Bearer ${token}` },
      payload: { accountId: account.id, deals: [d1, d2] },
    });
    // Collector "restarts" and re-queries an overlapping window: d1 and d2
    // come back again, plus one genuinely new deal, d3.
    await request(app, {
      method: 'POST', url: '/collector/trades', headers: { authorization: `Bearer ${token}` },
      payload: { accountId: account.id, deals: [d1, d2, d3] },
    });

    expect(await prisma.trade.count({ where: { accountId: account.id } })).toBe(3);
  });

  it('6. a rejected (failed) ingestion request never advances the sync cursor', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await request(app, {
      method: 'POST', url: '/collector/trades', headers: { authorization: `Bearer ${token}` },
      payload: { accountId: account.id, deals: [validDealPayload({ externalTradeId: 'GOOD' })] },
    });
    const before = await request(app, {
      method: 'GET', url: `/collector/cursor/${account.id}`, headers: { authorization: `Bearer ${token}` },
    });

    const failed = await request(app, {
      method: 'POST', url: '/collector/trades', headers: { authorization: `Bearer ${token}` },
      payload: { accountId: account.id, deals: [{ ...validDealPayload(), side: 'NOT_A_SIDE' }] },
    });
    expect(failed.statusCode).toBe(400);

    const after = await request(app, {
      method: 'GET', url: `/collector/cursor/${account.id}`, headers: { authorization: `Bearer ${token}` },
    });
    expect(after.body).toEqual(before.body);
  });
});
