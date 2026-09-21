// trend-breakout strategy (v3) base fields, extended in the gold
// historical-collection phase with optional instrument-verification
// fields. POST /collector/symbol-metadata — no accountId, same posture as
// candles/ticks in this directory.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { setupAccountWithToken } from '../helpers/factories';
import { request } from '../helpers/http';

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'XAUUSD',
    volumeMin: 0.01,
    volumeMax: 100,
    volumeStep: 0.01,
    digits: 2,
    point: 0.01,
    contractSize: 100,
    profitCurrency: 'USD',
    ...overrides,
  };
}

describe('symbol metadata ingestion (/collector/symbol-metadata)', () => {
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

  it('still accepts the original, pre-existing payload shape with none of the new fields (backward compatible)', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const res = await request(app, {
      method: 'POST',
      url: '/collector/symbol-metadata',
      headers: { authorization: `Bearer ${token}` },
      payload: basePayload(),
    });
    expect(res.statusCode).toBe(201);

    const row = await prisma.symbolMetadata.findUniqueOrThrow({ where: { symbol: 'XAUUSD' } });
    expect(Number(row.volumeMin)).toBe(0.01);
    expect(row.brokerSymbol).toBeNull();
    expect(row.tradeTickSize).toBeNull();
  });

  it('persists the new gold-collection instrument-verification fields when sent', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const res = await request(app, {
      method: 'POST',
      url: '/collector/symbol-metadata',
      headers: { authorization: `Bearer ${token}` },
      payload: basePayload({
        brokerSymbol: 'XAUUSD.a',
        server: 'MetaQuotes-Demo',
        path: 'Metals\\XAUUSD',
        currencyBase: 'XAU',
        currencyProfit: 'USD',
        currencyMargin: 'USD',
        tradeTickSize: 0.01,
        tradeTickValue: 1,
        tradeStopsLevel: 50,
        tradeFreezeLevel: 10,
        tradeMode: 4,
        swapMode: 1,
        swapLong: -7.5,
        swapShort: 2.5,
        swapRollover3Days: 3,
        expirationMode: 0,
        expirationTime: '2026-12-31T00:00:00.000Z',
      }),
    });
    expect(res.statusCode).toBe(201);

    const row = await prisma.symbolMetadata.findUniqueOrThrow({ where: { symbol: 'XAUUSD' } });
    expect(row.brokerSymbol).toBe('XAUUSD.a');
    expect(row.server).toBe('MetaQuotes-Demo');
    expect(row.path).toBe('Metals\\XAUUSD');
    expect(row.currencyBase).toBe('XAU');
    expect(Number(row.tradeTickSize)).toBe(0.01);
    expect(row.tradeStopsLevel).toBe(50);
    expect(Number(row.swapLong)).toBe(-7.5);
    expect(row.expirationTime?.toISOString()).toBe('2026-12-31T00:00:00.000Z');
  });

  it('upserting the same symbol again updates in place — one row, not two', async () => {
    const { token } = await setupAccountWithToken(prisma);
    await request(app, {
      method: 'POST',
      url: '/collector/symbol-metadata',
      headers: { authorization: `Bearer ${token}` },
      payload: basePayload(),
    });
    await request(app, {
      method: 'POST',
      url: '/collector/symbol-metadata',
      headers: { authorization: `Bearer ${token}` },
      payload: basePayload({ brokerSymbol: 'XAUUSD.a' }),
    });

    const rows = await prisma.symbolMetadata.findMany({ where: { symbol: 'XAUUSD' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].brokerSymbol).toBe('XAUUSD.a');
  });
});
