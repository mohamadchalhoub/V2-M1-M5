// Gold historical-collection phase — POST/GET /collector/ticks*. No
// accountId (schema.prisma's HistoricalTick: symbol-level market data,
// shared across every account), same posture as candles.spec.ts's own
// tests for /collector/candles.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { setupAccountWithToken } from '../helpers/factories';
import { request } from '../helpers/http';

function ticksPayload(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'XAUUSD',
    brokerSymbol: 'XAUUSD.a',
    server: 'MetaQuotes-Demo',
    ticks: [
      { timestamp: '2026-01-01T00:00:00.000Z', bid: 2400.1, ask: 2400.3, flags: 6, batchSeq: 0 },
      { timestamp: '2026-01-01T00:00:01.000Z', bid: 2400.2, ask: 2400.4, flags: 6, batchSeq: 1 },
    ],
    ...overrides,
  };
}

describe('historical tick ingestion (/collector/ticks)', () => {
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

  it('accepts a valid push and persists every tick', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const res = await request(app, {
      method: 'POST',
      url: '/collector/ticks',
      headers: { authorization: `Bearer ${token}` },
      payload: ticksPayload(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ ok: true, inserted: 2 });

    const rows = await prisma.historicalTick.findMany({ orderBy: { timestamp: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ symbol: 'XAUUSD', brokerSymbol: 'XAUUSD.a', server: 'MetaQuotes-Demo', flags: 6 });
    expect(Number(rows[0].bid)).toBe(2400.1);
  });

  it('deduplicates two identical rows within the SAME payload — 1 inserted, not 2', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const res = await request(app, {
      method: 'POST',
      url: '/collector/ticks',
      headers: { authorization: `Bearer ${token}` },
      payload: ticksPayload({
        ticks: [
          { timestamp: '2026-01-01T00:00:00.000Z', bid: 2400.1, ask: 2400.3, flags: 6, batchSeq: 0 },
          // Identical in every identity-bearing field; only batchSeq differs
          // (batchSeq is explicitly NOT part of identity — see the schema
          // comment on HistoricalTick).
          { timestamp: '2026-01-01T00:00:00.000Z', bid: 2400.1, ask: 2400.3, flags: 6, batchSeq: 1 },
        ],
      }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ ok: true, inserted: 1 });

    const rows = await prisma.historicalTick.findMany();
    expect(rows).toHaveLength(1);
  });

  it('is idempotent across calls — re-posting the exact same payload inserts 0 the second time, no DB error', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const payload = ticksPayload();

    const first = await request(app, {
      method: 'POST',
      url: '/collector/ticks',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.body.inserted).toBe(2);

    const second = await request(app, {
      method: 'POST',
      url: '/collector/ticks',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(second.statusCode).toBe(201);
    expect(second.body.inserted).toBe(0);

    const rows = await prisma.historicalTick.findMany();
    expect(rows).toHaveLength(2);
  });

  it('treats a null vs. a present optional field (last/volume/volumeReal) as genuinely distinct identity', async () => {
    const { token } = await setupAccountWithToken(prisma);
    await request(app, {
      method: 'POST',
      url: '/collector/ticks',
      headers: { authorization: `Bearer ${token}` },
      payload: ticksPayload({
        ticks: [{ timestamp: '2026-01-01T00:00:00.000Z', bid: 2400.1, ask: 2400.3, flags: 6, batchSeq: 0 }],
      }),
    });
    const res = await request(app, {
      method: 'POST',
      url: '/collector/ticks',
      headers: { authorization: `Bearer ${token}` },
      payload: ticksPayload({
        ticks: [{ timestamp: '2026-01-01T00:00:00.000Z', bid: 2400.1, ask: 2400.3, last: 2400.2, flags: 6, batchSeq: 0 }],
      }),
    });
    expect(res.body.inserted).toBe(1); // genuinely a different tick — `last` is present this time

    const rows = await prisma.historicalTick.findMany();
    expect(rows).toHaveLength(2);
  });

  it('rejects an empty ticks array', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const res = await request(app, {
      method: 'POST',
      url: '/collector/ticks',
      headers: { authorization: `Bearer ${token}` },
      payload: ticksPayload({ ticks: [] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a request with no bearer token at all', async () => {
    const res = await request(app, { method: 'POST', url: '/collector/ticks', payload: ticksPayload() });
    expect(res.statusCode).toBe(401);
  });

  describe('GET /collector/ticks/coverage', () => {
    it('returns zero/null coverage when nothing has been ingested', async () => {
      const { token } = await setupAccountWithToken(prisma);
      const res = await request(app, {
        method: 'GET',
        url: '/collector/ticks/coverage?symbol=XAUUSD',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ symbol: 'XAUUSD', count: 0, earliest: null, latest: null });
    });

    it('returns count/earliest/latest after ingestion, scoped by symbol', async () => {
      const { token } = await setupAccountWithToken(prisma);
      await request(app, {
        method: 'POST',
        url: '/collector/ticks',
        headers: { authorization: `Bearer ${token}` },
        payload: ticksPayload(),
      });
      await request(app, {
        method: 'POST',
        url: '/collector/ticks',
        headers: { authorization: `Bearer ${token}` },
        payload: ticksPayload({ symbol: 'EURUSD', ticks: [{ timestamp: '2026-01-01T00:00:00.000Z', bid: 1.1, ask: 1.1002, flags: 6, batchSeq: 0 }] }),
      });

      const res = await request(app, {
        method: 'GET',
        url: '/collector/ticks/coverage?symbol=XAUUSD',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.body.count).toBe(2);
      expect(res.body.earliest).toBe('2026-01-01T00:00:00.000Z');
      expect(res.body.latest).toBe('2026-01-01T00:00:01.000Z');
    });

    it('rejects a missing symbol query param', async () => {
      const { token } = await setupAccountWithToken(prisma);
      const res = await request(app, {
        method: 'GET',
        url: '/collector/ticks/coverage',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
