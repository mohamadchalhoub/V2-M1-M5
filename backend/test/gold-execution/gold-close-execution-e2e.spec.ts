import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { createCollectorToken, setupAccountWithDashboardToken } from '../helpers/factories';
import { request } from '../helpers/http';

/**
 * Task item 2 — "finish actual close-position execution." End-to-end over
 * the real HTTP layer (dashboard request -> collector poll/claim -> collector
 * reports a SIMULATED broker result -> verify the DB only ever reaches
 * CLOSED on a broker-confirmed success). No real MT5/collector process is
 * involved — the "broker response" is the POST this test sends to
 * `postCloseResult`, exactly the shape runner.py sends for real, standing
 * in for the executor's actual order_send() result.
 */
describe('Gold close-position execution (dashboard request -> collector poll -> broker-confirmed result)', () => {
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

  async function seedOpenGoldPosition(accountId: string, ticket = '123456') {
    await prisma.position.create({
      data: {
        accountId, platform: 'MT5', externalPositionId: ticket, symbol: 'XAUUSD',
        side: 'BUY', volume: 0.01, openPrice: 2650, currentPrice: 2655, profit: 5, swap: 0,
        status: 'OPEN', openedAt: new Date(),
      },
    });
  }

  it('full lifecycle: dashboard request -> collector claims -> broker-confirmed close -> CLOSED, never before', async () => {
    const { account: mt5Account, token: dashboardToken } = await setupAccountWithDashboardToken(prisma, { platform: 'MT5' });
    const { plaintext: collectorToken } = await createCollectorToken(prisma, mt5Account.id);
    await seedOpenGoldPosition(mt5Account.id, '999001');

    // 1. Dashboard requests a close.
    const requestRes = await request(app, {
      method: 'POST', url: '/research/gold-execution-status/close-position',
      headers: { authorization: `Bearer ${dashboardToken}` },
      payload: { positionId: '999001', confirm: true },
    });
    expect(requestRes.statusCode).toBeLessThan(300);
    expect(requestRes.body.ok).toBe(true);
    expect(requestRes.body.status).toBe('PENDING');

    // Not closed yet — merely requested.
    const afterRequest = await prisma.goldCloseRequest.findUnique({ where: { id: requestRes.body.requestId } });
    expect(afterRequest?.status).toBe('PENDING');

    // 2. Collector polls and atomically claims it (PENDING -> SENT).
    const pollRes = await request(app, {
      method: 'GET', url: `/collector/${mt5Account.id}/gold-execution/close-request`,
      headers: { authorization: `Bearer ${collectorToken}` },
    });
    expect(pollRes.statusCode).toBeLessThan(300);
    expect(pollRes.body.request).not.toBeNull();
    expect(pollRes.body.request.ticket).toBe(999001);
    expect(pollRes.body.request.side).toBe('BUY');
    expect(pollRes.body.request.volume).toBe(0.01);

    const afterClaim = await prisma.goldCloseRequest.findUnique({ where: { id: requestRes.body.requestId } });
    expect(afterClaim?.status).toBe('SENT'); // claimed, but STILL not CLOSED — only a broker result can do that

    // A second poll finds nothing more to claim.
    const secondPoll = await request(app, {
      method: 'GET', url: `/collector/${mt5Account.id}/gold-execution/close-request`,
      headers: { authorization: `Bearer ${collectorToken}` },
    });
    expect(secondPoll.body.request).toBeNull();

    // 3. Collector reports a SIMULATED broker-confirmed success.
    const resultRes = await request(app, {
      method: 'POST', url: `/collector/${mt5Account.id}/gold-execution/close-request/${requestRes.body.requestId}/result`,
      headers: { authorization: `Bearer ${collectorToken}` },
      payload: { ok: true, dealTicket: 5551234, closedPrice: 2656.1 },
    });
    expect(resultRes.statusCode).toBeLessThan(300);

    const closed = await prisma.goldCloseRequest.findUnique({ where: { id: requestRes.body.requestId } });
    expect(closed?.status).toBe('CLOSED');
    expect(closed?.resultDealTicket).toBe(5551234);
    expect(closed?.closedAt).not.toBeNull();
  });

  it('a broker-reported FAILURE never reaches CLOSED — stays FAILED, closedAt stays null', async () => {
    const { account: mt5Account, token: dashboardToken } = await setupAccountWithDashboardToken(prisma, { platform: 'MT5' });
    const { plaintext: collectorToken } = await createCollectorToken(prisma, mt5Account.id);
    await seedOpenGoldPosition(mt5Account.id, '999002');

    const requestRes = await request(app, {
      method: 'POST', url: '/research/gold-execution-status/close-position',
      headers: { authorization: `Bearer ${dashboardToken}` },
      payload: { positionId: '999002', confirm: true },
    });

    await request(app, {
      method: 'GET', url: `/collector/${mt5Account.id}/gold-execution/close-request`,
      headers: { authorization: `Bearer ${collectorToken}` },
    });

    const resultRes = await request(app, {
      method: 'POST', url: `/collector/${mt5Account.id}/gold-execution/close-request/${requestRes.body.requestId}/result`,
      headers: { authorization: `Bearer ${collectorToken}` },
      payload: { ok: false, errorMessage: 'simulated broker rejection: requote' },
    });
    expect(resultRes.statusCode).toBeLessThan(300);

    const failed = await prisma.goldCloseRequest.findUnique({ where: { id: requestRes.body.requestId } });
    expect(failed?.status).toBe('FAILED');
    expect(failed?.closedAt).toBeNull();
    expect(failed?.resultError).toContain('requote');
  });

  it('a duplicate close request for the same position returns the existing (not a second) request', async () => {
    const { account: mt5Account, token: dashboardToken } = await setupAccountWithDashboardToken(prisma, { platform: 'MT5' });
    await seedOpenGoldPosition(mt5Account.id, '999003');

    const first = await request(app, {
      method: 'POST', url: '/research/gold-execution-status/close-position',
      headers: { authorization: `Bearer ${dashboardToken}` },
      payload: { positionId: '999003', confirm: true },
    });
    const second = await request(app, {
      method: 'POST', url: '/research/gold-execution-status/close-position',
      headers: { authorization: `Bearer ${dashboardToken}` },
      payload: { positionId: '999003', confirm: true },
    });

    expect(second.body.duplicate).toBe(true);
    expect(second.body.requestId).toBe(first.body.requestId);

    // Scoped by accountId too — this test DB is shared across concurrently-running
    // test FILES (vitest's default parallelism), and gold-dashboard/controls'
    // pre-existing "oldest MT5 TradingAccount" resolution pattern (not something
    // this task changed) means an unrelated file's own MT5 account can otherwise
    // leak into a bare positionTicket-only query here.
    const rows = await prisma.goldCloseRequest.findMany({ where: { positionTicket: '999003', accountId: mt5Account.id } });
    expect(rows).toHaveLength(1);
  });

  it('rejects a close request for a ticket that is not an open gold position (scoping)', async () => {
    const { account: mt5Account, token: dashboardToken } = await setupAccountWithDashboardToken(prisma, { platform: 'MT5' });

    const res = await request(app, {
      method: 'POST', url: '/research/gold-execution-status/close-position',
      headers: { authorization: `Bearer ${dashboardToken}` },
      payload: { positionId: 'does-not-exist', confirm: true },
    });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/no open gold position/i);
  });

  it('rejects a close request for a EURUSD position — gold-scoped only', async () => {
    const { account: mt5Account, token: dashboardToken } = await setupAccountWithDashboardToken(prisma, { platform: 'MT5' });
    await prisma.position.create({
      data: {
        accountId: mt5Account.id, platform: 'MT5', externalPositionId: 'eur-1', symbol: 'EURUSD',
        side: 'BUY', volume: 0.1, openPrice: 1.08, profit: 0, swap: 0, status: 'OPEN', openedAt: new Date(),
      },
    });

    const res = await request(app, {
      method: 'POST', url: '/research/gold-execution-status/close-position',
      headers: { authorization: `Bearer ${dashboardToken}` },
      payload: { positionId: 'eur-1', confirm: true },
    });
    expect(res.body.ok).toBe(false);
  });
});
