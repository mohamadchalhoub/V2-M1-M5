/**
 * The migration's central safety claim, tested rather than asserted in prose:
 * **no retired strategy can submit an entry any more.**
 *
 * This replaces the entry-path halves of
 * `test/autonomous/autonomous-execution-e2e.spec.ts` and
 * `test/gold-execution/gold-execution-e2e.spec.ts`, which tested exactly the
 * routes this migration disabled. Those files' remaining, still-relevant
 * coverage (close requests, protection restore) stays where it is.
 *
 * The checks here are deliberately adversarial: each one first plants a
 * ready-to-send PENDING row of the retired strategy's own shape, then proves
 * that polling cannot get it out.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { setupAccountWithToken } from '../helpers/factories';
import { request } from '../helpers/http';

describe('Retired strategies cannot submit entries', () => {
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

  it('the legacy EURUSD autonomous entry route no longer exists', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const accountId = account.id;

    // A perfectly valid, ready-to-send legacy order.
    await prisma.autonomousDecision.create({
      data: {
        accountId,
        symbol: 'EURUSD',
        action: 'OPEN_BUY',
        source: 'RULES_ONLY',
        entryPrice: 1.1,
        stopLoss: 1.09,
        takeProfit: 1.11,
        reasoning: 'planted by a regression test',
        inputSnapshot: {},
        riskManagerApproved: true,
        orderStatus: 'PENDING',
      },
    });

    const res = await request(app, {
      method: 'GET',
      url: `/collector/${accountId}/autonomous/pending-order`,
      headers: { authorization: `Bearer ${token}` },
    });

    // The whole module is unregistered, so the route is simply not there.
    expect(res.statusCode).toBe(404);

    // And crucially, the row was not claimed by anything.
    const after = await prisma.autonomousDecision.findFirst({ where: { accountId } });
    expect(after?.orderStatus).toBe('PENDING');
  });

  it('the retired H4 gold entry route returns no order even with a ready PENDING row', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const accountId = account.id;

    await prisma.autonomousDecision.create({
      data: {
        accountId,
        symbol: 'XAUUSD',
        action: 'OPEN_SELL',
        source: 'RULES_ONLY',
        entryPrice: 2650,
        stopLoss: 2660,
        takeProfit: 2640,
        volumeLots: 0.01,
        reasoning: 'planted by a regression test',
        inputSnapshot: { signal: { touchEndT: Date.now() } },
        riskManagerApproved: true,
        orderStatus: 'PENDING',
      },
    });

    const res = await request(app, {
      method: 'GET',
      url: `/collector/${accountId}/gold-execution/pending-order`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ order: null });

    // The route must not even CLAIM the row — a claim would flip it to SENT
    // and lose the ability to distinguish "never sent" from "sent, outcome
    // unknown" during migration reconciliation.
    const after = await prisma.autonomousDecision.findFirst({ where: { accountId, symbol: 'XAUUSD' } });
    expect(after?.orderStatus).toBe('PENDING');
  });

  it('the trend-breakout entry routes no longer exist', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const accountId = account.id;

    for (const instrument of ['EURUSD', 'XAUUSD']) {
      const res = await request(app, {
        method: 'GET',
        url: `/collector/${accountId}/trend-breakout/${instrument}/pending-order`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('the active strategy has its own route, and it is reachable', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const accountId = account.id;

    const res = await request(app, {
      method: 'GET',
      url: `/collector/${accountId}/xauusd-rsi/pending-order`,
      headers: { authorization: `Bearer ${token}` },
    });

    // Reachable and correctly reporting nothing queued — not 404.
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ order: null });
  });

  it('a retired strategy’s XAUUSD row is never served through the ACTIVE route either', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const accountId = account.id;

    // The old strategy's rows live in a different table entirely, so this is
    // structurally impossible — asserted so a future refactor that merges the
    // tables cannot quietly reintroduce the risk.
    await prisma.autonomousDecision.create({
      data: {
        accountId,
        symbol: 'XAUUSD',
        action: 'OPEN_BUY',
        source: 'RULES_ONLY',
        entryPrice: 2650,
        stopLoss: 2640,
        takeProfit: 2660,
        volumeLots: 0.01,
        reasoning: 'planted by a regression test',
        inputSnapshot: {},
        riskManagerApproved: true,
        orderStatus: 'PENDING',
      },
    });

    const res = await request(app, {
      method: 'GET',
      url: `/collector/${accountId}/xauusd-rsi/pending-order`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.body).toEqual({ order: null });
  });
});
