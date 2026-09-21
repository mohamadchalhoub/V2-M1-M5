// Phase 4 review item: "whether a rule failure can ever break MT5
// ingestion." CollectorIngressController wraps RuleEngineService.evaluateAccount
// in try/catch (evaluateRulesSafely) specifically so a bug in a trader's rule
// configuration can never stop their trading data from being recorded. This
// proves it with a RuleEngineService replaced by one that always throws.
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { RuleEngineService } from '../../src/alerts/rule-engine.service';
import { resetDatabase } from '../helpers/db';
import { setupAccountWithToken, validDealPayload, validSnapshotPayload } from '../helpers/factories';
import { request } from '../helpers/http';

describe('rule engine failure isolation from ingestion', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RuleEngineService)
      .useValue({
        evaluateAccount: async () => {
          throw new Error('simulated rule engine failure');
        },
      })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = new PrismaClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('a throwing RuleEngineService never fails snapshot ingestion — the snapshot is still persisted and 201 is still returned', async () => {
    const { account, token } = await setupAccountWithToken(prisma);

    const res = await request(app, {
      method: 'POST',
      url: '/collector/snapshot',
      headers: { authorization: `Bearer ${token}` },
      payload: validSnapshotPayload(account.id, { balance: 7_500, equity: 7_500 }),
    });

    expect(res.statusCode).toBe(201);
    const rows = await prisma.accountSnapshot.findMany({ where: { accountId: account.id } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].balance)).toBe(7_500);
  });

  it('a throwing RuleEngineService never fails trade ingestion — the trade is still persisted and 201 is still returned', async () => {
    const { account, token } = await setupAccountWithToken(prisma);

    const res = await request(app, {
      method: 'POST',
      url: '/collector/trades',
      headers: { authorization: `Bearer ${token}` },
      payload: { accountId: account.id, deals: [validDealPayload({ externalTradeId: 'RESILIENCE-1' })] },
    });

    expect(res.statusCode).toBe(201);
    const rows = await prisma.trade.findMany({ where: { accountId: account.id } });
    expect(rows).toHaveLength(1);
  });

  it('an alert-layer failure can never corrupt or roll back already-committed trading data', async () => {
    const { account, token } = await setupAccountWithToken(prisma);

    // Positions/heartbeat are part of the same snapshot push — confirm ALL
    // of it survives a rule engine that fails on every call.
    await request(app, {
      method: 'POST',
      url: '/collector/snapshot',
      headers: { authorization: `Bearer ${token}` },
      payload: validSnapshotPayload(account.id, {
        positions: [{ externalPositionId: 'P1', symbol: 'EURUSD', side: 'BUY', volume: 0.1, openPrice: 1.1, profit: 0, swap: 0, openedAt: new Date().toISOString() }],
      }),
    });

    expect(await prisma.position.count({ where: { accountId: account.id } })).toBe(1);
    expect(await prisma.collectorHeartbeat.count({ where: { accountId: account.id } })).toBe(1);
  });
});
