import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app';
import { resetDatabase } from './helpers/db';
import { createCollectorToken, setupAccountWithToken, validDealPayload, validSnapshotPayload } from './helpers/factories';
import { request } from './helpers/http';

describe('isolation & security', () => {
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

  it('returns 401 (not 500, not 200) for every collector endpoint when unauthenticated', async () => {
    const { account } = await setupAccountWithToken(prisma);

    const endpoints: Array<{ method: 'GET' | 'POST'; url: string; payload?: unknown }> = [
      { method: 'GET', url: `/collector/cursor/${account.id}` },
      { method: 'GET', url: `/collector/heartbeat/${account.id}` },
      { method: 'POST', url: '/collector/snapshot', payload: validSnapshotPayload(account.id) },
      { method: 'POST', url: '/collector/trades', payload: { accountId: account.id, deals: [] } },
    ];

    for (const ep of endpoints) {
      const res = await request(app, ep);
      expect(res.statusCode, `${ep.method} ${ep.url}`).toBe(401);
    }
  });

  it(
    'FIXED (production-readiness review, item 1): a collector token bound to one account ' +
      'is rejected — 403, not 201/200 — when used against a different account',
    async () => {
      // Previously a single collector-scoped token could submit data for
      // ANY known account (api_credentials had no accountId column at all).
      // Now every token is bound at creation (scripts/bootstrap.ts,
      // scripts/create-collector-token.ts) and CollectorTokenGuard checks
      // the binding on every request, not just that the token itself is valid.
      const acct1 = await setupAccountWithToken(prisma);
      const acct2 = await setupAccountWithToken(prisma);

      const resAcct1 = await request(app, {
        method: 'POST', url: '/collector/snapshot',
        headers: { authorization: `Bearer ${acct1.token}` },
        payload: validSnapshotPayload(acct1.account.id),
      });
      const resAcct2WithAcct1Token = await request(app, {
        method: 'POST', url: '/collector/snapshot',
        headers: { authorization: `Bearer ${acct1.token}` }, // acct1's token, acct2's accountId
        payload: validSnapshotPayload(acct2.account.id),
      });
      const acct2TradesAfter = await prisma.accountSnapshot.count({ where: { accountId: acct2.account.id } });

      expect(resAcct1.statusCode).toBe(201);
      expect(resAcct2WithAcct1Token.statusCode).toBe(403);
      expect(acct2TradesAfter).toBe(0); // the rejected request never wrote anything
    },
  );

  it('a token bound to one account is also rejected for the GET cursor/heartbeat routes of another account', async () => {
    const acct1 = await setupAccountWithToken(prisma);
    const acct2 = await setupAccountWithToken(prisma);

    const cursorRes = await request(app, {
      method: 'GET', url: `/collector/cursor/${acct2.account.id}`,
      headers: { authorization: `Bearer ${acct1.token}` },
    });
    const heartbeatRes = await request(app, {
      method: 'GET', url: `/collector/heartbeat/${acct2.account.id}`,
      headers: { authorization: `Bearer ${acct1.token}` },
    });

    expect(cursorRes.statusCode).toBe(403);
    expect(heartbeatRes.statusCode).toBe(403);
  });

  it('a token with no account binding at all (pre-fix legacy row) is rejected outright, not treated as unrestricted', async () => {
    const acct = await setupAccountWithToken(prisma);
    const { plaintext, credential } = await createCollectorToken(prisma, acct.account.id);
    // Simulate a legacy, never-rotated token by stripping its binding directly.
    await prisma.apiCredential.update({ where: { id: credential.id }, data: { accountId: null } });

    const res = await request(app, {
      method: 'GET', url: `/collector/cursor/${acct.account.id}`,
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("data pushed for one account never appears when reading another account's cursor or heartbeat", async () => {
    const acct1 = await setupAccountWithToken(prisma);
    const acct2 = await setupAccountWithToken(prisma);

    await request(app, {
      method: 'POST', url: '/collector/trades',
      headers: { authorization: `Bearer ${acct1.token}` },
      payload: { accountId: acct1.account.id, deals: [validDealPayload({ externalTradeId: 'ACCT1-ONLY' })] },
    });

    const acct2Cursor = await request(app, {
      method: 'GET', url: `/collector/cursor/${acct2.account.id}`,
      headers: { authorization: `Bearer ${acct2.token}` },
    });
    expect(acct2Cursor.body.lastDealTicket).toBeNull();

    const acct2Heartbeat = await request(app, {
      method: 'GET', url: `/collector/heartbeat/${acct2.account.id}`,
      headers: { authorization: `Bearer ${acct2.token}` },
    });
    expect(acct2Heartbeat.body).toBeNull();

    const acct2Trades = await prisma.trade.count({ where: { accountId: acct2.account.id } });
    expect(acct2Trades).toBe(0);
  });

  it('does not require a collector token for unrelated public routes', async () => {
    // Phase 2 has no other privileged endpoints yet (no dashboard/user auth
    // routes exist until a later phase) — this at least confirms the
    // collector guard is scoped to /collector/* and isn't accidentally
    // applied application-wide.
    const res = await request(app, { method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
  });
});
