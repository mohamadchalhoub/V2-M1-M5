import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { createCollectorToken, setupAccountWithDashboardToken, validSnapshotPayload } from '../helpers/factories';
import { request } from '../helpers/http';
import { GOLD_MAGIC_NUMBER } from '../../src/gold-execution/gold-safety-constants';

/**
 * Task item 3, corrected a second time — the agreed policy is exactly ONE
 * restoration attempt, THEN reconciliation against actual broker data on
 * the next snapshot, THEN close if still unprotected. End-to-end over the
 * real HTTP layer, with SIMULATED broker responses (exactly the shape
 * runner.py sends for real) standing in for the executor's actual
 * modify_protection/order_send result. No real MT5/collector process is
 * involved and no broker trade is forced.
 */
describe('Gold protection: one restore attempt -> reconciliation -> close if still unprotected', () => {
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

  function ownGoldPosition(ticket: string, overrides: Record<string, unknown> = {}) {
    return {
      externalPositionId: ticket,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: 0.01,
      openPrice: 2650,
      profit: 0,
      swap: 0,
      openedAt: new Date().toISOString(),
      raw: { magic: GOLD_MAGIC_NUMBER },
      ...overrides,
    };
  }

  async function seedPositionRow(accountId: string, ticket: string, overrides: Record<string, unknown> = {}) {
    await prisma.position.create({
      data: {
        accountId, platform: 'MT5', externalPositionId: ticket, symbol: 'XAUUSD',
        side: 'BUY', volume: 0.01, openPrice: 2650, profit: 0, swap: 0, status: 'OPEN', openedAt: new Date(),
        ...overrides,
      },
    });
  }

  it('single-attempt-succeeds: snapshot -> restore queued -> collector claims -> reports ok -> NEXT snapshot shows real protection -> RESTORED, never closes', async () => {
    const { account: mt5Account, token: dashboardToken } = await setupAccountWithDashboardToken(prisma, { platform: 'MT5' });
    const { plaintext: collectorToken } = await createCollectorToken(prisma, mt5Account.id);

    // Cycle 1: unprotected -> queues exactly one restore request.
    await request(app, {
      method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${collectorToken}` },
      payload: validSnapshotPayload(mt5Account.id, { positions: [ownGoldPosition('771001')] }), // no stopLoss/takeProfit
    });
    const restoreRows = await prisma.goldProtectionRestoreRequest.findMany({ where: { positionTicket: '771001' } });
    expect(restoreRows).toHaveLength(1);
    expect(restoreRows[0].maxAttempts).toBe(1);

    // Collector claims and reports a SIMULATED broker success for the modify attempt.
    const pollRes = await request(app, {
      method: 'GET', url: `/collector/${mt5Account.id}/gold-execution/restore-protection-request`,
      headers: { authorization: `Bearer ${collectorToken}` },
    });
    expect(pollRes.body.request.attemptNumber).toBe(1);
    await request(app, {
      method: 'POST', url: `/collector/${mt5Account.id}/gold-execution/restore-protection-request/${restoreRows[0].id}/result`,
      headers: { authorization: `Bearer ${collectorToken}` },
      payload: { ok: true },
    });

    // The modify response ALONE does not resolve the incident — no close request yet, no second restore.
    let closeRows = await prisma.goldCloseRequest.findMany({ where: { positionTicket: '771001' } });
    expect(closeRows).toHaveLength(0);
    let allRestoreRows = await prisma.goldProtectionRestoreRequest.findMany({ where: { positionTicket: '771001' } });
    expect(allRestoreRows).toHaveLength(1); // still just one attempt, ever

    // Cycle 2 (reconciliation): the NEXT real snapshot shows actual protection now attached.
    await request(app, {
      method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${collectorToken}` },
      payload: validSnapshotPayload(mt5Account.id, { positions: [ownGoldPosition('771001', { stopLoss: 2640, takeProfit: 2660 })] }),
    });

    closeRows = await prisma.goldCloseRequest.findMany({ where: { positionTicket: '771001' } });
    expect(closeRows).toHaveLength(0); // never closes
    allRestoreRows = await prisma.goldProtectionRestoreRequest.findMany({ where: { positionTicket: '771001' } });
    expect(allRestoreRows).toHaveLength(1); // no second attempt was ever queued
  });

  it('single-attempt-fails-then-reconciliation-confirms-unprotected-so-closes: reconciliation (not the failed response itself) triggers exactly one close, no retry', async () => {
    const { account: mt5Account, token: dashboardToken } = await setupAccountWithDashboardToken(prisma, { platform: 'MT5' });
    const { plaintext: collectorToken } = await createCollectorToken(prisma, mt5Account.id);

    await request(app, {
      method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${collectorToken}` },
      payload: validSnapshotPayload(mt5Account.id, { positions: [ownGoldPosition('771002')] }),
    });
    const restoreRow = await prisma.goldProtectionRestoreRequest.findFirst({ where: { positionTicket: '771002' } });

    await request(app, {
      method: 'GET', url: `/collector/${mt5Account.id}/gold-execution/restore-protection-request`,
      headers: { authorization: `Bearer ${collectorToken}` },
    });
    // SIMULATED broker failure on the one attempt.
    await request(app, {
      method: 'POST', url: `/collector/${mt5Account.id}/gold-execution/restore-protection-request/${restoreRow!.id}/result`,
      headers: { authorization: `Bearer ${collectorToken}` },
      payload: { ok: false, errorMessage: 'simulated broker rejection: invalid stops' },
    });

    // The failed response alone still does not queue a close or a second attempt.
    let closeRows = await prisma.goldCloseRequest.findMany({ where: { positionTicket: '771002' } });
    expect(closeRows).toHaveLength(0);

    // Cycle 2 (reconciliation): next real snapshot STILL shows unprotected.
    await request(app, {
      method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${collectorToken}` },
      payload: validSnapshotPayload(mt5Account.id, { positions: [ownGoldPosition('771002')] }), // still no stopLoss/takeProfit
    });

    closeRows = await prisma.goldCloseRequest.findMany({ where: { positionTicket: '771002' } });
    expect(closeRows).toHaveLength(1);
    expect(closeRows[0].status).toBe('PENDING');

    const allRestoreRows = await prisma.goldProtectionRestoreRequest.findMany({ where: { positionTicket: '771002' } });
    expect(allRestoreRows).toHaveLength(1); // no retry was ever queued — exactly one attempt, ever
  });

  it('ambiguous-response-triggers-reconciliation-not-blind-retry: an ok:true response that reconciliation later contradicts still closes — the modify response is never trusted over real data', async () => {
    const { account: mt5Account, token: dashboardToken } = await setupAccountWithDashboardToken(prisma, { platform: 'MT5' });
    const { plaintext: collectorToken } = await createCollectorToken(prisma, mt5Account.id);

    await request(app, {
      method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${collectorToken}` },
      payload: validSnapshotPayload(mt5Account.id, { positions: [ownGoldPosition('771003')] }),
    });
    const restoreRow = await prisma.goldProtectionRestoreRequest.findFirst({ where: { positionTicket: '771003' } });

    await request(app, {
      method: 'GET', url: `/collector/${mt5Account.id}/gold-execution/restore-protection-request`,
      headers: { authorization: `Bearer ${collectorToken}` },
    });
    // The collector reports SUCCESS (an "ambiguous" case: order_send acknowledged, but reality later disagrees).
    await request(app, {
      method: 'POST', url: `/collector/${mt5Account.id}/gold-execution/restore-protection-request/${restoreRow!.id}/result`,
      headers: { authorization: `Bearer ${collectorToken}` },
      payload: { ok: true },
    });

    // Cycle 2 (reconciliation): the broker's ACTUAL position data still shows no stops attached —
    // this must still close, proving the close decision never trusted the ok:true response.
    await request(app, {
      method: 'POST', url: '/collector/snapshot', headers: { authorization: `Bearer ${collectorToken}` },
      payload: validSnapshotPayload(mt5Account.id, { positions: [ownGoldPosition('771003')] }),
    });

    const closeRows = await prisma.goldCloseRequest.findMany({ where: { positionTicket: '771003' } });
    expect(closeRows).toHaveLength(1);
    const allRestoreRows = await prisma.goldProtectionRestoreRequest.findMany({ where: { positionTicket: '771003' } });
    expect(allRestoreRows).toHaveLength(1); // still no retry, even though the response said ok:true
  });
});
