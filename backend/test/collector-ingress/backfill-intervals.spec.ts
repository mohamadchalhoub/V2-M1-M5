// Gold historical-collection phase — POST/GET /collector/backfill-intervals.
// No accountId, same posture as ticks.spec.ts/candles.spec.ts.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { setupAccountWithToken } from '../helpers/factories';
import { request } from '../helpers/http';

function intervalPayload(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'XAUUSD',
    dataType: 'CANDLE',
    timeframe: 'H1',
    rangeStart: '2026-01-01T00:00:00.000Z',
    rangeEnd: '2026-01-02T00:00:00.000Z',
    status: 'PENDING',
    ...overrides,
  };
}

describe('backfill interval ledger (/collector/backfill-intervals)', () => {
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

  it('creates a PENDING interval with no completedAt', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const res = await request(app, {
      method: 'POST',
      url: '/collector/backfill-intervals',
      headers: { authorization: `Bearer ${token}` },
      payload: intervalPayload(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ symbol: 'XAUUSD', dataType: 'CANDLE', status: 'PENDING' });
    expect(res.body.completedAt).toBeNull();
  });

  it('upserting the SAME (source, symbol, dataType, timeframe, range) transitions PENDING -> COMPLETED and sets completedAt', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const pending = await request(app, {
      method: 'POST',
      url: '/collector/backfill-intervals',
      headers: { authorization: `Bearer ${token}` },
      payload: intervalPayload({ status: 'PENDING' }),
    });
    expect(pending.body.status).toBe('PENDING');
    expect(pending.body.completedAt).toBeNull();

    const completed = await request(app, {
      method: 'POST',
      url: '/collector/backfill-intervals',
      headers: { authorization: `Bearer ${token}` },
      payload: intervalPayload({ status: 'COMPLETED', recordCount: 24 }),
    });
    expect(completed.statusCode).toBe(201);
    expect(completed.body.status).toBe('COMPLETED');
    expect(completed.body.recordCount).toBe(24);
    expect(completed.body.completedAt).not.toBeNull();
    expect(completed.body.id).toBe(pending.body.id); // same row, upserted not duplicated

    const rows = await prisma.backfillInterval.findMany();
    expect(rows).toHaveLength(1);
  });

  it('EMPTY_CONFIRMED also sets completedAt (the other terminal-success status)', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const res = await request(app, {
      method: 'POST',
      url: '/collector/backfill-intervals',
      headers: { authorization: `Bearer ${token}` },
      payload: intervalPayload({ status: 'EMPTY_CONFIRMED' }),
    });
    expect(res.body.completedAt).not.toBeNull();
  });

  it('FAILED does NOT set completedAt', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const res = await request(app, {
      method: 'POST',
      url: '/collector/backfill-intervals',
      headers: { authorization: `Bearer ${token}` },
      payload: intervalPayload({ status: 'FAILED', evidence: 'MT5 error 42' }),
    });
    expect(res.body.completedAt).toBeNull();
  });

  it('a TICK-type interval omits timeframe and internally keys on the "_TICK_" companion, distinct from any CANDLE interval on the same range', async () => {
    const { token } = await setupAccountWithToken(prisma);
    await request(app, {
      method: 'POST',
      url: '/collector/backfill-intervals',
      headers: { authorization: `Bearer ${token}` },
      payload: { symbol: 'XAUUSD', dataType: 'TICK', rangeStart: '2026-01-01T00:00:00.000Z', rangeEnd: '2026-01-02T00:00:00.000Z', status: 'PENDING' },
    });
    await request(app, {
      method: 'POST',
      url: '/collector/backfill-intervals',
      headers: { authorization: `Bearer ${token}` },
      payload: intervalPayload({ status: 'PENDING' }), // same range, CANDLE/H1
    });

    const rows = await prisma.backfillInterval.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.dataType === 'TICK')?.timeframe).toBeNull();
    expect(rows.find((r) => r.dataType === 'TICK')?.timeframeKey).toBe('_TICK_');
  });

  it('rejects an invalid status', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const res = await request(app, {
      method: 'POST',
      url: '/collector/backfill-intervals',
      headers: { authorization: `Bearer ${token}` },
      payload: intervalPayload({ status: 'NOT_A_REAL_STATUS' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an invalid dataType', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const res = await request(app, {
      method: 'POST',
      url: '/collector/backfill-intervals',
      headers: { authorization: `Bearer ${token}` },
      payload: intervalPayload({ dataType: 'BOGUS' }),
    });
    expect(res.statusCode).toBe(400);
  });

  describe('GET /collector/backfill-intervals', () => {
    it('lists intervals ordered by rangeStart ascending, filterable by comma-separated status', async () => {
      const { token } = await setupAccountWithToken(prisma);
      await request(app, {
        method: 'POST',
        url: '/collector/backfill-intervals',
        headers: { authorization: `Bearer ${token}` },
        payload: intervalPayload({ rangeStart: '2026-01-02T00:00:00.000Z', rangeEnd: '2026-01-03T00:00:00.000Z', status: 'COMPLETED' }),
      });
      await request(app, {
        method: 'POST',
        url: '/collector/backfill-intervals',
        headers: { authorization: `Bearer ${token}` },
        payload: intervalPayload({ rangeStart: '2026-01-01T00:00:00.000Z', rangeEnd: '2026-01-02T00:00:00.000Z', status: 'FAILED' }),
      });

      const all = await request(app, {
        method: 'GET',
        url: '/collector/backfill-intervals?symbol=XAUUSD&dataType=CANDLE&timeframe=H1',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(all.statusCode).toBe(200);
      expect(all.body).toHaveLength(2);
      expect(all.body[0].rangeStart).toBe('2026-01-01T00:00:00.000Z'); // ascending

      const filtered = await request(app, {
        method: 'GET',
        url: '/collector/backfill-intervals?symbol=XAUUSD&dataType=CANDLE&timeframe=H1&status=COMPLETED,EMPTY_CONFIRMED',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(filtered.body).toHaveLength(1);
      expect(filtered.body[0].status).toBe('COMPLETED');
    });

    it('rejects a missing dataType', async () => {
      const { token } = await setupAccountWithToken(prisma);
      const res = await request(app, {
        method: 'GET',
        url: '/collector/backfill-intervals?symbol=XAUUSD',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
