// Historical chart reconstruction phase — POST/GET /collector/candles*.
// Candles carry no accountId (schema.prisma's HistoricalCandle: symbol/
// timeframe data, shared across every account) — any valid, unrevoked
// collector-scope token is accepted, same as every other /collector/* route
// but without the account-match check (CollectorTokenGuard's own contract).
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { setupAccountWithToken } from '../helpers/factories';
import { request } from '../helpers/http';

function candlesPayload(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'EURUSD',
    timeframe: 'M5',
    candles: [
      { openTime: '2026-01-01T00:00:00.000Z', open: 1.1, high: 1.101, low: 1.099, close: 1.1005, volume: 120 },
      { openTime: '2026-01-01T00:05:00.000Z', open: 1.1005, high: 1.102, low: 1.1, close: 1.1015 },
    ],
    ...overrides,
  };
}

describe('historical candle ingestion (/collector/candles)', () => {
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

  it('accepts a valid push and persists every candle', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const res = await request(app, {
      method: 'POST',
      url: '/collector/candles',
      headers: { authorization: `Bearer ${token}` },
      payload: candlesPayload(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ ok: true, upserted: 2 });

    const rows = await prisma.historicalCandle.findMany({ orderBy: { openTime: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ symbol: 'EURUSD', timeframe: 'M5', source: 'MT5' });
    expect(Number(rows[0].open)).toBe(1.1);
    expect(Number(rows[0].volume)).toBe(120);
    expect(rows[1].volume).toBeNull(); // optional field omitted
  });

  it('is idempotent — re-pushing the same (symbol, timeframe, openTime) heals rather than duplicates', async () => {
    const { token } = await setupAccountWithToken(prisma);
    await request(app, {
      method: 'POST',
      url: '/collector/candles',
      headers: { authorization: `Bearer ${token}` },
      payload: candlesPayload(),
    });
    // Re-push the first candle with a corrected high (as if it was still forming on the previous tick).
    await request(app, {
      method: 'POST',
      url: '/collector/candles',
      headers: { authorization: `Bearer ${token}` },
      payload: candlesPayload({
        candles: [{ openTime: '2026-01-01T00:00:00.000Z', open: 1.1, high: 1.105, low: 1.099, close: 1.1005 }],
      }),
    });

    const rows = await prisma.historicalCandle.findMany({ where: { symbol: 'EURUSD', timeframe: 'M5' } });
    expect(rows).toHaveLength(2); // still 2, not 3
    const healed = rows.find((r) => r.openTime.toISOString() === '2026-01-01T00:00:00.000Z');
    expect(Number(healed?.high)).toBe(1.105);
  });

  it('rejects an invalid timeframe', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const res = await request(app, {
      method: 'POST',
      url: '/collector/candles',
      headers: { authorization: `Bearer ${token}` },
      payload: candlesPayload({ timeframe: 'W2' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it.each(['M30', 'H4', 'D1', 'W1', 'MN1', 'M1'] as const)(
    'accepts %s — M1 is the gold historical-collection phase\'s finest-granularity addition, the rest are the earlier technical-analysis timeframes',
    async (timeframe) => {
      const { token } = await setupAccountWithToken(prisma);
      const res = await request(app, {
        method: 'POST',
        url: '/collector/candles',
        headers: { authorization: `Bearer ${token}` },
        payload: candlesPayload({ timeframe }),
      });
      expect(res.statusCode).toBe(201);
    },
  );

  it('rejects an empty candles array', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const res = await request(app, {
      method: 'POST',
      url: '/collector/candles',
      headers: { authorization: `Bearer ${token}` },
      payload: candlesPayload({ candles: [] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts any valid collector token, not just one bound to a specific account', async () => {
    const first = await setupAccountWithToken(prisma);
    const second = await setupAccountWithToken(prisma);

    for (const { token } of [first, second]) {
      const res = await request(app, {
        method: 'POST',
        url: '/collector/candles',
        headers: { authorization: `Bearer ${token}` },
        payload: candlesPayload({ symbol: 'GBPUSD' }),
      });
      expect(res.statusCode).toBe(201);
    }
  });

  it('rejects a request with no bearer token at all', async () => {
    const res = await request(app, { method: 'POST', url: '/collector/candles', payload: candlesPayload() });
    expect(res.statusCode).toBe(401);
  });

  describe('GET /collector/candles/latest', () => {
    it('returns null when nothing has been ingested for that symbol/timeframe', async () => {
      const { token } = await setupAccountWithToken(prisma);
      const res = await request(app, {
        method: 'GET',
        url: '/collector/candles/latest?symbol=EURUSD&timeframe=M5',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ latestOpenTime: null });
    });

    it('returns the latest openTime after ingestion, scoped by symbol AND timeframe', async () => {
      const { token } = await setupAccountWithToken(prisma);
      await request(app, {
        method: 'POST',
        url: '/collector/candles',
        headers: { authorization: `Bearer ${token}` },
        payload: candlesPayload(),
      });
      await request(app, {
        method: 'POST',
        url: '/collector/candles',
        headers: { authorization: `Bearer ${token}` },
        payload: candlesPayload({
          timeframe: 'H1',
          candles: [{ openTime: '2026-01-01T05:00:00.000Z', open: 1.1, high: 1.1, low: 1.1, close: 1.1 }],
        }),
      });

      const m5 = await request(app, {
        method: 'GET',
        url: '/collector/candles/latest?symbol=EURUSD&timeframe=M5',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(m5.body.latestOpenTime).toBe('2026-01-01T00:05:00.000Z');

      const h1 = await request(app, {
        method: 'GET',
        url: '/collector/candles/latest?symbol=EURUSD&timeframe=H1',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(h1.body.latestOpenTime).toBe('2026-01-01T05:00:00.000Z');
    });

    it('rejects a missing/invalid timeframe query param', async () => {
      const { token } = await setupAccountWithToken(prisma);
      const res = await request(app, {
        method: 'GET',
        url: '/collector/candles/latest?symbol=EURUSD&timeframe=nope',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
