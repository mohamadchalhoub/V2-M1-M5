// Gold historical-collection phase — GET /market-data/candles and
// GET /market-data/coverage: dashboard-authenticated (DashboardTokenGuard),
// account-agnostic reads of symbol-level market data. Mirrors
// dashboard-api-e2e.spec.ts's own pattern: data seeded directly via Prisma
// since these read endpoints don't care how the data got there, real
// Postgres + real HTTP layer (Fastify inject).
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { createDashboardToken, createTradingAccount, createUser } from '../helpers/factories';
import { request } from '../helpers/http';

describe('market-data dashboard read endpoints (end-to-end)', () => {
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

  async function seedDashboardToken() {
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    const { plaintext: token } = await createDashboardToken(prisma, account.id);
    return token;
  }

  describe('GET /market-data/candles', () => {
    it('excludes a still-forming candle by default, and includes it with includeForming=true', async () => {
      const token = await seedDashboardToken();
      const now = Date.now();
      // M5 duration is 5 minutes: opened 1 minute ago -> still forming.
      const formingOpenTime = new Date(now - 60_000);
      // opened 20 minutes ago -> closed 15 minutes ago, well in the past.
      const closedOpenTime = new Date(now - 20 * 60_000);

      await prisma.historicalCandle.create({
        data: { symbol: 'EURUSD', timeframe: 'M5', openTime: closedOpenTime, open: 1.1, high: 1.101, low: 1.099, close: 1.1005, volume: 10, source: 'MT5' },
      });
      await prisma.historicalCandle.create({
        data: { symbol: 'EURUSD', timeframe: 'M5', openTime: formingOpenTime, open: 1.1005, high: 1.102, low: 1.1, close: 1.1015, volume: 5, source: 'MT5' },
      });

      const from = new Date(now - 24 * 60 * 60_000).toISOString();
      const to = new Date(now + 60 * 60_000).toISOString();

      const withoutForming = await request(app, {
        method: 'GET',
        url: `/market-data/candles?symbol=EURUSD&timeframe=M5&from=${from}&to=${to}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(withoutForming.statusCode).toBe(200);
      expect(withoutForming.body.candles).toHaveLength(1);
      expect(withoutForming.body.candles[0].openTime).toBe(closedOpenTime.toISOString());
      // Same shape as frontend/src/lib/api.ts's Candle interface.
      expect(withoutForming.body.candles[0]).toEqual({
        openTime: closedOpenTime.toISOString(),
        open: 1.1,
        high: 1.101,
        low: 1.099,
        close: 1.1005,
        volume: 10,
      });

      const withForming = await request(app, {
        method: 'GET',
        url: `/market-data/candles?symbol=EURUSD&timeframe=M5&from=${from}&to=${to}&includeForming=true`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(withForming.statusCode).toBe(200);
      expect(withForming.body.candles).toHaveLength(2);
    });

    it('rejects an unsupported symbol', async () => {
      const token = await seedDashboardToken();
      const res = await request(app, {
        method: 'GET',
        url: '/market-data/candles?symbol=GBPUSD&timeframe=M5&from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an invalid timeframe', async () => {
      const token = await seedDashboardToken();
      const res = await request(app, {
        method: 'GET',
        url: '/market-data/candles?symbol=EURUSD&timeframe=M2&from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a missing from/to', async () => {
      const token = await seedDashboardToken();
      const res = await request(app, {
        method: 'GET',
        url: '/market-data/candles?symbol=EURUSD&timeframe=M5',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a span that would return significantly more than ~20,000 candles at the requested timeframe', async () => {
      const token = await seedDashboardToken();
      // M1 = 60s/candle; 20,000 candles ~= 13.9 days. Ask for ~100 days.
      const res = await request(app, {
        method: 'GET',
        url: '/market-data/candles?symbol=XAUUSD&timeframe=M1&from=2026-01-01T00:00:00.000Z&to=2026-04-11T00:00:00.000Z',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('accepts M1 end-to-end', async () => {
      const token = await seedDashboardToken();
      await prisma.historicalCandle.create({
        data: {
          symbol: 'XAUUSD',
          timeframe: 'M1',
          openTime: new Date('2026-01-01T00:00:00.000Z'),
          open: 2400,
          high: 2401,
          low: 2399,
          close: 2400.5,
          volume: null,
          source: 'MT5',
        },
      });
      const res = await request(app, {
        method: 'GET',
        url: '/market-data/candles?symbol=XAUUSD&timeframe=M1&from=2025-12-31T00:00:00.000Z&to=2026-01-02T00:00:00.000Z&includeForming=true',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.candles).toHaveLength(1);
      expect(res.body.candles[0].volume).toBeNull();
    });

    it('a request with no bearer token is rejected exactly like GET /accounts is', async () => {
      const res = await request(app, {
        method: 'GET',
        url: '/market-data/candles?symbol=EURUSD&timeframe=M5&from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /market-data/coverage', () => {
    it('combines candle/tick counts, interval status counts, and symbol-metadata presence', async () => {
      const token = await seedDashboardToken();

      await prisma.historicalCandle.createMany({
        data: [
          { symbol: 'XAUUSD', timeframe: 'H1', openTime: new Date('2026-01-01T00:00:00.000Z'), open: 2400, high: 2401, low: 2399, close: 2400.5, source: 'MT5' },
          { symbol: 'XAUUSD', timeframe: 'H1', openTime: new Date('2026-01-01T01:00:00.000Z'), open: 2400.5, high: 2402, low: 2400, close: 2401, source: 'MT5' },
        ],
      });
      await prisma.historicalTick.create({
        data: { symbol: 'XAUUSD', timestamp: new Date('2026-01-01T00:00:00.000Z'), bid: 2400.1, ask: 2400.3, flags: 6, batchSeq: 0, source: 'MT5' },
      });
      await prisma.backfillInterval.create({
        data: {
          symbol: 'XAUUSD',
          dataType: 'CANDLE',
          timeframe: 'H1',
          timeframeKey: 'H1',
          rangeStart: new Date('2026-01-01T00:00:00.000Z'),
          rangeEnd: new Date('2026-01-01T02:00:00.000Z'),
          status: 'COMPLETED',
          completedAt: new Date(),
        },
      });
      await prisma.symbolMetadata.create({
        data: { symbol: 'XAUUSD', volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, digits: 2, point: 0.01, contractSize: 100, profitCurrency: 'USD' },
      });

      const res = await request(app, {
        method: 'GET',
        url: '/market-data/coverage?symbol=XAUUSD',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.symbol).toBe('XAUUSD');

      const h1 = res.body.candles.find((c: any) => c.timeframe === 'H1');
      expect(h1.count).toBe(2);
      expect(h1.earliest).toBe('2026-01-01T00:00:00.000Z');
      expect(h1.latest).toBe('2026-01-01T01:00:00.000Z');
      expect(h1.intervalStatusCounts).toEqual({ COMPLETED: 1 });

      const m5 = res.body.candles.find((c: any) => c.timeframe === 'M5');
      expect(m5.count).toBe(0);
      expect(m5.earliest).toBeNull();

      expect(res.body.ticks).toEqual({ count: 1, earliest: '2026-01-01T00:00:00.000Z', latest: '2026-01-01T00:00:00.000Z', intervalStatusCounts: {} });
      expect(res.body.symbolMetadata.present).toBe(true);
      expect(typeof res.body.symbolMetadata.updatedAt).toBe('string');
    });

    it('reports symbolMetadata.present=false when no row exists', async () => {
      const token = await seedDashboardToken();
      const res = await request(app, {
        method: 'GET',
        url: '/market-data/coverage?symbol=EURUSD',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.body.symbolMetadata).toEqual({ present: false, updatedAt: null });
    });

    it('rejects a request with no bearer token', async () => {
      const res = await request(app, { method: 'GET', url: '/market-data/coverage?symbol=EURUSD' });
      expect(res.statusCode).toBe(401);
    });
  });
});
